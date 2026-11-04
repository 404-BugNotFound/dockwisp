import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PaddleOcrService as PaddleOcrServiceType } from "ppu-paddle-ocr" with {
  "resolution-mode": "import",
};

interface OcrWorkerRecognizeRequest {
  type: "recognize";
  id: number;
  imagePath: string;
  // When true the response also carries per-line boxes in image coordinates.
  layout?: boolean;
}

interface OcrWorkerWarmupRequest {
  type: "warmup";
  // Optional small sample image used for a one-off priming recognition.
  imagePath?: string;
}

type OcrWorkerRequest = OcrWorkerRecognizeRequest | OcrWorkerWarmupRequest;

interface OcrWorkerLine {
  text: string;
  box: { x: number; y: number; width: number; height: number };
}

interface OcrWorkerResponse {
  type: "result";
  id: number;
  ok: boolean;
  text?: string;
  // Present only when the request asked for layout.
  lines?: OcrWorkerLine[];
  error?: string;
}

const parentPort = process.parentPort;
if (!parentPort) throw new Error("OCR worker requires an Electron parent port");

let servicePromise: Promise<PaddleOcrServiceType> | null = null;
let primed = false;
let queue = Promise.resolve();

function modelPath(name: string): string {
  const directory = process.env.DOCKWISP_OCR_MODEL_DIR;
  if (!directory) throw new Error("OCR 模型目录未配置");
  return path.join(directory, name);
}

async function getService(): Promise<PaddleOcrServiceType> {
  if (servicePromise) return servicePromise;
  servicePromise = (async () => {
    const { PaddleOcrService } = await import("ppu-paddle-ocr");
    const intraOpNumThreads = Math.max(1, Math.min(os.availableParallelism() - 1, 8));
    const service = new PaddleOcrService({
      model: {
        detection: modelPath("PP-OCRv5_mobile_det_infer.onnx"),
        recognition: modelPath("PP-OCRv6_small_rec.ort"),
        charactersDictionary: modelPath("ppocrv6_dict.txt"),
      },
      processing: { engine: "opencv" },
      detection: {
        maxSideLength: 1_920,
        minimumAreaThreshold: 4,
      },
      recognition: {
        charactersDictionary: [],
        minimumConfidence: 0.3,
        strategy: "per-line",
        recBatchSize: 6,
        maxCropSourceSideLength: 2_400,
      },
      session: {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
        intraOpNumThreads,
      },
    });
    await service.initialize();
    return service;
  })();
  try {
    return await servicePromise;
  } catch (error) {
    servicePromise = null;
    throw error;
  }
}

async function recognize(request: OcrWorkerRecognizeRequest): Promise<void> {
  try {
    const image = await readFile(request.imagePath);
    const arrayBuffer = image.buffer.slice(
      image.byteOffset,
      image.byteOffset + image.byteLength,
    ) as ArrayBuffer;
    const service = await getService();
    const result = await service.recognize(arrayBuffer, { noCache: true });
    const response: OcrWorkerResponse = {
      type: "result",
      id: request.id,
      ok: true,
      text: result.text,
    };
    if (request.layout) {
      // Each grouped line is a list of left-to-right items; merge them into one
      // line box (union) with the item texts space-joined. "lines" exists on the
      // grouped PaddleOcrResult shape returned when flatten is not requested.
      const grouped = (result as { lines?: Array<Array<{ text: string; box: { x: number; y: number; width: number; height: number } }>> }).lines ?? [];
      response.lines = grouped
        .map((items) => mergeLine(items))
        .filter((line): line is OcrWorkerLine => line !== null);
    }
    parentPort.postMessage(response);
  } catch (error) {
    const response: OcrWorkerResponse = {
      type: "result",
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    parentPort.postMessage(response);
  }
}

/** Merge one detected line's items into a single box (union) and joined text. */
function mergeLine(
  items: Array<{ text: string; box: { x: number; y: number; width: number; height: number } }>,
): OcrWorkerLine | null {
  if (items.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const item of items) {
    left = Math.min(left, item.box.x);
    top = Math.min(top, item.box.y);
    right = Math.max(right, item.box.x + item.box.width);
    bottom = Math.max(bottom, item.box.y + item.box.height);
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  const text = items.map((item) => item.text).join(" ");
  return {
    text,
    box: { x: left, y: top, width: right - left, height: bottom - top },
  };
}

parentPort.on("message", (event) => {
  const request = event.data as Partial<OcrWorkerRequest>;
  if (request.type === "warmup") {
    const warmupImagePath = (request as Partial<OcrWorkerWarmupRequest>).imagePath;
    queue = queue.then(async () => {
      try {
        const service = await getService();
        // A throwaway recognition primes ONNX Runtime kernels and memory arenas
        // so the user's first real recognition does not pay for them.
        if (typeof warmupImagePath === "string" && !primed) {
          primed = true;
          const image = await readFile(warmupImagePath);
          const arrayBuffer = image.buffer.slice(
            image.byteOffset,
            image.byteOffset + image.byteLength,
          ) as ArrayBuffer;
          await service.recognize(arrayBuffer, { noCache: true });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`OCR warmup failed: ${detail}\n`);
      }
    });
    return;
  }
  if (
    request.type !== "recognize" ||
    typeof request.id !== "number" ||
    typeof request.imagePath !== "string"
  ) {
    return;
  }
  queue = queue.then(() => recognize(request as OcrWorkerRecognizeRequest));
});
