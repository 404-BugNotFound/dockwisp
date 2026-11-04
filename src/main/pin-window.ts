import { BrowserWindow, clipboard, dialog, Menu, nativeImage, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export interface PinPayload {
  dataUrl: string;
  /** Selection origin/size in physical pixels relative to the capture display. */
  x: number;
  y: number;
  width: number;
  height: number;
}

const DATA_URL_PREFIX = /^data:image\/[a-z.+-]+;base64,/i;
const MIN_SCALE = 0.1;
const MAX_SCALE = 5;

/** Zero-padded two-character number for the default save filename. */
function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** Default save filename, matching the overlay's naming scheme. */
export function pinDefaultSaveName(): string {
  const now = new Date();
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Dockwisp-钉图-${date}-${time}.png`;
}

interface PinEntry {
  window: BrowserWindow;
  image: Electron.NativeImage;
  dataUrl: string;
  // Base content size in DIP at 100% (physical pixels / scaleFactor).
  baseWidth: number;
  baseHeight: number;
  scale: number;
  // Window origin captured at the start of a pointer drag.
  dragOrigin: { x: number; y: number } | null;
}

/**
 * Owns the "钉图" windows: frameless always-on-top windows that show a pinned
 * screenshot at a chosen zoom. Several may exist at once. Each window serves
 * its own move / zoom / copy / save / close requests over ipc; the image bytes
 * live in the main process so nothing is written to a temp file.
 */
export class PinWindowManager {
  private readonly entries = new Map<number, PinEntry>();
  private ipcRegistered = false;

  constructor() {
    this.registerIpc();
  }

  /**
   * Create a pin window at the selection's on-screen position. `payload`
   * coordinates are physical pixels relative to `display`; they are converted
   * to DIP so the image shows at 100% physical resolution.
   */
  create(payload: PinPayload, display: Electron.Display): boolean {
    if (typeof payload.dataUrl !== "string" || !DATA_URL_PREFIX.test(payload.dataUrl)) {
      return false;
    }
    const image = nativeImage.createFromDataURL(payload.dataUrl);
    if (image.isEmpty()) return false;

    const scaleFactor = display.scaleFactor || 1;
    const baseWidth = Math.max(1, Math.round(payload.width / scaleFactor));
    const baseHeight = Math.max(1, Math.round(payload.height / scaleFactor));
    // Long screenshots can be far taller than the screen: start zoomed out so
    // the pin fits the work area, and keep its origin on screen.
    const area = display.workArea;
    const initialScale = Math.max(
      MIN_SCALE,
      Math.min(1, area.width / baseWidth, area.height / baseHeight),
    );
    const initialWidth = Math.max(1, Math.round(baseWidth * initialScale));
    const initialHeight = Math.max(1, Math.round(baseHeight * initialScale));
    const clampAxis = (value: number, start: number, span: number, size: number): number =>
      Math.min(Math.max(value, start), Math.max(start, start + span - size));
    const originX = clampAxis(
      Math.round(display.bounds.x + payload.x / scaleFactor),
      area.x,
      area.width,
      initialWidth,
    );
    const originY = clampAxis(
      Math.round(display.bounds.y + payload.y / scaleFactor),
      area.y,
      area.height,
      initialHeight,
    );

    const window = new BrowserWindow({
      x: originX,
      y: originY,
      width: initialWidth,
      height: initialHeight,
      useContentSize: true,
      frame: false,
      transparent: false,
      backgroundColor: "#000000",
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: true,
      roundedCorners: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "pin.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.setAlwaysOnTop(true, "screen-saver");

    const entry: PinEntry = {
      window,
      image,
      dataUrl: payload.dataUrl,
      baseWidth,
      baseHeight,
      scale: initialScale,
      dragOrigin: null,
    };
    // Read the id now: webContents is unusable once the window is destroyed,
    // which is already the case when "closed" fires.
    const contentsId = window.webContents.id;
    this.entries.set(contentsId, entry);

    window.on("closed", () => {
      this.entries.delete(contentsId);
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.once("did-finish-load", () => {
      if (window.isDestroyed()) return;
      window.webContents.send("pin:image", {
        dataUrl: payload.dataUrl,
        cssWidth: baseWidth,
        cssHeight: baseHeight,
        scale: initialScale,
      });
      window.show();
    });
    void window.loadFile(path.join(__dirname, "..", "renderer", "pin", "index.html"));
    return true;
  }

  private entryFor(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): PinEntry | null {
    const entry = this.entries.get(event.sender.id);
    if (!entry || entry.window.isDestroyed()) return null;
    return entry;
  }

  private registerIpc(): void {
    if (this.ipcRegistered) return;
    this.ipcRegistered = true;

    ipcMain.on("pin:drag-start", (event) => {
      const entry = this.entryFor(event);
      if (!entry) return;
      const bounds = entry.window.getBounds();
      entry.dragOrigin = { x: bounds.x, y: bounds.y };
    });

    ipcMain.on("pin:drag-move", (event, payload: unknown) => {
      const entry = this.entryFor(event);
      if (!entry || !entry.dragOrigin) return;
      const data = (payload ?? {}) as { dx?: unknown; dy?: unknown };
      const dx = typeof data.dx === "number" ? Math.round(data.dx) : 0;
      const dy = typeof data.dy === "number" ? Math.round(data.dy) : 0;
      const bounds = entry.window.getBounds();
      entry.window.setBounds({
        x: entry.dragOrigin.x + dx,
        y: entry.dragOrigin.y + dy,
        width: bounds.width,
        height: bounds.height,
      });
    });

    ipcMain.on("pin:drag-end", (event) => {
      const entry = this.entryFor(event);
      if (entry) entry.dragOrigin = null;
    });

    // Zoom anchored at the window's top-left: only width/height change, the
    // origin stays put. Returns the applied (clamped) scale so the page can
    // show the percentage.
    ipcMain.handle("pin:zoom", (event, scale: unknown) => {
      const entry = this.entryFor(event);
      if (!entry) return 1;
      const requested = typeof scale === "number" && Number.isFinite(scale) ? scale : 1;
      const applied = Math.min(MAX_SCALE, Math.max(MIN_SCALE, requested));
      entry.scale = applied;
      const bounds = entry.window.getBounds();
      entry.window.setContentBounds({
        x: bounds.x,
        y: bounds.y,
        width: Math.max(1, Math.round(entry.baseWidth * applied)),
        height: Math.max(1, Math.round(entry.baseHeight * applied)),
      });
      return applied;
    });

    ipcMain.on("pin:close", (event) => {
      const entry = this.entryFor(event);
      if (entry) entry.window.close();
    });

    // Pins skip the taskbar, so a minimized pin would be unreachable. Show it
    // in the taskbar only while minimized, then hide it again once restored.
    ipcMain.on("pin:minimize", (event) => {
      const entry = this.entryFor(event);
      if (!entry) return;
      const window = entry.window;
      window.setSkipTaskbar(false);
      window.once("restore", () => {
        if (!window.isDestroyed()) window.setSkipTaskbar(true);
      });
      window.minimize();
    });

    ipcMain.on("pin:menu", (event) => {
      const entry = this.entryFor(event);
      if (!entry) return;
      const menu = Menu.buildFromTemplate([
        { label: "复制", click: () => clipboard.writeImage(entry.image) },
        { label: "保存…", click: () => void this.save(entry) },
        { type: "separator" },
        { label: "关闭", click: () => entry.window.close() },
      ]);
      menu.popup({ window: entry.window });
    });
  }

  private async save(entry: PinEntry): Promise<void> {
    if (entry.window.isDestroyed()) return;
    const result = await dialog.showSaveDialog(entry.window, {
      title: "保存钉图",
      defaultPath: pinDefaultSaveName(),
      filters: [{ name: "PNG 图片", extensions: ["png"] }],
    });
    if (result.canceled || !result.filePath) return;
    await writeFile(result.filePath, entry.image.toPNG());
  }
}
