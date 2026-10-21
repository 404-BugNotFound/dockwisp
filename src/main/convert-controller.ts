import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
} from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  baseName,
  categoryForExtension,
  csvToJson,
  extensionOf,
  jsonToCsv,
  jsonToXml,
  jsonToYaml,
  listTargetFormats,
  markdownToHtml,
  parseYaml,
  resolveOutputPath,
  stemOf,
  type Capabilities,
  type ConvertCategory,
  type TargetFormat,
} from "../core/file-convert";
import { convertImage, imageToPngBuffer } from "./convert-image";
import {
  DownloadCancelled,
  LIBREOFFICE,
  LibreOfficeEngine,
  type DownloadProgress,
} from "./convert-office-engine";
import { SettingsStore } from "./settings";

interface ConvertFile {
  id: string;
  path: string;
  name: string;
  ext: string;
  size: number;
  category: ConvertCategory | null;
}

interface ConvertRequest {
  id: string;
  path: string;
  targetExt: string;
  quality?: number;
  icoSizes?: number[];
  outputDir?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  tiff: "image/tiff",
  tif: "image/tiff",
  gif: "image/gif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

const MAX_IMAGE_BYTES = 120 * 1024 * 1024;

/**
 * Owns the standalone "file convert" window and the conversion engines. Image
 * work runs in-process via sharp; data conversions are pure; md/html/txt/image
 * to PDF use a short-lived hidden BrowserWindow + printToPDF; document formats
 * use LibreOffice, downloaded to userData on first use.
 */
export class ConvertController {
  private window: BrowserWindow | null = null;
  private files: ConvertFile[] = [];
  private readonly office: LibreOfficeEngine;
  private officeReady = false;
  // A preset target to pre-select once the window's files arrive.
  private pendingPreset: { target?: string } | null = null;

  constructor(private readonly settings: SettingsStore) {
    this.office = new LibreOfficeEngine(app.getPath("userData"));
    this.registerIpc();
    void this.refreshOfficeReady();
  }

  // --- Public API (used by the launcher wiring) ---------------------------

  /** Open the window, seeding files and optionally pre-selecting a target. */
  open(files: string[] = [], preset?: { target?: string }): void {
    const window = this.ensureWindow();
    this.pendingPreset = preset ?? null;
    if (files.length > 0) this.addPaths(files);
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    // If the preset needs the office engine and it is missing, prompt download.
    if (preset?.target) {
      void this.maybePromptPreset(preset.target);
    }
  }

  /** Targets common to all given files (intersection), ordered by usefulness. */
  async targetsFor(filePaths: string[]): Promise<TargetFormat[]> {
    await this.refreshOfficeReady();
    const caps = this.capabilities();
    const lists = filePaths
      .map((filePath) => listTargetFormats(extensionOf(filePath), caps))
      .filter((list) => list.length > 0);
    if (lists.length === 0) return [];
    const [first, ...rest] = lists;
    const intersection = first.filter((target) =>
      rest.every((list) => list.some((item) => item.id === target.id)),
    );
    return sortTargets(intersection);
  }

  /**
   * Convert every file to `target` (source directory, auto-suffixed name).
   * When an office target is requested but LibreOffice is absent, returns
   * { ok:false, needsDownload:true } without downloading.
   */
  async convertNow(
    filePaths: string[],
    target: string,
  ): Promise<{ ok: boolean; outputs: string[]; message?: string; needsDownload?: boolean }> {
    await this.refreshOfficeReady();
    const targetExt = target.toLowerCase();
    const outputs: string[] = [];
    for (const filePath of filePaths) {
      const ext = extensionOf(filePath);
      const targets = listTargetFormats(ext, this.capabilities());
      const match = targets.find((item) => item.id === targetExt);
      if (!match) {
        return { ok: false, outputs, message: `${baseName(filePath)} 不支持转换为 ${targetExt.toUpperCase()}` };
      }
      if (match.engine === "office" && !this.officeReady) {
        return { ok: false, outputs, needsDownload: true };
      }
    }
    for (const filePath of filePaths) {
      try {
        const output = await this.convertOne(filePath, targetExt, undefined);
        outputs.push(output);
      } catch (error) {
        return {
          ok: false,
          outputs,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { ok: true, outputs };
  }

  // --- Capabilities -------------------------------------------------------

  private capabilities(): Capabilities {
    return { office: this.officeReady };
  }

  private async refreshOfficeReady(): Promise<void> {
    try {
      this.officeReady = await this.office.isReady();
    } catch {
      this.officeReady = false;
    }
  }

  private theme(): "light" | "dark" {
    const preference = this.settings.get().theme;
    if (preference === "system") {
      return nativeTheme.shouldUseDarkColors ? "dark" : "light";
    }
    return preference;
  }

  // --- Window -------------------------------------------------------------

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = new BrowserWindow({
      width: 760,
      height: 640,
      minWidth: 560,
      minHeight: 460,
      show: false,
      frame: true,
      autoHideMenuBar: true,
      title: "文件转换",
      backgroundColor: this.theme() === "dark" ? "#1b1c23" : "#f3f4f8",
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "convert.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window = window;
    window.on("closed", () => {
      if (this.window === window) this.window = null;
      this.files = [];
      this.office.cancel();
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.once("did-finish-load", () => {
      this.sendState();
      this.sendFiles();
    });
    void window.loadFile(path.join(__dirname, "..", "renderer", "convert", "index.html"));
    return window;
  }

  private fromWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
    return (
      this.window !== null &&
      !this.window.isDestroyed() &&
      event.sender === this.window.webContents
    );
  }

  private sendState(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("convert:state", {
      theme: this.theme(),
      capabilities: this.capabilities(),
      office: { version: LIBREOFFICE.version, sizeMb: LIBREOFFICE.approxSizeMb },
    });
  }

  private sendFiles(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("convert:files", this.files);
    if (this.pendingPreset && this.files.length > 0) {
      this.window.webContents.send("convert:preset", this.pendingPreset);
      this.pendingPreset = null;
    }
  }

  /** Add file paths, ignoring directories, duplicates and unknown types. */
  private addPaths(paths: string[]): void {
    for (const filePath of paths) {
      if (!filePath || typeof filePath !== "string") continue;
      let stats: { isFile: boolean; size: number } | null = null;
      try {
        if (existsSync(filePath)) {
          const s = statSync(filePath);
          stats = { isFile: s.isFile(), size: s.size };
        }
      } catch {
        stats = null;
      }
      if (!stats || !stats.isFile) continue;
      const ext = extensionOf(filePath);
      const category = categoryForExtension(ext);
      if (!category) continue;
      if (this.files.some((file) => file.path === filePath)) continue;
      this.files.push({
        id: randomUUID(),
        path: filePath,
        name: baseName(filePath),
        ext,
        size: stats.size,
        category,
      });
    }
    this.sendFiles();
  }

  // --- IPC ----------------------------------------------------------------

  private registerIpc(): void {
    ipcMain.handle("convert:list-targets", (event, ext: unknown): TargetFormat[] => {
      if (!this.fromWindow(event) || typeof ext !== "string") return [];
      return sortTargets(listTargetFormats(ext, this.capabilities()));
    });

    ipcMain.handle("convert:add-files", async (event) => {
      if (!this.fromWindow(event) || !this.window) return;
      const result = await dialog.showOpenDialog(this.window, {
        title: "选择要转换的文件",
        properties: ["openFile", "multiSelections"],
      });
      if (!result.canceled) this.addPaths(result.filePaths);
    });

    ipcMain.handle("convert:add-dropped", (event, paths: unknown) => {
      if (!this.fromWindow(event) || !Array.isArray(paths)) return;
      this.addPaths(paths.filter((item): item is string => typeof item === "string"));
    });

    ipcMain.handle("convert:remove-file", (event, id: unknown) => {
      if (!this.fromWindow(event) || typeof id !== "string") return;
      this.files = this.files.filter((file) => file.id !== id);
      this.sendFiles();
    });

    ipcMain.handle("convert:choose-output-dir", async (event) => {
      if (!this.fromWindow(event) || !this.window) return null;
      const result = await dialog.showOpenDialog(this.window, {
        title: "选择输出目录",
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    });

    ipcMain.handle("convert:read-source", async (event, filePath: unknown) => {
      if (!this.fromWindow(event) || typeof filePath !== "string") return "";
      if (!this.files.some((file) => file.path === filePath)) return "";
      const ext = extensionOf(filePath);
      try {
        // bmp/ico aren't natively renderable; transcode to png for the preview.
        if (ext === "bmp" || ext === "ico" || ext === "tiff" || ext === "tif") {
          const png = await imageToPngBuffer(filePath);
          return `data:image/png;base64,${png.toString("base64")}`;
        }
        const buffer = await readFile(filePath);
        const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
        return `data:${mime};base64,${buffer.toString("base64")}`;
      } catch {
        return "";
      }
    });

    ipcMain.handle("convert:start", async (event, requests: unknown) => {
      if (!this.fromWindow(event) || !Array.isArray(requests)) return;
      for (const raw of requests) {
        const request = this.normalizeRequest(raw);
        if (!request) continue;
        await this.runRequest(request);
      }
    });

    ipcMain.handle("convert:download-office", async (event) => {
      if (!this.fromWindow(event)) return { ok: false };
      return this.downloadOffice();
    });

    ipcMain.on("convert:cancel-download", (event) => {
      if (this.fromWindow(event)) this.office.cancel();
    });

    ipcMain.handle("convert:open-file", async (event, filePath: unknown) => {
      if (!this.fromWindow(event) || typeof filePath !== "string") return { ok: false };
      const error = await shell.openPath(filePath);
      return error ? { ok: false, message: error } : { ok: true };
    });

    ipcMain.handle("convert:reveal-file", (event, filePath: unknown) => {
      if (!this.fromWindow(event) || typeof filePath !== "string") return false;
      shell.showItemInFolder(filePath);
      return true;
    });

    ipcMain.on("convert:close", (event) => {
      if (this.fromWindow(event)) this.window?.close();
    });
  }

  private normalizeRequest(raw: unknown): ConvertRequest | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    if (typeof value.id !== "string" || typeof value.path !== "string") return null;
    if (typeof value.targetExt !== "string") return null;
    const file = this.files.find((item) => item.id === value.id && item.path === value.path);
    if (!file) return null;
    const request: ConvertRequest = {
      id: value.id,
      path: value.path,
      targetExt: value.targetExt.toLowerCase(),
    };
    if (typeof value.quality === "number" && Number.isFinite(value.quality)) {
      request.quality = Math.min(1, Math.max(0.1, value.quality));
    }
    if (Array.isArray(value.icoSizes)) {
      request.icoSizes = value.icoSizes
        .filter((item): item is number => typeof item === "number")
        .map((item) => Math.round(item))
        .filter((item) => item >= 8 && item <= 256);
    }
    if (typeof value.outputDir === "string" && value.outputDir) {
      request.outputDir = value.outputDir;
    }
    return request;
  }

  private progress(id: string, percent: number): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("convert:progress", { id, percent });
  }

  private result(id: string, ok: boolean, outputPath?: string, message?: string, needsDownload?: boolean): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("convert:result", { id, ok, outputPath, message, needsDownload });
  }

  private async runRequest(request: ConvertRequest): Promise<void> {
    this.progress(request.id, 1);
    try {
      const ext = extensionOf(request.path);
      const targets = listTargetFormats(ext, this.capabilities());
      const target = targets.find((item) => item.id === request.targetExt);
      if (!target) throw new Error("不支持的目标格式");
      if (target.engine === "office" && !this.officeReady) {
        this.result(request.id, false, undefined, "需先下载文档转换组件", true);
        return;
      }
      const output = await this.convertOne(request.path, request.targetExt, request, (p) =>
        this.progress(request.id, p),
      );
      this.progress(request.id, 100);
      this.result(request.id, true, output);
    } catch (error) {
      this.result(
        request.id,
        false,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Resolve the output path and run the appropriate engine for one file. */
  private async convertOne(
    filePath: string,
    targetExt: string,
    request?: ConvertRequest,
    onProgress?: (percent: number) => void,
  ): Promise<string> {
    const ext = extensionOf(filePath);
    const category = categoryForExtension(ext);
    if (!category) throw new Error("不支持的源文件类型");
    const target = listTargetFormats(ext, this.capabilities()).find((t) => t.id === targetExt);
    if (!target) throw new Error("不支持的目标格式");

    const dir = request?.outputDir ?? path.dirname(filePath);
    const output = resolveOutputPath(dir, stemOf(filePath), targetExt, (c) => existsSync(c));

    switch (target.engine) {
      case "image": {
        const stats = await stat(filePath);
        if (stats.size > MAX_IMAGE_BYTES) throw new Error("图片文件过大（上限 120 MB）");
        onProgress?.(30);
        await convertImage(filePath, output, targetExt, {
          quality: request?.quality,
          icoSizes: request?.icoSizes,
        });
        break;
      }
      case "data":
        onProgress?.(40);
        await this.runData(filePath, ext, targetExt, output);
        break;
      case "pdf":
        onProgress?.(30);
        await this.runPdf(filePath, ext, output, onProgress);
        break;
      case "office":
        if (!this.officeReady) throw new Error("需先下载文档转换组件");
        onProgress?.(20);
        await this.office.convert(officeCategory(category), filePath, output, targetExt);
        break;
      default:
        throw new Error("未知的转换引擎");
    }
    return output;
  }

  // --- Data (pure) --------------------------------------------------------

  private async runData(filePath: string, ext: string, targetExt: string, output: string): Promise<void> {
    const text = (await readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
    let result: string;
    if (ext === "json") {
      const parsed = JSON.parse(text);
      if (targetExt === "yaml") result = jsonToYaml(parsed);
      else if (targetExt === "csv") result = jsonToCsv(parsed);
      else if (targetExt === "xml") result = jsonToXml(parsed);
      else throw new Error("不支持的目标格式");
    } else if (ext === "yaml" || ext === "yml") {
      result = `${JSON.stringify(parseYaml(text), null, 2)}\n`;
    } else if (ext === "csv") {
      result = `${JSON.stringify(csvToJson(text), null, 2)}\n`;
    } else if (ext === "md" || ext === "markdown") {
      result = markdownToHtml(text, stemOf(filePath));
    } else {
      throw new Error("不支持的数据转换");
    }
    await writeFile(output, result, "utf8");
  }

  // --- PDF (hidden window printToPDF) ------------------------------------

  private async runPdf(
    filePath: string,
    ext: string,
    output: string,
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    const html = await this.buildPdfHtml(filePath, ext);
    onProgress?.(50);
    const pdfWindow = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, javascript: false },
    });
    try {
      await pdfWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      onProgress?.(80);
      const pdf = await pdfWindow.webContents.printToPDF({ printBackground: true });
      await writeFile(output, pdf);
    } finally {
      if (!pdfWindow.isDestroyed()) pdfWindow.close();
    }
  }

  private async buildPdfHtml(filePath: string, ext: string): Promise<string> {
    if (ext === "html" || ext === "htm") return readFile(filePath, "utf8");
    if (ext === "md" || ext === "markdown") {
      const text = (await readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
      return markdownToHtml(text, stemOf(filePath));
    }
    if (ext === "txt") {
      const text = (await readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return [
        "<!doctype html><html><head><meta charset='UTF-8'><style>",
        "body{font-family:'Consolas','Microsoft YaHei',monospace;white-space:pre-wrap;",
        "word-break:break-word;padding:32px;line-height:1.6;font-size:13px;}",
        "</style></head><body>",
        escaped,
        "</body></html>",
      ].join("");
    }
    // Image -> full-page image. Transcode bmp/ico/tiff to png so <img> renders.
    let dataUrl: string;
    if (ext === "bmp" || ext === "ico" || ext === "tiff" || ext === "tif") {
      const png = await imageToPngBuffer(filePath);
      dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    } else {
      const buffer = await readFile(filePath);
      const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
      dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
    }
    return [
      "<!doctype html><html><head><meta charset='UTF-8'><style>",
      "@page{margin:0;}html,body{margin:0;padding:0;}img{display:block;max-width:100%;}",
      "</style></head><body>",
      `<img src="${dataUrl}">`,
      "</body></html>",
    ].join("");
  }

  // --- Office download flow ----------------------------------------------

  private async downloadOffice(): Promise<{ ok: boolean; message?: string; cancelled?: boolean }> {
    try {
      await this.office.ensureInstalled((progress) => this.sendDownloadProgress(progress));
      this.officeReady = true;
      this.sendState();
      return { ok: true };
    } catch (error) {
      if (error instanceof DownloadCancelled) return { ok: false, cancelled: true };
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private sendDownloadProgress(progress: DownloadProgress): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("convert:download-progress", progress);
  }

  /** When a preset target needs the office engine, tell the window to prompt. */
  private async maybePromptPreset(targetExt: string): Promise<void> {
    await this.refreshOfficeReady();
    if (this.officeReady) return;
    const ext = targetExt.toLowerCase();
    // Does any seeded file's target with this id use the office engine?
    const needsOffice = this.files.some((file) => {
      const target = listTargetFormats(file.ext, this.capabilities()).find((t) => t.id === ext);
      return target?.engine === "office";
    });
    if (needsOffice && this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("convert:prompt-download", { target: ext });
    }
  }
}

/** Map a category to the office engine's document class (csv counts as sheet). */
function officeCategory(
  category: ConvertCategory,
): "document" | "spreadsheet" | "presentation" {
  if (category === "document") return "document";
  if (category === "presentation") return "presentation";
  return "spreadsheet"; // spreadsheet or data(csv)
}

/** Order targets by rough usefulness: PDF, DOCX/common office, image, data. */
function sortTargets(targets: TargetFormat[]): TargetFormat[] {
  const rank: Record<string, number> = {
    pdf: 0, docx: 1, xlsx: 2, pptx: 3, odt: 4, ods: 5, odp: 6,
    png: 10, jpg: 11, webp: 12, avif: 13, tiff: 14, gif: 15, bmp: 16, ico: 17,
    html: 20, txt: 21, json: 22, yaml: 23, csv: 24, xml: 25,
  };
  return [...targets].sort((a, b) => (rank[a.id] ?? 50) - (rank[b.id] ?? 50));
}
