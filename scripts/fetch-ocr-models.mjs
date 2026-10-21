import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { OCR_MODEL_BASE, OCR_MODEL_FILES } from "./ocr-model-manifest.mjs";
import { sha256File } from "./ocr-model-utils.mjs";

const modelDirectory = path.join("native", "ocr-models");
await mkdir(modelDirectory, { recursive: true });

async function isValid(target, model) {
  try {
    const details = await stat(target);
    return details.size === model.bytes && (await sha256File(target)) === model.sha256;
  } catch {
    return false;
  }
}

for (const model of OCR_MODEL_FILES) {
  const target = path.join(modelDirectory, model.name);
  if (await isValid(target, model)) {
    console.log(`OCR model ready: ${model.name}`);
    continue;
  }

  const temporary = `${target}.download`;
  await rm(temporary, { force: true });
  const url = `${OCR_MODEL_BASE}/${model.source}`;
  console.log(`Downloading ${model.name}...`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`下载失败 ${response.status}: ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  if (!(await isValid(temporary, model))) {
    await rm(temporary, { force: true });
    throw new Error(`${model.name} 下载完成但校验失败`);
  }
  await rm(target, { force: true });
  await rename(temporary, target);
  console.log(`OCR model installed: ${model.name}`);
}
