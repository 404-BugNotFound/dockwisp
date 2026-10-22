import { stat } from "node:fs/promises";
import path from "node:path";
import { OCR_MODEL_FILES } from "./ocr-model-manifest.mjs";
import { sha256File } from "./ocr-model-utils.mjs";

const modelDirectory = path.join("native", "ocr-models");
const errors = [];

for (const model of OCR_MODEL_FILES) {
  const target = path.join(modelDirectory, model.name);
  try {
    const details = await stat(target);
    if (details.size !== model.bytes) {
      errors.push(`${model.name}: 大小应为 ${model.bytes}，实际为 ${details.size}`);
      continue;
    }
    const digest = await sha256File(target);
    if (digest !== model.sha256) errors.push(`${model.name}: SHA-256 不匹配`);
  } catch {
    errors.push(`${model.name}: 文件缺失`);
  }
}

if (errors.length > 0) {
  console.error("OCR 模型校验失败：");
  for (const error of errors) console.error(`  - ${error}`);
  console.error("运行 npm run fetch:ocr-models 下载固定版本模型。");
  process.exit(1);
}

console.log("OCR models verified (PP-OCRv5 Mobile detection + Mobile recognition)");
