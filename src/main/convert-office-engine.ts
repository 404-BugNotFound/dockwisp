import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveOutputPath, stemOf } from "../core/file-convert";

/**
 * Pinned LibreOffice build. Downloaded on first use from the Document
 * Foundation mirror and unpacked (administrative MSI install) into userData.
 * Version, URL and SHA-256 were read from the official mirror on 2026-10-20.
 */
export const LIBREOFFICE = {
  version: "26.8.1",
  fileName: "LibreOffice_26.8.1_Win_x86-64.msi",
  url: "https://download.documentfoundation.org/libreoffice/stable/26.8.1/win/x86_64/LibreOffice_26.8.1_Win_x86-64.msi",
  sha256: "c6298b10cfa1748bcbedad94c62ce771e240e5021bfd6d7a967cd571b04b5312",
  approxSizeMb: 358,
} as const;

const USER_AGENT = "Dockwisp/0.1 (+https://dockwisp.cn) LibreOffice-fetch";

export interface DownloadProgress {
  phase: "download" | "unpack" | "done";
  received?: number;
  total?: number;
  percent?: number;
}

export class DownloadCancelled extends Error {
  constructor() {
    super("已取消下载");
    this.name = "DownloadCancelled";
  }
}

/**
 * Owns the on-demand LibreOffice runtime living under
 * `<userData>/engines/libreoffice`. Handles detection, download+verify+unpack
 * (cancellable), and serialised `soffice --convert-to` invocations.
 */
export class LibreOfficeEngine {
  private readonly root: string;
  private readonly installDir: string;
  private readonly profileDir: string;
  private readonly markerPath: string;
  private readonly downloadDir: string;
  private sofficePath: string | null = null;
  // Serialise conversions: one soffice profile cannot be used concurrently.
  private queue: Promise<unknown> = Promise.resolve();
  private activeDownload: { cancel: () => void } | null = null;

  constructor(userDataDir: string) {
    this.root = path.join(userDataDir, "engines");
    this.installDir = path.join(this.root, "libreoffice");
    this.profileDir = path.join(this.root, "lo-profile");
    this.markerPath = path.join(this.installDir, ".dockwisp-version");
    this.downloadDir = path.join(this.root, "download");
  }

  /** True when a matching LibreOffice build is already unpacked. */
  async isReady(): Promise<boolean> {
    if (this.sofficePath) return true;
    try {
      const marker = (await readFile(this.markerPath, "utf8")).trim();
      if (marker !== LIBREOFFICE.version) return false;
      const soffice = await this.locateSoffice();
      if (soffice) {
        this.sofficePath = soffice;
        return true;
      }
    } catch {
      // Not installed yet.
    }
    return false;
  }

  /** Find soffice.exe within the unpacked tree. */
  private async locateSoffice(): Promise<string | null> {
    const candidates = [
      path.join(this.installDir, "program", "soffice.exe"),
      path.join(this.installDir, "LibreOffice", "program", "soffice.exe"),
    ];
    for (const candidate of candidates) {
      try {
        await stat(candidate);
        return candidate;
      } catch {
        // keep looking
      }
    }
    // Fall back to a shallow search (MSI admin installs may nest differently).
    const found = await findFile(this.installDir, "soffice.exe", 4);
    return found;
  }

  /** Cancel an in-flight download/unpack, if any. */
  cancel(): void {
    this.activeDownload?.cancel();
  }

  /**
   * Ensure LibreOffice is present, downloading and unpacking it when missing.
   * Progress is reported through `onProgress`. Safe to call when already ready
   * (returns immediately). Throws DownloadCancelled when cancelled.
   */
  async ensureInstalled(onProgress: (progress: DownloadProgress) => void): Promise<void> {
    if (await this.isReady()) {
      onProgress({ phase: "done", percent: 100 });
      return;
    }
    await mkdir(this.downloadDir, { recursive: true });
    const msiPath = path.join(this.downloadDir, LIBREOFFICE.fileName);

    await this.download(msiPath, onProgress);
    onProgress({ phase: "unpack", percent: 0 });
    await this.verify(msiPath);
    await this.unpack(msiPath);

    const soffice = await this.locateSoffice();
    if (!soffice) throw new Error("解包后未找到 soffice.exe");
    this.sofficePath = soffice;
    await writeFile(this.markerPath, LIBREOFFICE.version, "utf8");
    await rm(this.downloadDir, { recursive: true, force: true }).catch(() => undefined);
    onProgress({ phase: "done", percent: 100 });
  }

  /** Download the MSI with progress and cancellation (fresh each attempt). */
  private async download(
    msiPath: string,
    onProgress: (progress: DownloadProgress) => void,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeDownload = { cancel: () => controller.abort() };
    try {
      const response = await fetch(LIBREOFFICE.url, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`下载失败：HTTP ${response.status}`);
      }
      const total = Number(response.headers.get("content-length")) || undefined;
      let received = 0;
      const fileStream = createWriteStream(msiPath);
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            received += value.length;
            await writeChunk(fileStream, value);
            onProgress({
              phase: "download",
              received,
              total,
              percent: total ? Math.round((received / total) * 100) : undefined,
            });
          }
        }
      } finally {
        fileStream.end();
        await new Promise<void>((resolve) => fileStream.on("close", () => resolve()));
      }
    } catch (error) {
      await rm(msiPath, { force: true }).catch(() => undefined);
      if (controller.signal.aborted) throw new DownloadCancelled();
      throw error;
    } finally {
      this.activeDownload = null;
    }
  }

  /** Verify the downloaded MSI against the pinned SHA-256. */
  private async verify(msiPath: string): Promise<void> {
    const hash = createHash("sha256");
    hash.update(await readFile(msiPath));
    const digest = hash.digest("hex");
    if (digest.toLowerCase() !== LIBREOFFICE.sha256.toLowerCase()) {
      await rm(msiPath, { force: true }).catch(() => undefined);
      throw new Error("下载文件校验失败（SHA-256 不匹配）");
    }
  }

  /**
   * Administrative install (`msiexec /a`) extracts the payload without needing
   * elevation or touching the registry. TARGETDIR receives the full tree.
   */
  private async unpack(msiPath: string): Promise<void> {
    await rm(this.installDir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(this.installDir, { recursive: true });
    const result = await runProcess(
      "msiexec.exe",
      ["/a", msiPath, "/qn", `TARGETDIR=${this.installDir}`],
      300_000,
    );
    if (result.code !== 0) {
      throw new Error(`解包失败：msiexec 退出码 ${result.code}`);
    }
  }

  /**
   * The LibreOffice `--convert-to` filter string. PDF -> Word is handled by
   * the pdf2docx engine, not here.
   *  - txt / csv: explicit UTF-8 (token 76); csv also writes every sheet as
   *    "<stem>-<sheet>.csv" (token 12 = -1), comma separated, "-quoted.
   *  - html: images embedded as data URIs so the single file is complete.
   *  - spreadsheet pdf with `fitSheets`: each sheet scaled onto one page.
   */
  private filterFor(
    category: "document" | "spreadsheet" | "presentation",
    targetExt: string,
    options: OfficeConvertOptions,
  ): string {
    const ext = targetExt.toLowerCase();
    if (ext === "pdf") {
      if (category === "spreadsheet" && options.fitSheets) {
        return 'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}';
      }
      return "pdf";
    }
    if (category === "document") {
      if (ext === "docx") return "docx:MS Word 2007 XML";
      if (ext === "odt") return "odt";
      if (ext === "txt") return "txt:Text (encoded):UTF8,CRLF,,,";
      if (ext === "html") return "html:XHTML Writer File:UTF8";
    }
    if (category === "spreadsheet") {
      if (ext === "xlsx") return "xlsx:Calc MS Excel 2007 XML";
      if (ext === "ods") return "ods";
      if (ext === "csv") return "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1";
    }
    if (category === "presentation") {
      if (ext === "pptx") return "pptx:Impress MS PowerPoint 2007 XML";
      if (ext === "odp") return "odp";
    }
    return ext;
  }

  /**
   * Convert `input` to `output` (serialised). `--convert-to` writes into an
   * output dir using the source stem, so we convert into a temp dir then move
   * the produced file(s) next to `output`. A multi-sheet CSV export yields one
   * file per sheet ("<output stem>-<sheet>.csv"); all paths are returned.
   */
  convert(
    category: "document" | "spreadsheet" | "presentation",
    input: string,
    output: string,
    targetExt: string,
    options: OfficeConvertOptions = {},
  ): Promise<string[]> {
    const task = this.queue.then(() => this.runConvert(category, input, output, targetExt, options));
    // Keep the chain alive even if a task rejects.
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async runConvert(
    category: "document" | "spreadsheet" | "presentation",
    input: string,
    output: string,
    targetExt: string,
    options: OfficeConvertOptions,
  ): Promise<string[]> {
    if (!this.sofficePath && !(await this.isReady())) {
      throw new Error("文档转换组件尚未下载");
    }
    const soffice = this.sofficePath;
    if (!soffice) throw new Error("未找到 soffice.exe");
    await mkdir(this.profileDir, { recursive: true });
    const workDir = await mkdtemp(path.join(tmpdir(), "dockwisp-lo-"));
    try {
      const args = [
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nologo",
        `-env:UserInstallation=${pathToFileUrl(this.profileDir)}`,
        "--convert-to",
        this.filterFor(category, targetExt, options),
        "--outdir",
        workDir,
        input,
      ];
      // Run from soffice's own program directory so its bundled Python can
      // locate its libraries.
      const result = await runProcess(soffice, args, 180_000, path.dirname(soffice));
      if (result.code !== 0) {
        const tail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
        throw new Error(`LibreOffice 转换失败：${tail || result.code}`);
      }
      const produced = await findProduced(workDir, targetExt);
      if (produced.length === 0) throw new Error("LibreOffice 未生成输出文件");
      if (produced.length === 1) {
        await moveFile(produced[0], output);
        return [output];
      }
      // Several sheets: keep LibreOffice's "-<sheet>" suffix on our stem.
      const sourceStem = stemOf(input);
      const outStem = stemOf(output);
      const outDir = path.dirname(output);
      const moved: string[] = [];
      for (const file of produced) {
        const name = path.basename(file);
        const suffix = name.slice(sourceStem.length, name.length - targetExt.length - 1);
        const target = resolveOutputPath(outDir, `${outStem}${suffix}`, targetExt, (c) => existsSync(c));
        await moveFile(file, target);
        moved.push(target);
      }
      return moved;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export interface OfficeConvertOptions {
  /** Spreadsheet -> PDF: scale each sheet onto a single page. */
  fitSheets?: boolean;
}

function pathToFileUrl(dir: string): string {
  const normalized = dir.replace(/\\/g, "/");
  return `file:///${normalized.replace(/^\/+/, "")}`;
}

export async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch {
    const { copyFile, unlink } = await import("node:fs/promises");
    await copyFile(from, to);
    await unlink(from).catch(() => undefined);
  }
}

/** Every file LibreOffice wrote with the target extension, sorted by name. */
async function findProduced(dir: string, targetExt: string): Promise<string[]> {
  const ext = `.${targetExt.toLowerCase()}`;
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries
    .filter((name) => name.toLowerCase().endsWith(ext))
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }))
    .map((name) => path.join(dir, name));
}

/** Shallow recursive search for a file by name, bounded in depth. */
async function findFile(dir: string, name: string, depth: number): Promise<string | null> {
  if (depth < 0) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findFile(path.join(dir, entry.name), name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

export function writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
  options: { env?: NodeJS.ProcessEnv; onStdout?: (chunk: string) => void } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, cwd, env: options.env });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
