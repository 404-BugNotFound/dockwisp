import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  screen,
  session,
  type DesktopCapturerSource,
} from "electron";
import { createWriteStream, type WriteStream } from "node:fs";
import { copyFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

export type RecordAudioMode = "none" | "system" | "system+mic";

export interface RecordRect {
  /** Region origin/size in physical pixels relative to the display (same as LongCaptureRect). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RecordStartOptions {
  display: Electron.Display;
  rect: RecordRect;
  audio: RecordAudioMode;
}

export interface RecordControllerOptions {
  /** Called whenever isRecording() flips. */
  onStateChange?: (recording: boolean) => void;
}

/** Sent to the hidden recorder page; crop is in physical pixels relative to the display. */
interface RecorderConfig {
  crop: RecordRect;
  displayWidth: number;
  displayHeight: number;
  fullScreen: boolean;
  audio: RecordAudioMode;
}

type Phase = "idle" | "starting" | "recording" | "stopping" | "saving";

const PARTITION = "dockwisp-recorder";
const START_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 10000;
const BORDER_MARGIN_DIP = 3;
const BAR_WIDTH_DIP = 248;
const BAR_HEIGHT_DIP = 44;
const BAR_GAP_DIP = 10;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function defaultFileName(ext: string, date = new Date()): string {
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `Dockwisp-录屏-${stamp}.${ext}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Screen recording core. One recording at a time: a hidden window captures the
 * display (cropped to the region), streams encoded chunks to a temp file, and
 * a small control bar offers pause/resume/stop. Stopping asks where to save.
 */
export class RecordController {
  private phase: Phase = "idle";
  private recorder: BrowserWindow | null = null;
  private bar: BrowserWindow | null = null;
  private border: BrowserWindow | null = null;
  private source: DesktopCapturerSource | null = null;
  private audio: RecordAudioMode = "none";
  private config: RecorderConfig | null = null;
  private tempPath: string | null = null;
  private ext = "webm";
  private stream: WriteStream | null = null;
  private writeError: Error | null = null;
  private ipcBound = false;
  private paused = false;
  private elapsedBeforePause = 0;
  private resumedAt = 0;
  private physical = { x: 0, y: 0, width: 0, height: 0 };
  private display: Electron.Display | null = null;
  private startWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private stopWaiters: Array<() => void> = [];
  private stopTimer: NodeJS.Timeout | null = null;
  private cancelledDuringStart = false;

  constructor(private readonly options: RecordControllerOptions = {}) {}

  isRecording(): boolean {
    return this.phase !== "idle";
  }

  /** Snapshot for UI outside the control bar (e.g. the screenshot overlay). */
  status(): { recording: boolean; active: boolean; paused: boolean; elapsedMs: number } {
    return {
      recording: this.isRecording(),
      // True only while frames are being captured; false while starting or saving.
      active: this.phase === "recording",
      paused: this.paused,
      elapsedMs: this.elapsedMs(),
    };
  }

  /**
   * Start recording. Resolves once the encoder is running. On failure an error
   * dialog has already been shown and all windows are cleaned up; the promise
   * then rejects so callers can restore their own UI.
   */
  async start(opts: RecordStartOptions): Promise<void> {
    if (this.phase !== "idle") throw new Error("录屏已在进行中");
    this.setPhase("starting");
    this.audio = opts.audio;
    this.display = opts.display;
    try {
      const displayRect = screen.dipToScreenRect(null, opts.display.bounds);
      const crop = this.clampRect(opts.rect, displayRect.width, displayRect.height);
      const fullScreen =
        crop.x <= 0 &&
        crop.y <= 0 &&
        crop.width >= displayRect.width - 1 &&
        crop.height >= displayRect.height - 1;
      this.physical = {
        x: displayRect.x + crop.x,
        y: displayRect.y + crop.y,
        width: crop.width,
        height: crop.height,
      };
      this.config = {
        crop,
        displayWidth: displayRect.width,
        displayHeight: displayRect.height,
        fullScreen,
        audio: opts.audio,
      };
      this.source = await this.findSource(opts.display);
      this.bindIpc();

      const started = new Promise<void>((resolve, reject) => {
        this.startWaiter = { resolve, reject };
      });
      // Rejection may land before it is awaited; it is still awaited below.
      started.catch(() => undefined);
      const timeout = setTimeout(
        () => this.rejectStart(new Error("录屏启动超时")),
        START_TIMEOUT_MS,
      );
      try {
        await this.createRecorderWindow();
        await started;
      } finally {
        clearTimeout(timeout);
      }
      if ((this.phase as Phase) !== "recording") throw new Error("录屏未能启动");
      this.createBorderWindow(fullScreen);
      this.createBarWindow(fullScreen);
    } catch (error) {
      this.startWaiter = null;
      if (this.phase !== "idle") await this.fail(error, this.cancelledDuringStart);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Stop recording; resolves after the save dialog has been handled. */
  stop(): Promise<void> {
    if (this.phase === "idle") return Promise.resolve();
    const done = new Promise<void>((resolve) => this.stopWaiters.push(resolve));
    if (this.phase === "starting") {
      this.cancelledDuringStart = true;
      this.rejectStart(new Error("录屏已取消"));
      return done;
    }
    if (this.phase !== "recording") return done;
    this.setPhase("stopping");
    this.sendToRecorder("stop");
    this.stopTimer = setTimeout(() => void this.finalize(), STOP_TIMEOUT_MS);
    return done;
  }

  // ---------------------------------------------------------------- state

  private setPhase(phase: Phase): void {
    const was = this.isRecording();
    this.phase = phase;
    const now = this.isRecording();
    if (was !== now) this.options.onStateChange?.(now);
  }

  private clampRect(rect: RecordRect, maxWidth: number, maxHeight: number): RecordRect {
    const x = Math.max(0, Math.min(Math.round(rect.x), maxWidth - 2));
    const y = Math.max(0, Math.min(Math.round(rect.y), maxHeight - 2));
    const width = Math.max(2, Math.min(Math.round(rect.width), maxWidth - x));
    const height = Math.max(2, Math.min(Math.round(rect.height), maxHeight - y));
    return { x, y, width, height };
  }

  private async findSource(display: Electron.Display): Promise<DesktopCapturerSource> {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    });
    const match = sources.find((source) => source.display_id === String(display.id));
    if (match) return match;
    if (sources.length === 1) return sources[0];
    throw new Error("找不到要录制的显示器");
  }

  private elapsedMs(): number {
    if (this.paused || this.resumedAt === 0) return this.elapsedBeforePause;
    return this.elapsedBeforePause + (Date.now() - this.resumedAt);
  }

  private rejectStart(error: Error): void {
    const waiter = this.startWaiter;
    this.startWaiter = null;
    waiter?.reject(error);
  }

  // ---------------------------------------------------------------- windows

  private async createRecorderWindow(): Promise<void> {
    const recorderSession = session.fromPartition(PARTITION);
    recorderSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(
        (permission === "media" || permission === "display-capture") &&
          this.isRecorderContents(webContents),
      );
    });
    recorderSession.setPermissionCheckHandler((webContents, permission) => {
      return permission === "media" && this.isRecorderContents(webContents);
    });
    recorderSession.setDisplayMediaRequestHandler((request, callback) => {
      const frame = request.frame;
      const recorder = this.recorder;
      const fromRecorder =
        frame !== null &&
        recorder !== null &&
        !recorder.isDestroyed() &&
        frame.processId === recorder.webContents.mainFrame.processId &&
        frame.routingId === recorder.webContents.mainFrame.routingId;
      if (!fromRecorder || !this.source) {
        callback({});
        return;
      }
      callback({
        video: this.source,
        audio: this.audio !== "none" ? "loopback" : undefined,
      });
    });

    const recorder = new BrowserWindow({
      width: 320,
      height: 240,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "recorder.js"),
        session: recorderSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    this.recorder = recorder;
    recorder.webContents.on("will-navigate", (event) => event.preventDefault());
    recorder.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    recorder.webContents.on("render-process-gone", (_event, details) => {
      if (this.recorder === recorder) void this.fail(new Error(`录制进程异常退出：${details.reason}`));
    });
    await recorder.loadFile(path.join(__dirname, "..", "renderer", "recorder", "index.html"));
    if (recorder.isDestroyed()) throw new Error("录制窗口已关闭");
    // Run start with user activation so getDisplayMedia is always allowed.
    void recorder.webContents
      .executeJavaScript("window.dockwispRecorderStart && window.dockwispRecorderStart()", true)
      .catch((error: unknown) => this.rejectStart(new Error(errorMessage(error))));
  }

  private createBorderWindow(fullScreen: boolean): void {
    // Region: border sits just outside the recorded area. Full screen: the
    // window covers the display and the border is drawn along its inner edge.
    const regionDip = this.physicalRectToDip(this.physical);
    const bounds = fullScreen
      ? (this.display?.bounds ?? screen.getPrimaryDisplay().bounds)
      : {
          x: regionDip.x - BORDER_MARGIN_DIP,
          y: regionDip.y - BORDER_MARGIN_DIP,
          width: regionDip.width + BORDER_MARGIN_DIP * 2,
          height: regionDip.height + BORDER_MARGIN_DIP * 2,
        };
    const border = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
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
    void border.loadFile(path.join(__dirname, "..", "renderer", "recorder", "border.html"));
    this.border = border;
  }

  private createBarWindow(fullScreen: boolean): void {
    const area = this.display?.workArea ?? screen.getPrimaryDisplay().workArea;
    let x = area.x + Math.round((area.width - BAR_WIDTH_DIP) / 2);
    let y = area.y + BAR_GAP_DIP;
    if (!fullScreen) {
      const region = this.physicalRectToDip(this.physical);
      const below = region.y + region.height + BORDER_MARGIN_DIP + BAR_GAP_DIP;
      const above = region.y - BORDER_MARGIN_DIP - BAR_GAP_DIP - BAR_HEIGHT_DIP;
      x = region.x + region.width - BAR_WIDTH_DIP;
      if (below + BAR_HEIGHT_DIP <= area.y + area.height) {
        y = below;
      } else if (above >= area.y) {
        y = above;
      } else {
        // No room outside: tuck it inside the region's bottom-right corner.
        y = region.y + region.height - BAR_HEIGHT_DIP - BAR_GAP_DIP;
        x -= BAR_GAP_DIP;
      }
      x = Math.max(area.x, Math.min(x, area.x + area.width - BAR_WIDTH_DIP));
      y = Math.max(area.y, Math.min(y, area.y + area.height - BAR_HEIGHT_DIP));
    }

    const bar = new BrowserWindow({
      x: Math.round(x),
      y: Math.round(y),
      width: BAR_WIDTH_DIP,
      height: BAR_HEIGHT_DIP,
      frame: false,
      transparent: false,
      backgroundColor: "#1b1c23",
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      hasShadow: true,
      roundedCorners: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "record-bar.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    bar.setAlwaysOnTop(true, "screen-saver");
    bar.webContents.on("will-navigate", (event) => event.preventDefault());
    bar.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    bar.webContents.once("did-finish-load", () => {
      if (bar.isDestroyed()) return;
      bar.showInactive();
      this.sendBarState();
    });
    // Closing the bar (e.g. Alt+F4) stops the recording rather than orphaning it.
    bar.on("closed", () => {
      if (this.bar === bar) {
        this.bar = null;
        void this.stop();
      }
    });
    void bar.loadFile(path.join(__dirname, "..", "renderer", "recorder", "bar.html"));
    this.bar = bar;
  }

  private destroyWindows(): void {
    const windows = [this.recorder, this.bar, this.border];
    this.recorder = null;
    this.bar = null;
    this.border = null;
    for (const win of windows) {
      if (win && !win.isDestroyed()) win.destroy();
    }
  }

  private physicalRectToDip(rect: RecordRect): Electron.Rectangle {
    const dip = screen.screenToDipRect(null, rect);
    return {
      x: Math.round(dip.x),
      y: Math.round(dip.y),
      width: Math.round(dip.width),
      height: Math.round(dip.height),
    };
  }

  private sendToRecorder(command: "pause" | "resume" | "stop"): void {
    const recorder = this.recorder;
    if (recorder && !recorder.isDestroyed()) recorder.webContents.send("recorder:command", command);
  }

  private sendBarState(): void {
    const bar = this.bar;
    if (!bar || bar.isDestroyed()) return;
    bar.webContents.send("record-bar:state", {
      paused: this.paused,
      elapsedMs: this.elapsedMs(),
      stopping: this.phase !== "recording",
    });
  }

  // ---------------------------------------------------------------- ipc

  private isRecorderContents(contents: Electron.WebContents | null): boolean {
    return (
      contents !== null &&
      this.recorder !== null &&
      !this.recorder.isDestroyed() &&
      contents === this.recorder.webContents
    );
  }

  private isBarContents(contents: Electron.WebContents): boolean {
    return this.bar !== null && !this.bar.isDestroyed() && contents === this.bar.webContents;
  }

  private readonly onGetConfig = (event: Electron.IpcMainInvokeEvent): RecorderConfig | null => {
    if (!this.isRecorderContents(event.sender)) return null;
    return this.config;
  };

  private readonly onStarted = (event: Electron.IpcMainEvent, info: unknown): void => {
    if (!this.isRecorderContents(event.sender) || this.phase !== "starting") return;
    const mimeType =
      info && typeof (info as { mimeType?: unknown }).mimeType === "string"
        ? (info as { mimeType: string }).mimeType
        : "";
    this.ext = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
    const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    this.tempPath = path.join(app.getPath("temp"), `dockwisp-rec-${suffix}.${this.ext}`);
    this.writeError = null;
    const stream = createWriteStream(this.tempPath);
    stream.on("error", (error) => {
      this.writeError = error;
      void this.fail(new Error(`写入临时文件失败：${error.message}`));
    });
    this.stream = stream;
    this.paused = false;
    this.elapsedBeforePause = 0;
    this.resumedAt = Date.now();
    this.setPhase("recording");
    const waiter = this.startWaiter;
    this.startWaiter = null;
    waiter?.resolve();
  };

  private readonly onChunk = (event: Electron.IpcMainEvent, data: unknown): void => {
    if (!this.isRecorderContents(event.sender) || !this.stream || this.writeError) return;
    if (!(data instanceof Uint8Array) || data.byteLength === 0) return;
    this.stream.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  };

  private readonly onRecorderState = (event: Electron.IpcMainEvent, paused: unknown): void => {
    if (!this.isRecorderContents(event.sender) || this.phase !== "recording") return;
    const next = paused === true;
    if (next === this.paused) return;
    if (next) {
      this.elapsedBeforePause = this.elapsedMs();
      this.paused = true;
    } else {
      this.paused = false;
      this.resumedAt = Date.now();
    }
    this.sendBarState();
  };

  private readonly onStopped = (event: Electron.IpcMainEvent): void => {
    if (!this.isRecorderContents(event.sender)) return;
    if (this.phase === "recording") this.setPhase("stopping");
    if (this.phase === "stopping") void this.finalize();
  };

  private readonly onRecorderError = (event: Electron.IpcMainEvent, message: unknown): void => {
    if (!this.isRecorderContents(event.sender)) return;
    const error = new Error(typeof message === "string" && message ? message : "录屏失败");
    if (this.phase === "starting") {
      this.rejectStart(error);
      return;
    }
    void this.fail(error);
  };

  private readonly onBarTogglePause = (event: Electron.IpcMainEvent): void => {
    if (!this.isBarContents(event.sender) || this.phase !== "recording") return;
    this.sendToRecorder(this.paused ? "resume" : "pause");
  };

  private readonly onBarStop = (event: Electron.IpcMainEvent): void => {
    if (!this.isBarContents(event.sender)) return;
    void this.stop();
  };

  private bindIpc(): void {
    if (this.ipcBound) return;
    this.ipcBound = true;
    ipcMain.handle("recorder:get-config", this.onGetConfig);
    ipcMain.on("recorder:started", this.onStarted);
    ipcMain.on("recorder:chunk", this.onChunk);
    ipcMain.on("recorder:state", this.onRecorderState);
    ipcMain.on("recorder:stopped", this.onStopped);
    ipcMain.on("recorder:error", this.onRecorderError);
    ipcMain.on("record-bar:toggle-pause", this.onBarTogglePause);
    ipcMain.on("record-bar:stop", this.onBarStop);
  }

  private unbindIpc(): void {
    if (!this.ipcBound) return;
    this.ipcBound = false;
    ipcMain.removeHandler("recorder:get-config");
    ipcMain.off("recorder:started", this.onStarted);
    ipcMain.off("recorder:chunk", this.onChunk);
    ipcMain.off("recorder:state", this.onRecorderState);
    ipcMain.off("recorder:stopped", this.onStopped);
    ipcMain.off("recorder:error", this.onRecorderError);
    ipcMain.off("record-bar:toggle-pause", this.onBarTogglePause);
    ipcMain.off("record-bar:stop", this.onBarStop);
  }

  // ---------------------------------------------------------------- finish

  private closeStream(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (!stream || stream.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      stream.once("error", () => resolve());
      stream.end(() => resolve());
    });
  }

  private async finalize(): Promise<void> {
    if (this.phase !== "stopping") return;
    this.setPhaseQuiet("saving");
    this.clearStopTimer();
    this.unbindIpc();
    this.destroyWindows();
    await this.closeStream();
    const tempPath = this.tempPath;
    this.tempPath = null;
    try {
      if (tempPath && !this.writeError) await this.saveRecording(tempPath);
    } finally {
      this.reset();
    }
  }

  private async saveRecording(tempPath: string): Promise<void> {
    let target: string | undefined;
    try {
      const result = await dialog.showSaveDialog({
        title: "保存录屏",
        defaultPath: path.join(app.getPath("videos"), defaultFileName(this.ext)),
        filters: [
          this.ext === "mp4"
            ? { name: "MP4 视频", extensions: ["mp4"] }
            : { name: "WebM 视频", extensions: ["webm"] },
        ],
      });
      if (result.canceled || !result.filePath) {
        await rm(tempPath, { force: true });
        return;
      }
      target = result.filePath;
      try {
        await rename(tempPath, target);
      } catch {
        // Different volume (EXDEV) or similar: copy then drop the temp file.
        await copyFile(tempPath, target);
        await rm(tempPath, { force: true });
      }
    } catch (error) {
      dialog.showErrorBox(
        "保存录屏失败",
        `${errorMessage(error)}\n\n临时文件保留在：${tempPath}`,
      );
    }
  }

  private async fail(error: unknown, silent = false): Promise<void> {
    if (this.phase === "idle" || this.phase === "saving") return;
    this.setPhaseQuiet("saving");
    this.clearStopTimer();
    this.rejectStart(error instanceof Error ? error : new Error(String(error)));
    this.unbindIpc();
    this.destroyWindows();
    await this.closeStream();
    const tempPath = this.tempPath;
    this.tempPath = null;
    if (tempPath) await rm(tempPath, { force: true }).catch(() => undefined);
    if (!silent) dialog.showErrorBox("录屏失败", errorMessage(error));
    this.reset();
  }

  /** Phase change between non-idle states, which never flips isRecording(). */
  private setPhaseQuiet(phase: Exclude<Phase, "idle">): void {
    this.phase = phase;
  }

  private clearStopTimer(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  private reset(): void {
    this.source = null;
    this.config = null;
    this.display = null;
    this.paused = false;
    this.elapsedBeforePause = 0;
    this.resumedAt = 0;
    this.writeError = null;
    this.cancelledDuringStart = false;
    this.setPhase("idle");
    const waiters = this.stopWaiters;
    this.stopWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
