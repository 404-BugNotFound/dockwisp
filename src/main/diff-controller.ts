import { BrowserWindow, clipboard, ipcMain, nativeTheme, screen } from "electron";
import path from "node:path";
import { computeTextDiff, DiffOptions } from "../core/text-diff";
import { SettingsStore } from "./settings";

interface DiffInitialState {
  theme: "light" | "dark";
  left?: string;
  right?: string;
}

/**
 * Owns the standalone "文本对比" window. The window hosts a static renderer
 * (src/renderer/diff) and asks the main process to run the diff over ipc, so
 * the heavy algorithm stays off the renderer thread and large inputs remain
 * responsive.
 */
export class DiffController {
  private window: BrowserWindow | null = null;
  private pendingState: DiffInitialState | null = null;
  private ipcRegistered = false;

  constructor(private readonly settings: SettingsStore) {
    this.registerIpc();
  }

  open(initial?: { left?: string; right?: string }): void {
    const state: DiffInitialState = {
      theme: this.resolveTheme(),
      left: initial?.left,
      right: initial?.right,
    };
    this.pendingState = state;
    const window = this.ensureWindow(state);
    window.webContents.send("diff:state", state);
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  private resolveTheme(): "light" | "dark" {
    const preference = this.settings.get().theme;
    if (preference === "system") {
      return nativeTheme.shouldUseDarkColors ? "dark" : "light";
    }
    return preference;
  }

  private ensureWindow(state: DiffInitialState): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const width = Math.min(1180, Math.max(720, display.workArea.width - 80));
    const height = Math.min(760, Math.max(460, display.workArea.height - 80));
    const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
    const y = Math.round(display.workArea.y + (display.workArea.height - height) / 2);
    const window = new BrowserWindow({
      x,
      y,
      width,
      height,
      minWidth: 640,
      minHeight: 420,
      show: false,
      frame: true,
      autoHideMenuBar: true,
      hasShadow: true,
      backgroundColor: state.theme === "dark" ? "#1b1c23" : "#f3f4f8",
      title: "文本对比",
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "diff.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window = window;
    window.on("closed", () => {
      if (this.window === window) {
        this.window = null;
        this.pendingState = null;
      }
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.once("did-finish-load", () => {
      if (!window.isDestroyed() && this.pendingState) {
        window.webContents.send("diff:state", this.pendingState);
      }
    });
    void window.loadFile(path.join(__dirname, "..", "renderer", "diff", "index.html"));
    return window;
  }

  private fromWindow(
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  ): boolean {
    return (
      this.window !== null &&
      !this.window.isDestroyed() &&
      event.sender === this.window.webContents
    );
  }

  private registerIpc(): void {
    if (this.ipcRegistered) return;
    this.ipcRegistered = true;

    ipcMain.handle("diff:compute", (event, payload: unknown) => {
      if (!this.fromWindow(event)) return null;
      const data = (payload ?? {}) as {
        left?: unknown;
        right?: unknown;
        options?: unknown;
      };
      const left = typeof data.left === "string" ? data.left : "";
      const right = typeof data.right === "string" ? data.right : "";
      const rawOptions = (data.options ?? {}) as Record<string, unknown>;
      const options: DiffOptions = {
        ignoreWhitespace: rawOptions.ignoreWhitespace === true,
        ignoreCase: rawOptions.ignoreCase === true,
      };
      return computeTextDiff(left, right, options);
    });

    ipcMain.handle("diff:copy", (event, text: unknown) => {
      if (!this.fromWindow(event)) return false;
      clipboard.writeText(typeof text === "string" ? text : "");
      return true;
    });

    ipcMain.on("diff:close", (event) => {
      if (!this.fromWindow(event)) return;
      this.window?.close();
    });
  }
}
