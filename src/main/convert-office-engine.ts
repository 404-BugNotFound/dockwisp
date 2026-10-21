import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
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
import { stemOf } from "../core/file-convert";

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
   * The LibreOffice `--convert-to` filter plus an optional `--infilter`. pdf ->
   * docx must force the Writer PDF import filter on the input side, otherwise
   * LibreOffice opens the PDF in Draw and cannot save as a Word document.
   */
  private filterFor(
    category: "document" | "spreadsheet" | "presentation",
    sourceExt: string,
    targetExt: string,
  ): { convertTo: string; inFilter?: string } {
    const ext = targetExt.toLowerCase();
    if (sourceExt === "pdf" && ext === "docx") {
      return { convertTo: "docx:MS Word 2007 XML", inFilter: "writer_pdf_import" };
    }
    if (ext === "pdf") return { convertTo: "pdf" };
    if (category === "document") {
      if (ext === "docx") return { convertTo: "docx:MS Word 2007 XML" };
      if (ext === "odt") return { convertTo: "odt" };
      if (ext === "txt") return { convertTo: "txt:Text" };
      if (ext === "html") return { convertTo: "html:HTML (StarWriter)" };
    }
    if (category === "spreadsheet") {
      if (ext === "xlsx") return { convertTo: "xlsx:Calc MS Excel 2007 XML" };
      if (ext === "ods") return { convertTo: "ods" };
      if (ext === "csv") return { convertTo: "csv:Text - txt - csv (StarCalc)" };
    }
    if (category === "presentation") {
      if (ext === "pptx") return { convertTo: "pptx:Impress MS PowerPoint 2007 XML" };
      if (ext === "odp") return { convertTo: "odp" };
    }
    return { convertTo: ext };
  }

  /**
   * Convert `input` to `output` (serialised). `--convert-to` writes into an
   * output dir using the source stem, so we convert into a temp dir then move
   * the produced file to the requested path.
   */
  convert(
    category: "document" | "spreadsheet" | "presentation",
    input: string,
    output: string,
    targetExt: string,
  ): Promise<void> {
    const task = this.queue.then(() => this.runConvert(category, input, output, targetExt));
    // Keep the chain alive even if a task rejects.
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async runConvert(
    category: "document" | "spreadsheet" | "presentation",
    input: string,
    output: string,
    targetExt: string,
  ): Promise<void> {
    if (!this.sofficePath && !(await this.isReady())) {
      throw new Error("文档转换组件尚未下载");
    }
    const soffice = this.sofficePath;
    if (!soffice) throw new Error("未找到 soffice.exe");
    await mkdir(this.profileDir, { recursive: true });
    const workDir = await mkdtemp(path.join(tmpdir(), "dockwisp-lo-"));
    const sourceExt = stemExt(input);
    try {
      const filter = this.filterFor(category, sourceExt, targetExt);
      const args = [
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nologo",
        `-env:UserInstallation=${pathToFileUrl(this.profileDir)}`,
      ];
      if (filter.inFilter) args.push("--infilter=" + filter.inFilter);
      args.push("--convert-to", filter.convertTo, "--outdir", workDir, input);
      // Run from soffice's own program directory so its bundled Python can
      // locate its libraries (the PDF import filter needs this).
      const result = await runProcess(soffice, args, 180_000, path.dirname(soffice));
      if (result.code !== 0) {
        const tail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
        throw new Error(`LibreOffice 转换失败：${tail || result.code}`);
      }
      const produced = await findProduced(workDir, stemOf(input), targetExt);
      if (!produced) throw new Error("LibreOffice 未生成输出文件");
      await moveFile(produced, output);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function stemExt(filePath: string): string {
  const base = filePath.replace(/[\\/]+$/, "");
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function pathToFileUrl(dir: string): string {
  const normalized = dir.replace(/\\/g, "/");
  return `file:///${normalized.replace(/^\/+/, "")}`;
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch {
    const { copyFile, unlink } = await import("node:fs/promises");
    await copyFile(from, to);
    await unlink(from).catch(() => undefined);
  }
}

async function findProduced(dir: string, stem: string, targetExt: string): Promise<string | null> {
  const ext = targetExt.toLowerCase();
  const entries = await readdir(dir).catch(() => [] as string[]);
  const exact = entries.find((name) => name.toLowerCase() === `${stem.toLowerCase()}.${ext}`);
  if (exact) return path.join(dir, exact);
  const anyWithExt = entries.find((name) => name.toLowerCase().endsWith(`.${ext}`));
  return anyWithExt ? path.join(dir, anyWithExt) : null;
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

function writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, cwd });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
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
