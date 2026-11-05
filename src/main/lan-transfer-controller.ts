import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell } from "electron";
import { randomUUID } from "node:crypto";
import { promises as fsp, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import QRCode from "qrcode";
import { LanAddress, rankLanAddresses } from "../core/lan-transfer";
import {
  LanTransferServer,
  ReceivedFile,
  SharedFile,
  TransferProgress,
} from "./lan-transfer-server";
import { SettingsStore } from "./settings";

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SHARED_FILES = 500;

export interface LanTransferState {
  theme: "light" | "dark";
  running: boolean;
  url: string;
  qr: string;
  addresses: LanAddress[];
  address: string;
  port: number;
  receiveDir: string;
  clients: string[];
  message?: string;
}

/**
 * Owns the "局域网互传" window and its HTTP server. The server starts with the
 * window and stops when it closes or after ten idle minutes.
 */
export class LanTransferController {
  private window: BrowserWindow | null = null;
  private server: LanTransferServer | null = null;
  private files: SharedFile[] = [];
  private received: ReceivedFile[] = [];
  private clients: string[] = [];
  private addresses: LanAddress[] = [];
  private address = "";
  private qr = "";
  private message: string | undefined;
  private idleTimer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly settings: SettingsStore) {
    this.registerIpc();
  }

  open(paths: string[] = []): void {
    this.addPaths(paths);
    const window = this.ensureWindow();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    void this.ensureServer();
  }

  async dispose(): Promise<void> {
    await this.stopServer();
  }

  private theme(): "light" | "dark" {
    const preference = this.settings.get().theme;
    if (preference === "system") return nativeTheme.shouldUseDarkColors ? "dark" : "light";
    return preference;
  }

  private receiveDir(): string {
    const configured = this.settings.get().lanReceiveDirectory;
    return configured || path.join(app.getPath("downloads"), "Dockwisp");
  }

  // --- Server lifecycle ------------------------------------------------------

  private async ensureServer(): Promise<void> {
    if (this.server?.running) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.addresses = rankLanAddresses(os.networkInterfaces());
      if (!this.addresses.some((item) => item.address === this.address)) {
        this.address = this.addresses[0]?.address ?? "";
      }
      if (!this.address) {
        this.message = "未检测到局域网连接，请确认电脑已连接 Wi-Fi 或网线";
        this.sendState();
        return;
      }
      const server = new LanTransferServer({
        receiveDir: () => this.receiveDir(),
        mobileHtml: () =>
          fsp.readFile(path.join(__dirname, "..", "renderer", "lan-transfer", "mobile.html"), "utf8"),
        onActivity: () => this.touch(),
        onClient: (address) => {
          if (!this.clients.includes(address)) this.clients.push(address);
          this.sendState();
        },
        onProgress: (progress) => this.sendProgress(progress),
        onReceived: (file) => {
          this.received.unshift(file);
          this.send("lan:received", this.received);
        },
      });
      server.setFiles(this.files);
      try {
        await server.start();
      } catch (error) {
        this.message = `无法启动传输服务：${error instanceof Error ? error.message : String(error)}`;
        this.sendState();
        return;
      }
      this.server = server;
      this.message = undefined;
      await this.refreshQr();
      this.touch();
      this.sendState();
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async stopServer(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const server = this.server;
    this.server = null;
    this.clients = [];
    this.qr = "";
    if (server) await server.stop();
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.stopServer().then(() => {
        this.message = "空闲超过 10 分钟，传输服务已停止";
        this.sendState();
      });
    }, IDLE_TIMEOUT_MS);
  }

  private url(): string {
    if (!this.server?.running || !this.address) return "";
    return `http://${this.address}:${this.server.port}/?t=${this.server.token}`;
  }

  private async refreshQr(): Promise<void> {
    const url = this.url();
    this.qr = url ? await QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: "M" }) : "";
  }

  // --- Files -----------------------------------------------------------------

  private addPaths(paths: string[]): void {
    for (const filePath of paths) {
      if (typeof filePath !== "string" || !filePath) continue;
      if (this.files.length >= MAX_SHARED_FILES) break;
      const key = path.resolve(filePath).toLowerCase();
      if (this.files.some((file) => path.resolve(file.path).toLowerCase() === key)) continue;
      try {
        const stats = statSync(filePath);
        if (!stats.isFile()) continue;
        this.files.push({
          id: randomUUID(),
          path: filePath,
          name: path.basename(filePath),
          size: stats.size,
          mtime: stats.mtimeMs,
        });
      } catch {
        // Unreadable path: skip.
      }
    }
    this.server?.setFiles(this.files);
    this.send("lan:files", this.files);
  }

  // --- Window ----------------------------------------------------------------

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const width = Math.min(820, Math.max(640, display.workArea.width - 80));
    const height = Math.min(600, Math.max(460, display.workArea.height - 80));
    const window = new BrowserWindow({
      x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
      y: Math.round(display.workArea.y + (display.workArea.height - height) / 2),
      width,
      height,
      minWidth: 620,
      minHeight: 440,
      show: false,
      frame: true,
      autoHideMenuBar: true,
      title: "局域网互传",
      backgroundColor: this.theme() === "dark" ? "#1b1c23" : "#f3f4f8",
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "lan-transfer.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window = window;
    window.on("closed", () => {
      if (this.window !== window) return;
      this.window = null;
      this.files = [];
      this.received = [];
      this.message = undefined;
      void this.stopServer();
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.once("did-finish-load", () => {
      this.sendState();
      this.send("lan:files", this.files);
      this.send("lan:received", this.received);
    });
    void window.loadFile(path.join(__dirname, "..", "renderer", "lan-transfer", "index.html"));
    return window;
  }

  private send(channel: string, payload: unknown): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send(channel, payload);
  }

  private state(): LanTransferState {
    return {
      theme: this.theme(),
      running: this.server?.running === true,
      url: this.url(),
      qr: this.qr,
      addresses: this.addresses,
      address: this.address,
      port: this.server?.port ?? 0,
      receiveDir: this.receiveDir(),
      clients: this.clients,
      message: this.message,
    };
  }

  private sendState(): void {
    this.send("lan:state", this.state());
  }

  private sendProgress(progress: TransferProgress): void {
    this.send("lan:progress", progress);
  }

  private fromWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
    return this.window !== null && !this.window.isDestroyed() && event.sender === this.window.webContents;
  }

  private isReceived(filePath: unknown): filePath is string {
    return typeof filePath === "string" && this.received.some((file) => file.path === filePath);
  }

  private registerIpc(): void {
    ipcMain.handle("lan:get-state", (event) => (this.fromWindow(event) ? this.state() : null));

    ipcMain.handle("lan:add-files", async (event) => {
      if (!this.fromWindow(event) || !this.window) return;
      const result = await dialog.showOpenDialog(this.window, {
        title: "选择要发送到手机的文件",
        properties: ["openFile", "multiSelections"],
      });
      if (!result.canceled) this.addPaths(result.filePaths);
    });

    ipcMain.handle("lan:add-dropped", (event, paths: unknown) => {
      if (!this.fromWindow(event) || !Array.isArray(paths)) return;
      this.addPaths(paths.filter((item): item is string => typeof item === "string"));
    });

    ipcMain.handle("lan:remove-file", (event, id: unknown) => {
      if (!this.fromWindow(event) || typeof id !== "string") return;
      this.files = this.files.filter((file) => file.id !== id);
      this.server?.setFiles(this.files);
      this.send("lan:files", this.files);
    });

    ipcMain.handle("lan:clear-files", (event) => {
      if (!this.fromWindow(event)) return;
      this.files = [];
      this.server?.setFiles(this.files);
      this.send("lan:files", this.files);
    });

    ipcMain.handle("lan:select-address", async (event, address: unknown) => {
      if (!this.fromWindow(event) || typeof address !== "string") return;
      if (!this.addresses.some((item) => item.address === address)) return;
      this.address = address;
      await this.refreshQr();
      this.sendState();
    });

    ipcMain.handle("lan:restart", async (event) => {
      if (!this.fromWindow(event)) return;
      await this.stopServer();
      await this.ensureServer();
    });

    ipcMain.handle("lan:choose-receive-dir", async (event) => {
      if (!this.fromWindow(event) || !this.window) return;
      const result = await dialog.showOpenDialog(this.window, {
        title: "选择接收文件的保存位置",
        defaultPath: this.receiveDir(),
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) return;
      this.settings.update({ lanReceiveDirectory: result.filePaths[0] });
      this.sendState();
    });

    ipcMain.handle("lan:open-receive-dir", async (event) => {
      if (!this.fromWindow(event)) return;
      const directory = this.receiveDir();
      await fsp.mkdir(directory, { recursive: true }).catch(() => undefined);
      await shell.openPath(directory);
    });

    ipcMain.handle("lan:open-file", async (event, filePath: unknown) => {
      if (!this.fromWindow(event) || !this.isReceived(filePath)) return { ok: false };
      const error = await shell.openPath(filePath);
      return error ? { ok: false, message: error } : { ok: true };
    });

    ipcMain.handle("lan:reveal-file", (event, filePath: unknown) => {
      if (!this.fromWindow(event) || !this.isReceived(filePath)) return false;
      shell.showItemInFolder(filePath);
      return true;
    });

    ipcMain.on("lan:close", (event) => {
      if (this.fromWindow(event)) this.window?.close();
    });
  }
}
