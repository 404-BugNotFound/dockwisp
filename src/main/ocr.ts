import { app, utilityProcess, type UtilityProcess } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";

const OCR_TIMEOUT_MS = 90_000;
// Idle time after the last recognition before the worker is recycled to free
// ONNX Runtime arena memory (a primed worker holds ~450-700 MB, a fresh one
// with only models loaded ~250 MB).
const OCR_RECYCLE_IDLE_MS = 5 * 60_000;
const OCR_MAX_UPSCALED_SIDE = 1_920;
const OCR_UPSCALE_THRESHOLD = 1_400;
const OCR_MODEL_FILES = [
  "PP-OCRv5_mobile_det_infer.onnx",
  "PP-OCRv6_small_rec.ort",
  "ppocrv6_dict.txt",
] as const;

// Matches a single CJK character (unified ideographs, common punctuation and
// full-width forms). PaddleOCR can insert spaces between adjacent ideographs,
// which we strip while leaving spaces inside Latin words untouched.
const CJK = "\\u2e80-\\u2eff\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef";
const SPACE_BETWEEN_CJK = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, "g");
const SPACE_BEFORE_CJK_PUNCT = new RegExp(`[ \\t]+(?=[\\u3000-\\u303f\\uff00-\\uffef])`, "g");

interface OcrWorkerRecognizeRequest {
  type: "recognize";
  id: number;
  imagePath: string;
}

interface OcrWorkerWarmupRequest {
  type: "warmup";
  imagePath?: string;
}

type OcrWorkerRequest = OcrWorkerRecognizeRequest | OcrWorkerWarmupRequest;

interface OcrWorkerResponse {
  type: "result";
  id: number;
  ok: boolean;
  text?: string;
  error?: string;
}

interface PendingOcrRequest {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Clean up raw OCR text: drop spaces inserted between CJK characters and
 * before CJK punctuation, while preserving Latin spaces and line breaks.
 */
export function normalizeOcrText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      let cleaned = line;
      // Run twice: a single pass leaves a space when three ideographs meet
      // because the lookahead character is consumed by the previous match.
      cleaned = cleaned.replace(SPACE_BETWEEN_CJK, "$1");
      cleaned = cleaned.replace(SPACE_BETWEEN_CJK, "$1");
      cleaned = cleaned.replace(SPACE_BEFORE_CJK_PUNCT, "");
      return cleaned.replace(/[ \t]+$/g, "");
    })
    .join("\n")
    .trim();
}

/** Upscale small screenshot regions before OCR without exceeding model input size. */
export function ocrResizeDimensions(
  width: number,
  height: number,
): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const longest = Math.max(width, height);
  if (longest >= OCR_UPSCALE_THRESHOLD) return null;
  const scale = Math.min(2, OCR_MAX_UPSCALED_SIDE / longest);
  if (scale <= 1) return null;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function resolveModelDirectory(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "native", "ocr-models")
    : path.join(process.cwd(), "native", "ocr-models");
}

function assertModelFiles(modelDirectory: string): void {
  const missing = OCR_MODEL_FILES.filter(
    (name) => !existsSync(path.join(modelDirectory, name)),
  );
  if (missing.length > 0) {
    throw new Error(`OCR 模型缺失：${missing.join("、")}`);
  }
}

class PaddleOcrClient {
  private worker: UtilityProcess | null = null;
  private starting: Promise<UtilityProcess> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingOcrRequest>();
  // The worker stays resident for the app's lifetime: a cold start (process
  // spawn + model load) is what made the first OCR after a pause slow. After
  // a period of inactivity it is recycled into a fresh process (models loaded,
  // not yet primed) to release ONNX Runtime arena memory.
  private warmed = false;
  private primed = false;
  private recycleTimer: NodeJS.Timeout | null = null;
  private lifecycleRegistered = false;

  async recognize(imagePath: string): Promise<string> {
    if (!existsSync(imagePath)) throw new Error(`OCR 图片不存在：${imagePath}`);
    this.cancelRecycle();
    const worker = await this.ensureWorker();
    this.primed = true;
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("文字识别超时"));
      }, OCR_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const request: OcrWorkerRecognizeRequest = { type: "recognize", id, imagePath };
        worker.postMessage(request);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Make sure the worker is running with models loaded. With `prime`, also
   * run one throwaway recognition so ONNX Runtime kernels and arenas are hot.
   */
  warmup(prime: boolean): void {
    try {
      const modelDirectory = resolveModelDirectory();
      if (OCR_MODEL_FILES.some((name) => !existsSync(path.join(modelDirectory, name)))) {
        return;
      }
    } catch {
      return;
    }
    const alreadyRunning = this.worker !== null && this.worker.pid !== undefined;
    if (alreadyRunning && this.warmed && (!prime || this.primed)) return;
    this.ensureWorker().then(
      (worker) => {
        try {
          const imagePath = path.join(__dirname, "ocr-warmup.png");
          const request: OcrWorkerWarmupRequest = {
            type: "warmup",
            ...(prime && existsSync(imagePath) ? { imagePath } : {}),
          };
          worker.postMessage(request);
          this.warmed = true;
          if (prime) {
            this.primed = true;
            this.scheduleRecycle();
          }
        } catch {
          // Ignore: a failed warmup must never affect pending requests.
        }
      },
      () => {
        // Ignore worker start failures; recognize() will surface real errors.
      },
    );
  }

  private cancelRecycle(): void {
    if (this.recycleTimer) clearTimeout(this.recycleTimer);
    this.recycleTimer = null;
  }

  private scheduleRecycle(): void {
    this.cancelRecycle();
    this.recycleTimer = setTimeout(() => this.recycle(), OCR_RECYCLE_IDLE_MS);
    this.recycleTimer.unref();
  }

  /** Replace an idle, primed worker with a fresh one that only loads models. */
  private recycle(): void {
    this.recycleTimer = null;
    if (!this.primed || !this.worker) return;
    if (this.pending.size > 0) {
      this.scheduleRecycle();
      return;
    }
    this.stop();
    this.warmup(false);
  }

  private ensureWorker(): Promise<UtilityProcess> {
    if (this.worker && this.worker.pid !== undefined) return Promise.resolve(this.worker);
    if (this.starting) return this.starting;

    const modelDirectory = resolveModelDirectory();
    assertModelFiles(modelDirectory);
    if (!this.lifecycleRegistered) {
      this.lifecycleRegistered = true;
      app.once("before-quit", () => this.stop());
    }

    const child = utilityProcess.fork(path.join(__dirname, "ocr-worker.js"), [], {
      env: { ...process.env, DOCKWISP_OCR_MODEL_DIR: modelDirectory },
      serviceName: "Dockwisp OCR",
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.worker = child;
    child.on("message", (message: unknown) => this.handleMessage(message));
    child.stderr?.on("data", (data) => {
      const detail = String(data).trim();
      if (detail) console.error(`[Dockwisp OCR] ${detail}`);
    });
    child.on("exit", (code) => this.handleExit(child, code));

    const starting = new Promise<UtilityProcess>((resolve, reject) => {
      child.once("spawn", () => resolve(child));
      child.once("exit", (code) => reject(new Error(`OCR 进程启动失败（代码 ${code}）`)));
    });
    this.starting = starting;
    const clearStarting = () => {
      if (this.starting === starting) this.starting = null;
    };
    void starting.then(clearStarting, clearStarting);
    return starting;
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const response = message as Partial<OcrWorkerResponse>;
    if (response.type !== "result" || typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(normalizeOcrText(response.text ?? ""));
    else pending.reject(new Error(response.error || "文字识别失败"));
    if (this.pending.size === 0) this.scheduleRecycle();
  }

  private handleExit(child: UtilityProcess, code: number): void {
    if (this.worker !== child) return;
    this.worker = null;
    this.warmed = false;
    this.primed = false;
    this.cancelRecycle();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`OCR 进程已退出（代码 ${code}）`));
    }
    this.pending.clear();
  }

  private stop(): void {
    this.cancelRecycle();
    this.worker?.kill();
    this.worker = null;
    this.warmed = false;
    this.primed = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("OCR 进程已停止"));
    }
    this.pending.clear();
  }
}

const paddleOcr = new PaddleOcrClient();

/** Recognize one local image using the bundled offline PP-OCRv5 models. */
export function recognizeImageFile(imagePath: string): Promise<string> {
  return paddleOcr.recognize(imagePath);
}

/**
 * Keep the resident OCR worker ready. `prime` (used when the screenshot
 * overlay opens) also runs one throwaway recognition so the user's first real
 * recognition is fast; without it (app startup) only the models are loaded.
 * Idempotent and never throws: missing models return silently; a crashed
 * worker is restarted.
 */
export function warmupOcr(prime = true): void {
  paddleOcr.warmup(prime);
}
