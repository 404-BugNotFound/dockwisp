import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PaddleOcrService as PaddleOcrServiceType } from "ppu-paddle-ocr" with {
  "resolution-mode": "import",
};

interface OcrWorkerRequest {
  type: "recognize";
  id: number;
  imagePath: string;
}

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
    const service = new PaddleOcrService({
      model: {
        detection: modelPath("PP-OCRv5_mobile_det_infer.onnx"),
        recognition: modelPath("PP-OCRv5_server_rec_infer.onnx"),
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
        recBatchSize: 1,
        maxCropSourceSideLength: 2_400,
      },
      session: {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
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

async function recognize(request: OcrWorkerRequest): Promise<void> {
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
  if (
    request.type !== "recognize" ||
    typeof request.id !== "number" ||
    typeof request.imagePath !== "string"
  ) {
    return;
  }
  queue = queue.then(() => recognize(request as OcrWorkerRequest));
});
