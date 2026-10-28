import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
} from "electron";
import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { translateText } from "../translation/providers";
import { MouseHelper } from "./mouse-helper";
import { ocrResizeDimensions, recognizeImageFile, warmupOcr } from "./ocr";
import { SettingsStore } from "./settings";

interface ScreenshotState {
  imageUrl: string;
  width: number;
  height: number;
  scaleFactor: number;
  // file:// native captures taint the canvas (blocking toDataURL); data URLs
  // from the desktopCapturer fallback do not.
  tainted: boolean;
}

// A short settle delay after hiding a *visible* launcher so the compositor
// drops it before the screenshot is taken. Skipped entirely when the launcher
// was already hidden (the common hotkey path), which is the main latency win.
const HIDE_DELAY_MS = 80;
const DATA_URL_PREFIX = /^data:image\/[a-z.+-]+;base64,/i;
// After show(), how long to wait for the renderer to confirm it painted a frame
// before moving the overlay on-screen anyway.
const PAINT_TIMEOUT_MS = 250;
// Hotkey triggers closer together than this are keyboard auto-repeat from a
// held key. Covers the Windows repeat delay (250–1000ms, default ~500ms).
const HOTKEY_REPEAT_GAP_MS = 1_100;

/** A position to the right of every display, so a shown window is not visible. */
function offscreenOrigin(): { x: number; y: number } {
  const displays = screen.getAllDisplays();
  const right = Math.max(...displays.map((item) => item.bounds.x + item.bounds.width));
  const top = Math.min(...displays.map((item) => item.bounds.y));
  return { x: right + 200, y: top };
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const TIMING_LOG_MAX_BYTES = 256 * 1024;

/**
 * Per-capture stage timings, appended as one line to
 * `<userData>/logs/screenshot-timing.log` to diagnose slow opens (e.g. after
 * the app has been idle and Windows paged it out).
 */
class CaptureTiming {
  private readonly start = performance.now();
  private last = this.start;
  private readonly stages: string[] = [];

  constructor(private readonly previousOpenAt: number) {}

  mark(stage: string): void {
    const now = performance.now();
    this.stages.push(`${stage}=${Math.round(now - this.last)}`);
    this.last = now;
  }

  write(detail: string): void {
    const idleSeconds = this.previousOpenAt
      ? Math.round((Date.now() - this.previousOpenAt) / 1000)
      : -1;
    const line =
      `${new Date().toISOString()} total=${Math.round(performance.now() - this.start)}ms ` +
      `idle=${idleSeconds}s ${this.stages.join(" ")} ${detail}\n`;
    const directory = path.join(app.getPath("userData"), "logs");
    const file = path.join(directory, "screenshot-timing.log");
    void (async () => {
      try {
        await mkdir(directory, { recursive: true });
        const info = await stat(file).catch(() => null);
        if (info && info.size > TIMING_LOG_MAX_BYTES) await rename(file, `${file}.1`);
        await appendFile(file, line);
      } catch {
        // Diagnostics must never affect screenshots.
      }
    })();
  }
}

/** Zero-padded two-character number for the save-dialog default filename. */
function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function defaultSaveName(): string {
  const now = new Date();
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Dockwisp-截图-${date}-${time}.png`;
}

/**
 * Owns the full-screen screenshot overlay: captures the display under the
 * cursor, shows a transparent selection window, and serves the copy / save /
 * OCR / translate actions the overlay invokes.
 *
 * The overlay window is created once (prewarmed) and reused: open() repositions
 * the hidden window over the active display, pushes fresh state, and shows it
 * once the renderer has repainted; close() hides it and tells the renderer to
 * reset, rather than destroying it. The window is only rebuilt if its render
 * process is gone. Capturing uses the native GDI helper (fast, no base64) and
 * falls back to desktopCapturer when the helper is unavailable.
 */
export class ScreenshotController {
  private overlay: BrowserWindow | null = null;
  // Resolves when the (reused) overlay's page has finished loading.
  private overlayLoaded: Promise<void> | null = null;
  private hotkey = "";
  private revealOverlay: (() => void) | null = null;
  private placeOverlay: (() => void) | null = null;
  private revealTimer: NodeJS.Timeout | null = null;
  // Guards against overlapping captures when the hotkey is pressed repeatedly.
  private captureToken = 0;
  private blurCloseArmed = false;
  private suppressBlurClose = false;
  // Path of the native BMP temp file backing the current capture, or null when
  // the desktopCapturer data-URL fallback was used.
  private currentShotPath: string | null = null;
  private lastOpenAt = 0;
  private lastHotkeyAt = 0;

  constructor(
    private readonly launcher: BrowserWindow,
    private readonly settings: SettingsStore,
    private readonly helper?: MouseHelper,
  ) {
    this.registerIpc();
    app.once("before-quit", () => {
      void this.cleanupShot();
    });
    // Prewarm the overlay on the next tick so the first hotkey press does not
    // pay the window-creation + page-load cost.
    setTimeout(() => this.prewarm(), 1_500).unref();
  }

  /** Build and load the hidden overlay ahead of time if it does not exist yet. */
  prewarm(): void {
    if (process.platform !== "win32") return;
    try {
      this.ensureOverlay();
    } catch {
      // Best-effort warmup; capture() will retry on demand.
    }
    // The OCR worker is resident; load its models once at startup.
    warmupOcr(false);
  }

  /** Register the global screenshot hotkey; returns it on success, "" on failure. */
  registerHotkey(hotkey: string): string {
    const trimmed = (hotkey ?? "").trim();
    if (!trimmed) {
      this.hotkey = "";
      return "";
    }
    try {
      if (globalShortcut.register(trimmed, () => this.onHotkey())) {
        this.hotkey = trimmed;
        return trimmed;
      }
    } catch {
      // Invalid accelerator string: treat as a failed registration.
    }
    this.hotkey = "";
    return "";
  }

  /**
   * Holding the hotkey makes Windows auto-repeat it every ~30ms; each repeat
   * would restart the capture, so the overlay never appears until release.
   * Triggers that follow the previous one within HOTKEY_REPEAT_GAP_MS are
   * treated as auto-repeat and ignored.
   */
  private onHotkey(): void {
    const now = Date.now();
    const isRepeat = now - this.lastHotkeyAt < HOTKEY_REPEAT_GAP_MS;
    this.lastHotkeyAt = now;
    if (isRepeat) return;
    this.open(false);
  }

  /**
   * Start a capture. `hideLauncher` drops the launcher from the shot first; it
   * is set when the capture is started from inside the launcher. The global
   * hotkey leaves it alone so the launcher itself can be captured.
   */
  open(hideLauncher = false): void {
    const token = ++this.captureToken;
    void this.capture(token, hideLauncher).catch((error) => {
      dialog.showErrorBox(
        "截图失败",
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  /** Create (if needed) the reusable hidden overlay window and start its load. */
  private ensureOverlay(): BrowserWindow {
    if (this.overlay && !this.overlay.isDestroyed()) return this.overlay;

    // Opaque on purpose: the overlay always paints a full-screen screenshot, and
    // a transparent full-screen window forces per-frame alpha composition on
    // Windows, which makes selection dragging lag behind the cursor.
    const overlay = new BrowserWindow({
      width: 100,
      height: 100,
      frame: false,
      transparent: false,
      backgroundColor: "#000000",
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      fullscreenable: false,
      hasShadow: false,
      roundedCorners: false,
      thickFrame: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "screenshot.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Keep timers/decoding running while the reusable overlay is hidden so
        // the next capture is painted and ready without throttling delays.
        backgroundThrottling: false,
      },
    });
    overlay.setAlwaysOnTop(true, "screen-saver");
    if (this.helper) {
      // Disable the DWM show/hide animation so the overlay appears instantly.
      const handle = overlay.getNativeWindowHandle();
      const nativeHandle =
        handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
      void this.helper.prepareWindow(nativeHandle).catch(() => undefined);
    }
    overlay.on("closed", () => {
      if (this.overlay === overlay) {
        this.overlay = null;
        this.overlayLoaded = null;
      }
    });
    overlay.webContents.on("render-process-gone", () => {
      // The window is unusable once its renderer dies; drop it so the next
      // open() rebuilds a fresh overlay.
      this.overlay = null;
      this.overlayLoaded = null;
      if (!overlay.isDestroyed()) overlay.destroy();
    });
    overlay.on("blur", () => {
      // Clicking another window dismisses the screenshot overlay. Native save
      // dialogs also blur the window, so they temporarily suppress this.
      if (this.overlay !== overlay || !this.blurCloseArmed || this.suppressBlurClose) {
        return;
      }
      if (!overlay.isVisible()) return;
      if (overlay.webContents.isDevToolsOpened()) return;
      this.closeOverlay();
    });

    this.overlay = overlay;
    this.overlayLoaded = new Promise<void>((resolve) => {
      overlay.webContents.once("did-finish-load", () => resolve());
    });
    void overlay.loadFile(
      path.join(__dirname, "..", "renderer", "screenshot", "index.html"),
    );
    return overlay;
  }

  private async capture(token: number, hideLauncher: boolean): Promise<void> {
    const timing = new CaptureTiming(this.lastOpenAt);
    this.lastOpenAt = Date.now();
    // No-op when the resident worker is already warm; restarts it if it died.
    warmupOcr();

    // If an overlay is already on screen (repeated trigger), reset it first so
    // we never capture a previous overlay or stack stale state.
    if (this.overlay && !this.overlay.isDestroyed() && this.overlay.isVisible()) {
      this.resetOverlay();
    }

    const launcherVisible =
      hideLauncher &&
      !!this.launcher &&
      !this.launcher.isDestroyed() &&
      this.launcher.isVisible();
    if (launcherVisible) {
      this.launcher.hide();
      // Only wait when the launcher was actually on screen and must be dropped
      // from the capture; the hidden-launcher hotkey path skips this entirely.
      await wait(HIDE_DELAY_MS);
      if (token !== this.captureToken) return;
      timing.mark("hideLauncher");
    }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const capture = await this.captureDisplay(display);
    if (token !== this.captureToken) return;
    timing.mark(capture.tainted ? "captureGdi" : "captureFallback");

    const overlayExisted = !!this.overlay && !this.overlay.isDestroyed();
    const overlay = this.ensureOverlay();
    await this.overlayLoaded;
    if (token !== this.captureToken || overlay.isDestroyed()) return;
    timing.mark(overlayExisted ? "overlayReused" : "overlayCreated");

    // Keep the window hidden until the renderer has decoded + painted the new
    // image, so the user never sees a blank overlay or a stale previous frame.
    // It is then shown off-screen first: Chromium only presents a fresh frame
    // once the window is visible, and showing it in place would flash the
    // black window background for a frame. After that frame is painted the
    // window is moved on-screen and the renderer fades the dim layer in.
    const onscreen = {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    };
    const offscreen = { ...onscreen, ...offscreenOrigin() };
    overlay.setBounds(offscreen);
    overlay.setAlwaysOnTop(true, "screen-saver");
    this.blurCloseArmed = false;
    this.suppressBlurClose = false;

    const state: ScreenshotState = {
      imageUrl: capture.imageUrl,
      width: capture.width,
      height: capture.height,
      scaleFactor: display.scaleFactor,
      tainted: capture.tainted,
    };

    let placed = false;
    const place = (timedOut: boolean): void => {
      if (placed || overlay.isDestroyed() || token !== this.captureToken) return;
      placed = true;
      timing.mark(timedOut ? "paintTimeout" : "painted");
      if (this.revealTimer) {
        clearTimeout(this.revealTimer);
        this.revealTimer = null;
      }
      this.placeOverlay = null;
      overlay.setBounds(onscreen);
      overlay.focus();
      overlay.webContents.send("screenshot:revealed");
      timing.mark("shown");
      timing.write(`${capture.width}x${capture.height}`);
      // A background process may not be allowed to take the foreground from a
      // global hotkey; ask the native helper to activate the overlay.
      if (this.helper) {
        const handle = overlay.getNativeWindowHandle();
        const nativeHandle =
          handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
        void this.helper.focusWindow(nativeHandle).catch(() => undefined);
      }
      // Give focus a moment to settle before enabling blur-to-close.
      setTimeout(() => {
        if (this.overlay === overlay && !overlay.isDestroyed()) this.blurCloseArmed = true;
      }, 400);
    };

    let revealed = false;
    const reveal = (timedOut: boolean): void => {
      if (revealed || overlay.isDestroyed() || token !== this.captureToken) return;
      revealed = true;
      timing.mark(timedOut ? "readyTimeout" : "rendererReady");
      if (this.revealTimer) clearTimeout(this.revealTimer);
      this.revealOverlay = null;
      overlay.show();
      this.placeOverlay = () => place(false);
      overlay.webContents.send("screenshot:shown");
      this.revealTimer = setTimeout(() => place(true), PAINT_TIMEOUT_MS);
    };
    this.revealOverlay = () => reveal(false);
    overlay.webContents.send("screenshot:state", state);
    timing.mark("stateSent");
    this.revealTimer = setTimeout(() => reveal(true), 1_000);
  }

  /**
   * Capture the given display. Prefers the native GDI helper (fast, file-based,
   * no base64); falls back to desktopCapturer as a JPEG data URL when the
   * helper is unavailable or fails.
   */
  private async captureDisplay(
    display: Electron.Display,
  ): Promise<{ imageUrl: string; width: number; height: number; tainted: boolean }> {
    await this.cleanupShot();

    if (this.helper) {
      try {
        // DIP bounds → physical pixels for the target display.
        const rect = screen.dipToScreenRect(null, display.bounds);
        const result = await this.helper.captureScreen(
          rect.x,
          rect.y,
          rect.width,
          rect.height,
        );
        if (result) {
          this.currentShotPath = result.path;
          return {
            imageUrl: pathToFileURL(result.path).toString(),
            width: result.width,
            height: result.height,
            tainted: true,
          };
        }
      } catch {
        // Fall through to desktopCapturer.
      }
    }

    // Fallback: desktopCapturer. Quality 90 keeps the payload reasonable.
    const thumbnailSize = {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    };
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize,
      fetchWindowIcons: false,
    });
    if (sources.length === 0) throw new Error("没有可用的屏幕捕获源");
    const source =
      sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
    const thumbnail = source.thumbnail;
    if (thumbnail.isEmpty()) throw new Error("屏幕捕获返回空图像");
    const size = thumbnail.getSize();
    return {
      imageUrl: `data:image/jpeg;base64,${thumbnail.toJPEG(90).toString("base64")}`,
      width: size.width,
      height: size.height,
      tainted: false,
    };
  }

  /** Hide the overlay and reset the renderer's state without destroying it. */
  private resetOverlay(): void {
    this.revealOverlay = null;
    this.placeOverlay = null;
    this.blurCloseArmed = false;
    this.suppressBlurClose = false;
    if (this.revealTimer) {
      clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
    const overlay = this.overlay;
    if (overlay && !overlay.isDestroyed()) {
      if (overlay.isVisible()) overlay.hide();
      overlay.webContents.send("screenshot:reset");
    }
    void this.cleanupShot();
  }

  private closeOverlay(): void {
    this.resetOverlay();
  }

  /** Delete the current native screenshot temp file, if any. */
  private async cleanupShot(): Promise<void> {
    const shot = this.currentShotPath;
    this.currentShotPath = null;
    if (shot) await unlink(shot).catch(() => undefined);
  }

  /** True when the IPC call came from the live overlay window. */
  private fromOverlay(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
    return (
      this.overlay !== null &&
      !this.overlay.isDestroyed() &&
      event.sender === this.overlay.webContents
    );
  }

  private registerIpc(): void {
    ipcMain.on("screenshot:close", (event) => {
      if (this.fromOverlay(event)) this.closeOverlay();
    });

    ipcMain.on("screenshot:ready", (event) => {
      if (this.fromOverlay(event)) this.revealOverlay?.();
    });

    ipcMain.on("screenshot:painted", (event) => {
      if (this.fromOverlay(event)) this.placeOverlay?.();
    });

    ipcMain.handle("screenshot:image-bytes", async (event) => {
      if (!this.fromOverlay(event)) return null;
      const shot = this.currentShotPath;
      if (!shot) return null;
      try {
        const buffer = await readFile(shot);
        // Return a plain Uint8Array; Electron transfers it as binary (no base64).
        return new Uint8Array(buffer);
      } catch {
        return null;
      }
    });

    ipcMain.handle("screenshot:copy-image", async (event, dataUrl: unknown) => {
      if (!this.fromOverlay(event)) return false;
      const image = this.decodeImage(dataUrl);
      if (!image) throw new Error("无效的图片数据");
      clipboard.writeImage(image);
      return true;
    });

    ipcMain.handle("screenshot:copy-text", async (event, text: unknown) => {
      if (!this.fromOverlay(event)) return false;
      clipboard.writeText(typeof text === "string" ? text : "");
      return true;
    });

    ipcMain.handle("screenshot:save-image", async (event, dataUrl: unknown) => {
      if (!this.fromOverlay(event)) return null;
      const image = this.decodeImage(dataUrl);
      if (!image) throw new Error("无效的图片数据");
      const overlay = this.overlay;
      if (!overlay || overlay.isDestroyed()) return null;
      this.suppressBlurClose = true;
      try {
        const result = await dialog.showSaveDialog(overlay, {
          title: "保存截图",
          defaultPath: defaultSaveName(),
          filters: [{ name: "PNG 图片", extensions: ["png"] }],
        });
        if (result.canceled || !result.filePath) return null;
        await writeFile(result.filePath, image.toPNG());
        return result.filePath;
      } finally {
        this.suppressBlurClose = false;
      }
    });

    ipcMain.handle("screenshot:ocr", async (event, dataUrl: unknown) => {
      if (!this.fromOverlay(event)) return "";
      const image = this.decodeImage(dataUrl);
      if (!image) throw new Error("无效的图片数据");
      const temporary = path.join(
        tmpdir(),
        `dockwisp-ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
      );
      const size = image.getSize();
      const resized = ocrResizeDimensions(size.width, size.height);
      const ocrImage = resized
        ? image.resize({ ...resized, quality: "best" })
        : image;
      await writeFile(temporary, ocrImage.toPNG());
      const timing = new CaptureTiming(0);
      try {
        const text = await recognizeImageFile(temporary);
        timing.mark("ocr");
        timing.write(`ocr ${size.width}x${size.height} chars=${text.length}`);
        return text;
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    });

    ipcMain.handle("screenshot:translate", async (event, text: unknown) => {
      if (!this.fromOverlay(event)) throw new Error("请求来源无效");
      const source = typeof text === "string" ? text : "";
      const translation = this.settings.get().translation;
      const result = await translateText({
        text: source,
        provider: translation.provider,
        endpoint: translation.endpoint,
        apiKey: translation.apiKey,
      });
      return {
        translatedText: result.translatedText,
        sourceLanguage: result.sourceLanguage,
        targetLanguage: result.targetLanguage,
        provider: result.provider,
      };
    });
  }

  /** Validate a data URL and turn it into a non-empty nativeImage, or null. */
  private decodeImage(dataUrl: unknown): Electron.NativeImage | null {
    if (typeof dataUrl !== "string" || !DATA_URL_PREFIX.test(dataUrl)) return null;
    const image = nativeImage.createFromDataURL(dataUrl);
    return image.isEmpty() ? null : image;
  }
}
