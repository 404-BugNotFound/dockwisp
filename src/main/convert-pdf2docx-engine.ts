import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DownloadCancelled, moveFile, runProcess, writeChunk, type DownloadProgress } from "./convert-office-engine";

/**
 * Pinned PDF -> Word runtime: the official embeddable CPython plus the wheels
 * pdf2docx needs. Each file is downloaded on first use, checked against its
 * SHA-256 and unpacked with tar.exe; pip is never run. Versions, URLs and
 * hashes were read from python.org and PyPI on 2026-11-04.
 */
const PYTHON = {
  version: "3.14.10",
  url: "https://www.python.org/ftp/python/3.14.10/python-3.14.10-embed-amd64.zip",
  sha256: "90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159",
  size: 12_619_664,
  pth: "python314._pth",
  zip: "python314.zip",
} as const;

const PYPI = "https://files.pythonhosted.org/packages";
const WHEELS = [
  { url: `${PYPI}/71/4d/4041fddff079a2cd0c87612afe74a16d2cf032b2aa73ecddbc6bca2a04fe/pdf2docx-0.5.13-py3-none-any.whl`, sha256: "a293e9e78d89b12a4a43fcefba1346de220681c3daf20b8a7d3e1fce77f0fe97", size: 123_863 },
  { url: `${PYPI}/4a/61/d563bbccba262f9dd6d2d35ccb72593648184d886188efb12d9ce8f34dd6/pymupdf-1.28.2-cp310-abi3-win_amd64.whl`, sha256: "ebd244918798502d7b4504c90410d1711a4d7675a32584ca30f1bab419ecbffe", size: 19_826_532 },
  { url: `${PYPI}/d0/00/1e03a4989fa5795da308cd774f05b704ace555a70f9bf9d3be057b680bcf/python_docx-1.2.0-py3-none-any.whl`, sha256: "3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7", size: 252_987 },
  { url: `${PYPI}/0f/bc/5811cc73cac05e324e05ba9b0924e1a163a317a167ede8a9c748b11db30a/lxml-6.1.3-cp314-cp314-win_amd64.whl`, sha256: "66299564c046bc7e0cc5de5106601eae907e9fa5904cd68a323380a8502f7861", size: 4_073_951 },
  { url: `${PYPI}/96/41/c9ca629ffe1b883c1422540a8a11a4ea09616366ab585ab4ee9833f2cd75/fonttools-4.68.0-cp314-cp314-win_amd64.whl`, sha256: "1782f2cf952eb262c4126b1f57b5f0e027e71bf2b632350a033dec526f448428", size: 2_536_130 },
  { url: `${PYPI}/52/9a/e1e512ebc948d5b9dd33b08736760f0ebbed2848fd4eda1f553088a6dcee/numpy-2.5.4-cp314-cp314-win_amd64.whl`, sha256: "2ca144f15135b6212a5c47b1e2aeca6e412f102f95a2d5d88d8aec77eb255de3", size: 12_703_552 },
  { url: `${PYPI}/4a/90/b338326131ccb2aaa3c2c85d00f41822c0050139a4bfe723cfd95455bd2d/opencv_python_headless-4.13.0.92-cp37-abi3-win_amd64.whl`, sha256: "77a82fe35ddcec0f62c15f2ba8a12ecc2ed4207c17b0902c7a3151ae29f37fb6", size: 40_070_414 },
  { url: `${PYPI}/e5/4c/93d0f85318da65923e4b91c1c2ff03d8a458cbefebe3bc612a6693c7906d/fire-0.7.1-py3-none-any.whl`, sha256: "e43fd8a5033a9001e7e2973bab96070694b9f12f2e0ecf96d4683971b5ab1882", size: 115_945 },
  { url: `${PYPI}/33/d1/8bb87d21e9aeb323cc03034f5eaf2c8f69841e40e4853c2627edf8111ed3/termcolor-3.3.0-py3-none-any.whl`, sha256: "cf642efadaf0a8ebbbf4bc7a31cec2f9b5f21a9f726f4ccbb08192c9c26f43a5", size: 7_734 },
  { url: `${PYPI}/49/d3/b8441a820a491ddfc024b0b0cf0393375b75ea13866d9c66727e54c2fc80/typing_extensions-4.16.0-py3-none-any.whl`, sha256: "481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8", size: 45_571 },
] as const;

const FILES = [{ ...PYTHON, kind: "python" as const }, ...WHEELS.map((w) => ({ ...w, kind: "wheel" as const }))];
const TOTAL_BYTES = FILES.reduce((sum, file) => sum + file.size, 0);

/** Bumped whenever the pinned file set changes, to force a reinstall. */
const ENGINE_VERSION = "pdf2docx-0.5.13+py3.14.10";

export const PDF2DOCX = {
  version: "0.5.13",
  approxSizeMb: Math.round(TOTAL_BYTES / 1024 / 1024),
} as const;

const USER_AGENT = "Dockwisp/0.1 (+https://dockwisp.cn) pdf2docx-fetch";
const ANALYZE_TIMEOUT_MS = 120_000;
const CONVERT_TIMEOUT_MS = 600_000;

export interface ScannedPage {
  index: number;
  image: string;
  imageWidth: number;
  imageHeight: number;
}

export interface OcrPage extends ScannedPage {
  lines: Array<{ text: string; box: { x: number; y: number; width: number; height: number } }>;
}

export interface Pdf2DocxHooks {
  /** OCR one rendered scanned page; returns lines in the image's pixels. */
  ocr: (page: ScannedPage) => Promise<OcrPage["lines"]>;
  onProgress?: (percent: number) => void;
}

/**
 * Owns the on-demand pdf2docx runtime under `<userData>/engines/pdf2docx`.
 * Conversion: the helper script renders scanned pages, Dockwisp's own
 * PaddleOCR reads them, the helper rebuilds those pages with real text and
 * pdf2docx writes the docx.
 */
export class Pdf2DocxEngine {
  private readonly installDir: string;
  private readonly downloadDir: string;
  private readonly markerPath: string;
  private readonly pythonPath: string;
  private ready = false;
  private queue: Promise<unknown> = Promise.resolve();
  private activeDownload: { cancel: () => void } | null = null;

  constructor(userDataDir: string, private readonly scriptPath: string) {
    const root = path.join(userDataDir, "engines");
    this.installDir = path.join(root, "pdf2docx");
    this.downloadDir = path.join(root, "pdf2docx-download");
    this.markerPath = path.join(this.installDir, ".dockwisp-version");
    this.pythonPath = path.join(this.installDir, "python.exe");
  }

  async isReady(): Promise<boolean> {
    if (this.ready) return true;
    try {
      const marker = (await readFile(this.markerPath, "utf8")).trim();
      if (marker !== ENGINE_VERSION) return false;
      await stat(this.pythonPath);
      this.ready = true;
    } catch {
      this.ready = false;
    }
    return this.ready;
  }

  cancel(): void {
    this.activeDownload?.cancel();
  }

  async ensureInstalled(onProgress: (progress: DownloadProgress) => void): Promise<void> {
    if (await this.isReady()) {
      onProgress({ phase: "done", percent: 100 });
      return;
    }
    await rm(this.downloadDir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(this.downloadDir, { recursive: true });
    const controller = new AbortController();
    this.activeDownload = { cancel: () => controller.abort() };
    const downloaded: Array<{ file: string; kind: "python" | "wheel" }> = [];
    try {
      let received = 0;
      for (const item of FILES) {
        const file = path.join(this.downloadDir, item.url.slice(item.url.lastIndexOf("/") + 1));
        received = await this.download(item.url, file, controller.signal, received, onProgress);
        await verifySha256(file, item.sha256);
        downloaded.push({ file, kind: item.kind });
      }
    } catch (error) {
      if (controller.signal.aborted) throw new DownloadCancelled();
      throw error;
    } finally {
      this.activeDownload = null;
    }

    onProgress({ phase: "unpack", percent: 0 });
    await rm(this.installDir, { recursive: true, force: true }).catch(() => undefined);
    const sitePackages = path.join(this.installDir, "Lib", "site-packages");
    await mkdir(sitePackages, { recursive: true });
    for (const item of downloaded) {
      const target = item.kind === "python" ? this.installDir : sitePackages;
      const result = await runProcess("tar.exe", ["-xf", item.file, "-C", target], 300_000);
      if (result.code !== 0) {
        throw new Error(`解包失败：${path.basename(item.file)}（tar 退出码 ${result.code}）`);
      }
    }
    // The embeddable build ignores PYTHONPATH and site; its ._pth file is the
    // whole import path.
    await writeFile(
      path.join(this.installDir, PYTHON.pth),
      `${PYTHON.zip}\n.\nLib\\site-packages\n`,
      "utf8",
    );
    await this.installScript();
    await writeFile(this.markerPath, ENGINE_VERSION, "utf8");
    await rm(this.downloadDir, { recursive: true, force: true }).catch(() => undefined);
    this.ready = true;
    onProgress({ phase: "done", percent: 100 });
  }

  private async download(
    url: string,
    file: string,
    signal: AbortSignal,
    receivedBefore: number,
    onProgress: (progress: DownloadProgress) => void,
  ): Promise<number> {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
    let received = receivedBefore;
    const stream = createWriteStream(file);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.length;
        await writeChunk(stream, value);
        onProgress({
          phase: "download",
          received,
          total: TOTAL_BYTES,
          percent: Math.min(100, Math.round((received / TOTAL_BYTES) * 100)),
        });
      }
    } finally {
      stream.end();
      await new Promise<void>((resolve) => stream.on("close", () => resolve()));
    }
    return received;
  }

  /** Convert one PDF to docx (serialised: one Python process at a time). */
  convert(input: string, output: string, hooks: Pdf2DocxHooks): Promise<void> {
    const task = this.queue.then(() => this.runConvert(input, output, hooks));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async runConvert(input: string, output: string, hooks: Pdf2DocxHooks): Promise<void> {
    if (!(await this.isReady())) throw new Error("PDF 转换组件尚未下载");
    // Keep the helper in sync with the app version that is running.
    const script = await this.installScript();
    const workDir = await mkdtemp(path.join(tmpdir(), "dockwisp-p2d-"));
    try {
      hooks.onProgress?.(5);
      const analyzed = await this.python([script, "analyze", input, workDir], ANALYZE_TIMEOUT_MS);
      const info = parseLastJson(analyzed) as { pages?: number; scanned?: ScannedPage[] } | null;
      const scanned = Array.isArray(info?.scanned) ? info.scanned : [];

      // OCR spans 10-40%, conversion 40-95%.
      const ocrPages: OcrPage[] = [];
      for (let i = 0; i < scanned.length; i += 1) {
        const page = scanned[i];
        const lines = await hooks.ocr(page);
        ocrPages.push({ ...page, lines });
        hooks.onProgress?.(10 + Math.round(((i + 1) / scanned.length) * 30));
      }
      const args = [script, "convert", input, path.join(workDir, "out.docx")];
      if (ocrPages.some((page) => page.lines.length > 0)) {
        const ocrPath = path.join(workDir, "ocr.json");
        await writeFile(ocrPath, JSON.stringify(ocrPages), "utf8");
        args.push(ocrPath);
      }
      await this.python(args, CONVERT_TIMEOUT_MS, (done, total) => {
        hooks.onProgress?.(40 + Math.round((done / Math.max(1, total)) * 55));
      });
      await moveFile(path.join(workDir, "out.docx"), output);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Render every page of `input` into `outDir` as page-001.png/jpg at 150 DPI
   * (serialised with conversions). Returns the folder.
   */
  renderPages(
    input: string,
    outDir: string,
    format: "png" | "jpg",
    onProgress?: (percent: number) => void,
  ): Promise<string> {
    const task = this.queue.then(async () => {
      if (!(await this.isReady())) throw new Error("PDF 转换组件尚未下载");
      const script = await this.installScript();
      await mkdir(outDir, { recursive: true });
      onProgress?.(5);
      await this.python([script, "render", input, outDir, format], CONVERT_TIMEOUT_MS, (done, total) => {
        onProgress?.(5 + Math.round((done / Math.max(1, total)) * 90));
      });
      return outDir;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** Copy the helper script out of the app (it may live inside app.asar). */
  private async installScript(): Promise<string> {
    const target = path.join(this.installDir, "dockwisp_pdf2docx.py");
    await writeFile(target, await readFile(this.scriptPath));
    return target;
  }

  private async python(
    args: string[],
    timeoutMs: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<string> {
    let buffered = "";
    const result = await runProcess(this.pythonPath, ["-X", "utf8", "-u", ...args], timeoutMs, this.installDir, {
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      onStdout: (chunk) => {
        if (!onProgress) return;
        buffered += chunk;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const match = /^PROGRESS (\d+) (\d+)$/.exec(line.trim());
          if (match) onProgress(Number(match[1]), Number(match[2]));
        }
      },
    });
    if (result.code !== 0) {
      throw new Error(`PDF 转 Word 失败：${lastErrorLine(result.stderr) || `退出码 ${result.code}`}`);
    }
    return result.stdout;
  }
}

async function verifySha256(file: string, expected: string): Promise<void> {
  const digest = createHash("sha256").update(await readFile(file)).digest("hex");
  if (digest.toLowerCase() !== expected.toLowerCase()) {
    await rm(file, { force: true }).catch(() => undefined);
    throw new Error(`下载文件校验失败（SHA-256 不匹配）：${path.basename(file)}`);
  }
}

function parseLastJson(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep looking
    }
  }
  return null;
}

/** The useful part of a Python traceback / SystemExit message. */
function lastErrorLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("warning:") && !line.startsWith("[INFO]"));
  return lines.at(-1) ?? "";
}
