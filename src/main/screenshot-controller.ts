import {
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
} from "electron";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { translateText } from "../translation/providers";
import { MouseHelper } from "./mouse-helper";
import { recognizeImageFile } from "./ocr";
import { SettingsStore } from "./settings";

interface ScreenshotState {
  image: string;
  width: number;
  height: number;
  scaleFactor: number;
}

const HIDE_DELAY_MS = 160;
const DATA_URL_PREFIX = /^data:image\/[a-z.+-]+;base64,/i;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

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
 * OCR / translate actions the overlay invokes. One overlay at a time; a new
 * open() closes any previous one.
 */
export class ScreenshotController {
  private overlay: BrowserWindow | null = null;
  private hotkey = "";
  private revealOverlay: (() => void) | null = null;
  private revealTimer: NodeJS.Timeout | null = null;
  // Guards against overlapping captures when the hotkey is pressed repeatedly.
  private captureToken = 0;
  private blurCloseArmed = false;
  private suppressBlurClose = false;

  constructor(
    private readonly launcher: BrowserWindow,
    private readonly settings: SettingsStore,
    private readonly helper?: MouseHelper,
  ) {
    this.registerIpc();
  }

  /** Register the global screenshot hotkey; returns it on success, "" on failure. */
  registerHotkey(hotkey: string): string {
    const trimmed = (hotkey ?? "").trim();
    if (!trimmed) {
      this.hotkey = "";
      return "";
    }
    try {
      if (globalShortcut.register(trimmed, () => this.open())) {
        this.hotkey = trimmed;
        return trimmed;
      }
    } catch {
      // Invalid accelerator string: treat as a failed registration.
    }
    this.hotkey = "";
    return "";
  }

  open(): void {
    const token = ++this.captureToken;
    void this.capture(token).catch((error) => {
      dialog.showErrorBox(
        "截图失败",
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  private async capture(token: number): Promise<void> {
    // Close any stale overlay so a repeated trigger never stacks windows or
    // captures a previous overlay still on screen.
    this.closeOverlay();
    if (this.launcher && !this.launcher.isDestroyed()) this.launcher.hide();
    await wait(HIDE_DELAY_MS);
    if (token !== this.captureToken) return;

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const thumbnailSize = {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    };
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize,
      fetchWindowIcons: false,
    });
    if (token !== this.captureToken) return;
    if (sources.length === 0) throw new Error("没有可用的屏幕捕获源");
    const source =
      sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
    const thumbnail = source.thumbnail;
    if (thumbnail.isEmpty()) throw new Error("屏幕捕获返回空图像");
    const size = thumbnail.getSize();
    // JPEG keeps the IPC payload small compared with a full-resolution PNG
    // data URL for a 4K display.
    const image = `data:image/jpeg;base64,${thumbnail.toJPEG(95).toString("base64")}`;

    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      fullscreenable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "screenshot.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.on("closed", () => {
      if (this.overlay === overlay) this.overlay = null;
    });
    overlay.on("blur", () => {
      // Clicking another window dismisses the screenshot overlay. Native save
      // dialogs also blur the window, so they temporarily suppress this.
      if (this.overlay !== overlay || !this.blurCloseArmed || this.suppressBlurClose) {
        return;
      }
      if (overlay.webContents.isDevToolsOpened()) return;
      this.closeOverlay();
    });
    this.overlay = overlay;
    this.blurCloseArmed = false;
    this.suppressBlurClose = false;

    const state: ScreenshotState = {
      image,
      width: size.width,
      height: size.height,
      scaleFactor: display.scaleFactor,
    };
    // Keep the window hidden until the renderer has decoded the image and
    // painted it, so the user never sees a transparent/blank overlay. The
    // renderer sends `screenshot:ready`; the timer is a safety net.
    let revealed = false;
    const reveal = (): void => {
      if (revealed || overlay.isDestroyed()) return;
      revealed = true;
      if (this.revealTimer) {
        clearTimeout(this.revealTimer);
        this.revealTimer = null;
      }
      this.revealOverlay = null;
      overlay.show();
      overlay.focus();
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
    this.revealOverlay = reveal;
    overlay.webContents.once("did-finish-load", () => {
      if (overlay.isDestroyed()) return;
      overlay.webContents.send("screenshot:state", state);
      this.revealTimer = setTimeout(reveal, 1_000);
    });
    void overlay.loadFile(
      path.join(__dirname, "..", "renderer", "screenshot", "index.html"),
    );
  }

  private closeOverlay(): void {
    const overlay = this.overlay;
    this.overlay = null;
    this.revealOverlay = null;
    this.blurCloseArmed = false;
    this.suppressBlurClose = false;
    if (this.revealTimer) {
      clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
    if (overlay && !overlay.isDestroyed()) overlay.close();
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
      await writeFile(temporary, image.toPNG());
      try {
        return await recognizeImageFile(temporary);
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
