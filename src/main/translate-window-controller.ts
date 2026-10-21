import { BrowserWindow, clipboard, ipcMain, nativeTheme, screen } from "electron";
import path from "node:path";
import { translateText } from "../translation/providers";
import { SettingsStore } from "./settings";

interface TranslateInitialState {
  theme: "light" | "dark";
  text: string;
  provider: "mymemory" | "libretranslate";
  providerName: string;
}

/**
 * Owns the standalone "翻译" editor window. The renderer
 * (src/renderer/translate-window) holds the editable source / read-only
 * target panes and asks the main process to translate over ipc, so network
 * access and credentials stay out of the sandboxed page.
 */
export class TranslateWindowController {
  private window: BrowserWindow | null = null;
  private pendingState: TranslateInitialState | null = null;
  private ipcRegistered = false;

  constructor(private readonly settings: SettingsStore) {
    this.registerIpc();
  }

  open(text?: string): void {
    const state = this.buildState(text ?? "");
    this.pendingState = state;
    const window = this.ensureWindow(state);
    window.webContents.send("translate:state", state);
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  private buildState(text: string): TranslateInitialState {
    const translation = this.settings.get().translation;
    return {
      theme: this.resolveTheme(),
      text,
      provider: translation.provider,
      providerName: translation.provider === "libretranslate" ? "LibreTranslate" : "MyMemory",
    };
  }

  private resolveTheme(): "light" | "dark" {
    const preference = this.settings.get().theme;
    if (preference === "system") {
      return nativeTheme.shouldUseDarkColors ? "dark" : "light";
    }
    return preference;
  }

  private ensureWindow(state: TranslateInitialState): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const width = Math.min(960, Math.max(640, display.workArea.width - 120));
    const height = Math.min(620, Math.max(420, display.workArea.height - 120));
    const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
    const y = Math.round(display.workArea.y + (display.workArea.height - height) / 2);
    const window = new BrowserWindow({
      x,
      y,
      width,
      height,
      minWidth: 420,
      minHeight: 340,
      show: false,
      frame: true,
      autoHideMenuBar: true,
      hasShadow: true,
      backgroundColor: state.theme === "dark" ? "#1b1c23" : "#f3f4f8",
      title: "翻译",
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "translate-window.js"),
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
        window.webContents.send("translate:state", this.pendingState);
      }
    });
    void window.loadFile(
      path.join(__dirname, "..", "renderer", "translate-window", "index.html"),
    );
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

    ipcMain.handle("translate:run", async (event, payload: unknown) => {
      if (!this.fromWindow(event)) return { ok: false, message: "无效的来源" };
      const data = (payload ?? {}) as {
        text?: unknown;
        source?: unknown;
        target?: unknown;
      };
      const text = typeof data.text === "string" ? data.text : "";
      const source = typeof data.source === "string" ? data.source : undefined;
      const target = typeof data.target === "string" ? data.target : undefined;
      const translation = this.settings.get().translation;
      try {
        const result = await translateText({
          text,
          provider: translation.provider,
          endpoint: translation.endpoint,
          apiKey: translation.apiKey,
          source,
          target,
        });
        return { ok: true, result };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });

    ipcMain.handle("translate:copy", (event, text: unknown) => {
      if (!this.fromWindow(event)) return false;
      clipboard.writeText(typeof text === "string" ? text : "");
      return true;
    });

    ipcMain.on("translate:close", (event) => {
      if (!this.fromWindow(event)) return;
      this.window?.close();
    });
  }
}
