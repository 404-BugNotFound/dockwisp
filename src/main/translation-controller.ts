import {
  BrowserWindow,
  clipboard,
  ipcMain,
  nativeImage,
  screen,
} from "electron";
import path from "node:path";
import { MouseHelper, MiddleMouseEvent } from "./mouse-helper";
import { SettingsStore } from "./settings";
import { translateText, TranslationResult } from "../translation/providers";

interface ClipboardSnapshot {
  text: string;
  html: string;
  rtf: string;
  image?: Buffer;
  hadContent: boolean;
}

interface TranslationViewState {
  status: "loading" | "success" | "error";
  sourceText?: string;
  translatedText?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  provider?: string;
  message?: string;
  pinned: boolean;
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class TranslationController {
  private window: BrowserWindow | null = null;
  private downEvent: MiddleMouseEvent | null = null;
  private longPressTimer: NodeJS.Timeout | null = null;
  private thresholdReached = false;
  private directSelectionPromise: Promise<boolean> | null = null;
  private autoHideTimer: NodeJS.Timeout | null = null;
  private running = false;
  private pinned = false;
  private lastResult: TranslationResult | null = null;
  private diagnostics = {
    middleDowns: 0,
    longPresses: 0,
    lastStage: "等待中键",
    lastError: "",
    lastSelectedLength: 0,
  };

  constructor(
    private readonly helper: MouseHelper,
    private readonly settings: SettingsStore,
  ) {
    helper.on("mouse", (event: MiddleMouseEvent) => this.onMouse(event));
    ipcMain.on("translation:close", () => {
      this.pinned = false;
      this.hide();
    });
    ipcMain.on("translation:copy", () => {
      if (this.lastResult) clipboard.writeText(this.lastResult.translatedText);
    });
    ipcMain.on("translation:pin", (_event, pinned: boolean) => {
      this.pinned = pinned === true;
      if (this.pinned) {
        if (this.autoHideTimer) clearTimeout(this.autoHideTimer);
        this.autoHideTimer = null;
      } else if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
        if (this.autoHideTimer) clearTimeout(this.autoHideTimer);
        this.autoHideTimer = setTimeout(() => this.hide(), 14_000);
      }
      if (this.window && !this.window.isDestroyed()) {
        this.window.setAlwaysOnTop(true, this.pinned ? "pop-up-menu" : "floating");
      }
      this.sendState(this.currentState());
    });
  }

  async translateManual(text: string, point = screen.getCursorScreenPoint()): Promise<void> {
    await this.translateAndShow(text, point);
  }

  getDiagnostics(): typeof this.diagnostics {
    return { ...this.diagnostics };
  }

  private onMouse(rawEvent: MiddleMouseEvent): void {
    if (rawEvent.button !== "middle") return;
    const event = this.toDipEvent(rawEvent);
    if (event.action === "down") {
      if (this.longPressTimer) clearTimeout(this.longPressTimer);
      this.downEvent = null;
      this.thresholdReached = false;
      this.directSelectionPromise = null;
      const settings = this.settings.get();
      if (!settings.translationEnabled || this.isBlacklisted(event.process)) return;
      this.diagnostics.middleDowns += 1;
      this.diagnostics.lastStage = "检测到中键按下";
      this.downEvent = event;
      this.longPressTimer = setTimeout(() => {
        this.longPressTimer = null;
        if (this.downEvent === event) void this.beginLongPress(event);
      }, settings.longPressMs);
      return;
    }
    const origin = this.downEvent;
    this.downEvent = null;
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.longPressTimer = null;
    if (!origin) return;
    const elapsed = Math.max(0, event.time - origin.time);
    if (elapsed < this.settings.get().longPressMs && !this.thresholdReached) {
      this.diagnostics.lastStage = `中键短按 ${elapsed}ms`;
      return;
    }
    void this.finishLongPress(origin);
  }

  private isBlacklisted(processPath?: string): boolean {
    if (!processPath) return false;
    const processName = path.basename(processPath).toLowerCase();
    return this.settings
      .get()
      .processBlacklist.some((item) => item.toLowerCase() === processName);
  }

  private toDipEvent(event: MiddleMouseEvent): MiddleMouseEvent {
    if (process.platform !== "win32") return event;
    // The native helper is per-monitor DPI aware and reports physical pixels,
    // while Electron positions windows with DIP coordinates.
    const point = screen.screenToDipPoint({ x: event.x, y: event.y });
    return { ...event, x: point.x, y: point.y };
  }

  private beginLongPress(origin: MiddleMouseEvent): Promise<boolean> {
    if (this.directSelectionPromise) return this.directSelectionPromise;
    this.thresholdReached = true;
    this.diagnostics.longPresses += 1;
    this.diagnostics.lastStage = "达到长按阈值，正在直接读取选区";
    this.directSelectionPromise = (async () => {
      try {
        let text = (await this.helper.readSelectedText()).trim();
        this.diagnostics.lastSelectedLength = text.length;
        if (!text) {
          this.diagnostics.lastStage = "直接取词无结果，正在模拟复制选区";
          text = await this.captureSelectedText(true);
          this.diagnostics.lastSelectedLength = text.length;
        }
        if (!text) {
          this.diagnostics.lastStage = "长按取词无结果，等待松开后重试";
          return false;
        }
        this.diagnostics.lastStage = "已取词，正在翻译";
        await this.translateAndShow(text, { x: origin.x, y: origin.y });
        this.diagnostics.lastStage = "翻译浮窗已显示";
        this.diagnostics.lastError = "";
        return true;
      } catch (error) {
        this.diagnostics.lastError = error instanceof Error ? error.message : String(error);
        this.diagnostics.lastStage = "直接取词失败，等待松开后重试";
        return false;
      }
    })();
    return this.directSelectionPromise;
  }

  private async finishLongPress(origin: MiddleMouseEvent): Promise<void> {
    const translated = await this.beginLongPress(origin);
    if (!translated) await this.captureAndTranslate(origin);
  }

  private async captureAndTranslate(origin: MiddleMouseEvent): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const text = await this.captureSelectedText();
      this.diagnostics.lastSelectedLength = text.length;
      if (!text) {
        this.diagnostics.lastStage = "未读取到选中文本";
        return;
      }
      this.diagnostics.lastStage = "已取词，正在翻译";
      await this.translateAndShow(text, { x: origin.x, y: origin.y });
      this.diagnostics.lastStage = "翻译浮窗已显示";
      this.diagnostics.lastError = "";
    } catch (error) {
      this.diagnostics.lastStage = "翻译失败";
      this.diagnostics.lastError = error instanceof Error ? error.message : String(error);
      this.showState(
        {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
          pinned: this.pinned,
        },
        { x: origin.x, y: origin.y },
      );
    } finally {
      this.running = false;
    }
  }

  private captureSnapshot(): ClipboardSnapshot {
    const image = clipboard.readImage();
    const formats = clipboard.availableFormats();
    return {
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
      image: image.isEmpty() ? undefined : image.toPNG(),
      hadContent: formats.length > 0,
    };
  }

  private restoreSnapshot(snapshot: ClipboardSnapshot): void {
    if (!snapshot.hadContent) {
      clipboard.clear();
      return;
    }
    clipboard.write({
      text: snapshot.text,
      html: snapshot.html,
      rtf: snapshot.rtf,
      ...(snapshot.image
        ? { image: nativeImage.createFromBuffer(snapshot.image) }
        : {}),
    });
  }

  private async captureSelectedText(skipDirectSelection = false): Promise<string> {
    await wait(120);
    if (!skipDirectSelection) {
      this.diagnostics.lastStage = "正在通过 UI Automation 读取选区";
      const directSelection = (await this.helper.readSelectedText()).trim();
      if (directSelection) return directSelection;
    }

    this.diagnostics.lastStage = "UI Automation 无结果，尝试模拟复制";
    const snapshot = this.captureSnapshot();
    let before = await this.helper.getClipboardSequence();
    await this.helper.copySelection();
    let copiedSequence = before;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await wait(40);
      copiedSequence = await this.helper.getClipboardSequence();
      if (copiedSequence !== before) break;
    }
    if (copiedSequence === before) {
      this.diagnostics.lastStage = "Ctrl+C 无结果，尝试 Ctrl+Insert";
      before = await this.helper.getClipboardSequence();
      await this.helper.copySelectionAlternate();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await wait(40);
        copiedSequence = await this.helper.getClipboardSequence();
        if (copiedSequence !== before) break;
      }
    }
    if (copiedSequence === before) return "";
    await wait(80);
    copiedSequence = await this.helper.getClipboardSequence();
    const selected = clipboard.readText().trim();
    const current = await this.helper.getClipboardSequence();
    if (current === copiedSequence) this.restoreSnapshot(snapshot);
    return selected;
  }

  private async translateAndShow(text: string, point: Electron.Point): Promise<void> {
    // Each new selection starts as a transient popup; the user can pin the
    // current result explicitly.
    this.pinned = false;
    this.showState({ status: "loading", sourceText: text, pinned: this.pinned }, point);
    try {
      const translation = this.settings.get().translation;
      const result = await translateText({
        text,
        provider: translation.provider,
        endpoint: translation.endpoint,
        apiKey: translation.apiKey,
      });
      this.lastResult = result;
      this.showState(
        { status: "success", ...result, pinned: this.pinned },
        point,
      );
    } catch (error) {
      this.lastResult = null;
      this.showState(
        {
          status: "error",
          sourceText: text,
          message: error instanceof Error ? error.message : String(error),
          pinned: this.pinned,
        },
        point,
      );
    }
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    this.window = new BrowserWindow({
      width: 440,
      height: 230,
      show: false,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      transparent: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "translation.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window.on("closed", () => {
      this.window = null;
    });
    this.window.on("blur", () => {
      // An unpinned translation is a transient popup: clicking elsewhere closes
      // it. Pinned results deliberately stay above other windows.
      if (!this.pinned) this.hide();
    });
    void this.window.loadFile(
      path.join(__dirname, "..", "renderer", "translation", "index.html"),
    );
    return this.window;
  }

  private showState(state: TranslationViewState, point: Electron.Point): void {
    const window = this.ensureWindow();
    const display = screen.getDisplayNearestPoint(point);
    const width = 440;
    const height = 230;
    const x = Math.min(
      display.workArea.x + display.workArea.width - width,
      Math.max(display.workArea.x, point.x + 14),
    );
    const yBelow = point.y + 18;
    const y =
      yBelow + height <= display.workArea.y + display.workArea.height
        ? yBelow
        : Math.max(display.workArea.y, point.y - height - 14);
    window.setBounds({ x, y, width, height });
    window.setAlwaysOnTop(true, this.pinned ? "pop-up-menu" : "floating");
    const send = () => this.sendState(state);
    if (window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
    else send();
    // Focus the popup so a click on any other window produces a blur and closes
    // the unpinned card. The native helper makes foreground activation reliable
    // when this was triggered by a global mouse hook.
    window.show();
    window.focus();
    const handle = window.getNativeWindowHandle();
    const nativeHandle =
      handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
    void this.helper.focusWindow(nativeHandle).catch(() => undefined);
    if (this.autoHideTimer) clearTimeout(this.autoHideTimer);
    if (!this.pinned) {
      this.autoHideTimer = setTimeout(() => this.hide(), 14_000);
    }
  }

  private currentState(): TranslationViewState {
    return this.lastResult
      ? { status: "success", ...this.lastResult, pinned: this.pinned }
      : { status: "loading", pinned: this.pinned };
  }

  private sendState(state: TranslationViewState): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("translation:state", state);
    }
  }

  private hide(): void {
    if (this.autoHideTimer) clearTimeout(this.autoHideTimer);
    this.autoHideTimer = null;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }
}
