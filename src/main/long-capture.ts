import { BrowserWindow, ipcMain, nativeImage, screen } from "electron";
import path from "node:path";
import type { MouseHelper } from "./mouse-helper";
import { LongStitcher } from "./long-stitch";

export interface LongCaptureRect {
  /** Region origin/size in physical pixels relative to the capture display. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LongCaptureResult {
  pixels: Uint8Array;
  width: number;
  height: number;
}

interface LongCaptureCallbacks {
  onComplete: (result: LongCaptureResult) => void;
  onCancel: () => void;
}

// Capture cadence; a new grab only starts after the previous one returns so
// slow frames never overlap.
const FRAME_INTERVAL_MS = 100;
// Preview refreshes are throttled to at most five per second.
const PREVIEW_INTERVAL_MS = 200;
const PREVIEW_WIDTH_DIP = 220;
const PREVIEW_MIN_HEIGHT_DIP = 300;
const PREVIEW_GAP_DIP = 12;
const PREVIEW_THUMB_MAX_WIDTH = 200;
// Outer border drawn this many DIP outside the region on every side.
const BORDER_MARGIN_DIP = 3;

/** Convert top-down RGBA pixels to the BGRA layout nativeImage expects. */
function rgbaToBgra(rgba: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i + 2];
    out[i + 1] = rgba[i + 1];
    out[i + 2] = rgba[i];
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

/**
 * One manual long-screenshot session: paints a border around a fixed region,
 * shows a live preview to the side, and stitches the region as the user
 * scrolls the underlying window. Completing or cancelling tears the session
 * down and invokes the matching callback with the stitched pixels (or nothing).
 */
export class LongCaptureSession {
  private border: BrowserWindow | null = null;
  private preview: BrowserWindow | null = null;
  private stitcher: LongStitcher | null = null;
  private frameWidth = 0;
  private frameHeight = 0;
  private capturing = false;
  private finished = false;
  private frameTimer: NodeJS.Timeout | null = null;
  private lastPreviewAt = 0;
  private previewLoaded = false;
  private ipcBound = false;

  // Physical-pixel screen rectangle of the capture region.
  private readonly physical: { x: number; y: number; width: number; height: number };

  constructor(
    private readonly helper: MouseHelper,
    private readonly display: Electron.Display,
    rect: LongCaptureRect,
    private readonly callbacks: LongCaptureCallbacks,
  ) {
    // The capture display's bounds in physical pixels; the region is offset
    // from there by the rect, which is already in physical pixels.
    const displayRect = screen.dipToScreenRect(null, display.bounds);
    this.physical = {
      x: displayRect.x + Math.round(rect.x),
      y: displayRect.y + Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  /** Begin the session: build windows, bind ipc, and start the capture loop. */
  start(): void {
    this.bindIpc();
    this.createBorderWindow();
    this.createPreviewWindow();
    this.scheduleFrame(0);
  }

  /** Cancel from outside (Esc, overlay reopened). Idempotent. */
  cancel(): void {
    if (this.finished) return;
    this.teardown();
    this.callbacks.onCancel();
  }

  /**
   * Tear the session down without invoking either callback. Used when the
   * screenshot overlay reopens and will restore itself, so the stale session
   * must not re-show the overlay underneath it.
   */
  dispose(): void {
    if (this.finished) return;
    this.teardown();
  }

  private finish(): void {
    if (this.finished) return;
    const stitcher = this.stitcher;
    this.teardown();
    if (!stitcher) {
      this.callbacks.onCancel();
      return;
    }
    this.callbacks.onComplete({
      pixels: stitcher.toPixels(),
      width: this.frameWidth,
      height: stitcher.height,
    });
  }

  private teardown(): void {
    this.finished = true;
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    this.unbindIpc();
    if (this.border && !this.border.isDestroyed()) this.border.destroy();
    if (this.preview && !this.preview.isDestroyed()) this.preview.destroy();
    this.border = null;
    this.preview = null;
  }

  private scheduleFrame(delay: number): void {
    if (this.finished) return;
    this.frameTimer = setTimeout(() => void this.grabFrame(), delay);
  }

  private async grabFrame(): Promise<void> {
    if (this.finished || this.capturing) {
      if (!this.finished) this.scheduleFrame(FRAME_INTERVAL_MS);
      return;
    }
    this.capturing = true;
    try {
      const result = await this.helper.captureScreen(
        this.physical.x,
        this.physical.y,
        this.physical.width,
        this.physical.height,
      );
      if (this.finished) return;
      if (result) {
        const pixels = new Uint8Array(
          result.pixels.buffer,
          result.pixels.byteOffset,
          result.pixels.length,
        );
        this.consumeFrame(pixels, result.width, result.height);
      }
    } catch {
      // A failed grab is skipped; the loop keeps going.
    } finally {
      this.capturing = false;
      if (!this.finished) this.scheduleFrame(FRAME_INTERVAL_MS);
    }
  }

  private consumeFrame(pixels: Uint8Array, width: number, height: number): void {
    if (!this.stitcher) {
      this.frameWidth = width;
      this.frameHeight = height;
      this.stitcher = new LongStitcher(width, pixels, height);
      this.sendPreview(true);
      return;
    }
    if (width !== this.frameWidth || height !== this.frameHeight) return;
    const appended = this.stitcher.push(pixels);
    if (appended) this.sendPreview(false);
    if (this.stitcher.full) this.finish();
  }

  /** Send a downscaled thumbnail of the current stitch to the preview page. */
  private sendPreview(force: boolean): void {
    if (!this.stitcher || !this.preview || this.preview.isDestroyed() || !this.previewLoaded) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastPreviewAt < PREVIEW_INTERVAL_MS) return;
    this.lastPreviewAt = now;

    const height = this.stitcher.height;
    try {
      const bgra = rgbaToBgra(this.stitcher.toPixels());
      const image = nativeImage.createFromBitmap(bgra, { width: this.frameWidth, height });
      const thumbWidth = Math.min(PREVIEW_THUMB_MAX_WIDTH, this.frameWidth);
      const thumb =
        thumbWidth < this.frameWidth ? image.resize({ width: thumbWidth }) : image;
      this.preview.webContents.send("longshot:preview", {
        dataUrl: thumb.toDataURL(),
        height,
      });
    } catch {
      // Preview rendering is best-effort and never affects the stitch.
    }
  }

  private createBorderWindow(): void {
    const regionDip = this.physicalRectToDip(this.physical);
    const border = new BrowserWindow({
      x: regionDip.x - BORDER_MARGIN_DIP,
      y: regionDip.y - BORDER_MARGIN_DIP,
      width: regionDip.width + BORDER_MARGIN_DIP * 2,
      height: regionDip.height + BORDER_MARGIN_DIP * 2,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      focusable: false,
      fullscreenable: false,
      hasShadow: false,
      roundedCorners: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    border.setAlwaysOnTop(true, "screen-saver");
    border.setIgnoreMouseEvents(true);
    border.webContents.on("will-navigate", (event) => event.preventDefault());
    border.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    border.once("ready-to-show", () => {
      if (!border.isDestroyed()) border.showInactive();
    });
    void border.loadFile(path.join(__dirname, "..", "renderer", "longshot", "border.html"));
    this.border = border;
  }

  private createPreviewWindow(): void {
    const regionDip = this.physicalRectToDip(this.physical);
    const bounds = this.display.bounds;
    const previewHeight = Math.max(PREVIEW_MIN_HEIGHT_DIP, regionDip.height);
    const rightX = regionDip.x + regionDip.width + PREVIEW_GAP_DIP;
    const leftX = regionDip.x - PREVIEW_GAP_DIP - PREVIEW_WIDTH_DIP;

    let x: number;
    let y = regionDip.y;
    if (rightX + PREVIEW_WIDTH_DIP <= bounds.x + bounds.width) {
      x = rightX;
    } else if (leftX >= bounds.x) {
      x = leftX;
    } else {
      // No room beside the region: tuck it into the region's bottom-right.
      x = regionDip.x + regionDip.width - PREVIEW_WIDTH_DIP - PREVIEW_GAP_DIP;
      y = regionDip.y + regionDip.height - previewHeight - PREVIEW_GAP_DIP;
    }
    // Keep the preview on the display.
    x = Math.max(bounds.x, Math.min(x, bounds.x + bounds.width - PREVIEW_WIDTH_DIP));
    y = Math.max(bounds.y, Math.min(y, bounds.y + bounds.height - previewHeight));

    const preview = new BrowserWindow({
      x: Math.round(x),
      y: Math.round(y),
      width: PREVIEW_WIDTH_DIP,
      height: Math.round(previewHeight),
      frame: false,
      transparent: false,
      backgroundColor: "#1b1c23",
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      fullscreenable: false,
      hasShadow: true,
      roundedCorners: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "longshot.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    preview.setAlwaysOnTop(true, "screen-saver");
    preview.webContents.on("will-navigate", (event) => event.preventDefault());
    preview.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    preview.webContents.once("did-finish-load", () => {
      if (preview.isDestroyed()) return;
      this.previewLoaded = true;
      // Shown without focus so the target window keeps receiving scroll events.
      preview.showInactive();
      if (this.stitcher) this.sendPreview(true);
    });
    void preview.loadFile(path.join(__dirname, "..", "renderer", "longshot", "index.html"));
    this.preview = preview;
  }

  private fromPreview(event: Electron.IpcMainEvent): boolean {
    return (
      this.preview !== null &&
      !this.preview.isDestroyed() &&
      event.sender === this.preview.webContents
    );
  }

  private readonly onDone = (event: Electron.IpcMainEvent): void => {
    if (this.fromPreview(event)) this.finish();
  };

  private readonly onCancelMessage = (event: Electron.IpcMainEvent): void => {
    if (this.fromPreview(event)) this.cancel();
  };

  private bindIpc(): void {
    if (this.ipcBound) return;
    this.ipcBound = true;
    ipcMain.on("longshot:done", this.onDone);
    ipcMain.on("longshot:cancel", this.onCancelMessage);
  }

  private unbindIpc(): void {
    if (!this.ipcBound) return;
    this.ipcBound = false;
    ipcMain.off("longshot:done", this.onDone);
    ipcMain.off("longshot:cancel", this.onCancelMessage);
  }

  private physicalRectToDip(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Electron.Rectangle {
    const dip = screen.screenToDipRect(null, rect);
    return {
      x: Math.round(dip.x),
      y: Math.round(dip.y),
      width: Math.round(dip.width),
      height: Math.round(dip.height),
    };
  }
}
