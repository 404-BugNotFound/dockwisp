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
}

interface OcrWorkerWarmupRequest {
  type: "warmup";
  // Optional small sample image used for a one-off priming recognition.
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
        recognition: modelPath("PP-OCRv5_mobile_rec_infer.onnx"),
        charactersDictionary: modelPath("ppocrv5_dict.txt"),
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
