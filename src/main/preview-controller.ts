import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  nativeTheme,
  screen,
  shell,
} from "electron";
import { open as openFile, stat } from "node:fs/promises";
import path from "node:path";
import { SettingsStore } from "./settings";

export type PreviewKind = "image" | "text" | "audio" | "video" | "pdf" | "unsupported";

export interface PreviewState {
  kind: PreviewKind;
  name: string;
  path: string;
  size: number;
  modified: number;
  theme: "light" | "dark";
  iconUrl?: string;
  mime?: string;
  dataUrl?: string;
  text?: string;
  truncated?: boolean;
  message?: string;
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_DATA_BYTES = 30 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg", ".avif",
]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac", ".opus"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv"]);
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonc", ".js", ".mjs", ".cjs", ".ts", ".tsx",
  ".jsx", ".css", ".scss", ".less", ".html", ".htm", ".xml", ".yml", ".yaml", ".ini",
  ".conf", ".cfg", ".log", ".csv", ".tsv", ".py", ".java", ".c", ".cc", ".cpp", ".h",
  ".hpp", ".cs", ".go", ".rs", ".rb", ".php", ".sh", ".bash", ".zsh", ".bat", ".cmd",
  ".ps1", ".sql", ".toml", ".env", ".gitignore", ".editorconfig", ".properties",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".opus": "audio/opus",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".ogv": "video/ogg",
  ".pdf": "application/pdf",
};

/** Map an extension to the preview mode before reading the file. */
export function previewKindForExtension(extension: string): PreviewKind {
  const ext = extension.toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "unsupported";
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8 * 1024));
  let nulls = 0;
  for (const byte of sample) {
    if (byte === 0) nulls += 1;
  }
  return nulls > 0;
}

/**
 * Owns the standalone file preview window. Files are read into the renderer as
 * data URLs / text (never navigated to as a document), so markup or scripts in
 * a downloaded file cannot execute with app privileges.
 */
export class PreviewController {
  private window: BrowserWindow | null = null;
  private currentPath: string | null = null;
  private currentState: PreviewState | null = null;

  constructor(
    private readonly settings: SettingsStore,
    private readonly onClose?: () => void,
  ) {
    this.registerIpc();
  }

  async open(filePath: string): Promise<{ ok: boolean; message?: string }> {
    let stats;
    try {
      stats = await stat(filePath);
    } catch {
      return { ok: false, message: "文件不存在或无法访问" };
    }
    if (!stats.isFile()) return { ok: false, message: "只能预览文件" };

    const state = await this.buildState(filePath, stats.size, stats.mtimeMs);
    const window = this.ensureWindow(state);
    this.currentPath = filePath;
    this.currentState = state;
    window.setTitle(`预览 · ${state.name}`);
    window.webContents.send("preview:state", state);
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return { ok: true };
  }

  private ensureWindow(state: PreviewState): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const width = Math.min(920, Math.max(560, display.workArea.width - 80));
    const height = Math.min(700, Math.max(420, display.workArea.height - 80));
    const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
    const y = Math.round(display.workArea.y + (display.workArea.height - height) / 2);
    const window = new BrowserWindow({
      x,
      y,
      width,
      height,
      minWidth: 560,
      minHeight: 420,
      show: false,
      frame: true,
      autoHideMenuBar: true,
      hasShadow: true,
      backgroundColor: state.theme === "dark" ? "#202127" : "#f7f8fa",
      title: `预览 · ${state.name}`,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "preview.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        plugins: true,
      },
    });
    this.window = window;
    window.on("closed", () => {
      if (this.window === window) {
        this.window = null;
        this.currentPath = null;
        this.currentState = null;
        this.onClose?.();
      }
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("file:")) event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.once("did-finish-load", () => {
      if (!window.isDestroyed() && this.currentState) {
        window.webContents.send("preview:state", this.currentState);
      }
    });
    void window.loadFile(
      path.join(__dirname, "..", "renderer", "preview", "index.html"),
    );
    return window;
  }

  private async buildState(
    filePath: string,
    size: number,
    modified: number,
  ): Promise<PreviewState> {
    const ext = path.extname(filePath).toLowerCase();
    const themePreference = this.settings.get().theme;
    const theme: "light" | "dark" =
      themePreference === "system"
        ? nativeTheme.shouldUseDarkColors
          ? "dark"
          : "light"
        : themePreference;
    const state: PreviewState = {
      kind: previewKindForExtension(ext),
      name: path.basename(filePath),
      path: filePath,
      size,
      modified,
      theme,
    };
    try {
      state.iconUrl = (await app.getFileIcon(filePath)).toDataURL();
    } catch {
      // Custom / inaccessible files may not have an icon.
    }

    if (state.kind === "unsupported" && ext === "") {
      // Extensionless files are still worth a text preview when they contain
      // readable content; sniff a small prefix and fall back if it is binary.
      state.kind = "text";
    }

    if (state.kind === "text") {
      try {
        const buffer = await this.readPrefix(filePath, MAX_TEXT_BYTES + 1);
        if (looksBinary(buffer)) {
          state.kind = "unsupported";
          state.message = "该文件看起来是二进制内容，暂不支持内嵌预览";
          return state;
        }
        state.truncated = buffer.length > MAX_TEXT_BYTES;
        state.text = buffer
          .subarray(0, Math.min(buffer.length, MAX_TEXT_BYTES))
          .toString("utf8")
          .replace(/^\uFEFF/, "");
      } catch (error) {
        state.kind = "unsupported";
        state.message = `无法读取文件：${error instanceof Error ? error.message : String(error)}`;
      }
      return state;
    }

    if (state.kind === "unsupported") {
      state.message = "该文件类型暂不支持内嵌预览，可使用系统默认应用打开";
      return state;
    }

    if (size > MAX_DATA_BYTES) {
      state.kind = "unsupported";
      state.message = "文件过大，无法内嵌预览（上限 30 MB）";
      return state;
    }
    try {
      const buffer = await this.readPrefix(filePath, MAX_DATA_BYTES + 1);
      const mime = MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
      state.mime = mime;
      state.dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
    } catch (error) {
      state.kind = "unsupported";
      state.message = `无法读取文件：${error instanceof Error ? error.message : String(error)}`;
    }
    return state;
  }

  private async readPrefix(filePath: string, length: number): Promise<Buffer> {
    const handle = await openFile(filePath, "r");
    try {
      const buffer = Buffer.alloc(Math.max(1, length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  private fromPreview(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
    return (
      this.window !== null &&
      !this.window.isDestroyed() &&
      event.sender === this.window.webContents
    );
  }

  private registerIpc(): void {
    ipcMain.on("preview:close", (event) => {
      if (!this.fromPreview(event)) return;
      this.window?.close();
    });
    ipcMain.handle("preview:open-external", async (event) => {
      if (!this.fromPreview(event) || !this.currentPath) return false;
      const error = await shell.openPath(this.currentPath);
      return error ? { ok: false, message: error } : { ok: true };
    });
    ipcMain.handle("preview:reveal", (event) => {
      if (!this.fromPreview(event) || !this.currentPath) return false;
      shell.showItemInFolder(this.currentPath);
      return true;
    });
    ipcMain.handle("preview:copy-path", (event) => {
      if (!this.fromPreview(event) || !this.currentPath) return false;
      clipboard.writeText(this.currentPath);
      return true;
    });
  }
}
