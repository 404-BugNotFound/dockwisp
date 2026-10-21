import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PaddleOcrService } from "ppu-paddle-ocr";

const modelDirectory = path.join("native", "ocr-models");
const service = new PaddleOcrService({
  model: {
    detection: path.join(modelDirectory, "PP-OCRv5_mobile_det_infer.onnx"),
    recognition: path.join(modelDirectory, "PP-OCRv5_server_rec_infer.onnx"),
    charactersDictionary: path.join(modelDirectory, "ppocrv5_dict.txt"),
  },
  processing: { engine: "opencv" },
  detection: { maxSideLength: 1_920, minimumAreaThreshold: 4 },
  recognition: {
    charactersDictionary: [],
    minimumConfidence: 0.3,
    strategy: "per-line",
    recBatchSize: 1,
    maxCropSourceSideLength: 2_400,
  },
  session: { executionProviders: ["cpu"], graphOptimizationLevel: "all" },
});

try {
  await service.initialize();
  const image = await readFile(path.join("docs", "images", "translation.png"));
  const input = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength);
  const result = await service.recognize(input, { noCache: true });
  const compact = result.text.replace(/\s+/g, "").toLowerCase();
  assert.match(compact, /helloworld/);
  assert.match(compact, /你好/);
  assert.match(compact, /世界/);
  console.log(`PaddleOCR smoke test passed (confidence=${result.confidence.toFixed(3)})`);
} finally {
  await service.destroy();
}
