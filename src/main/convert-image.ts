import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import {
  decodeBmp,
  decodeIcoDib,
  encodeBmp,
  encodeIco,
  extensionOf,
  ICO_SIZES,
  readIco,
  sharpCanDecode,
  type RawImage,
} from "../core/file-convert";

export interface ImageConvertOptions {
  /** 0.1–1.0 for jpg/webp/avif; ignored otherwise. */
  quality?: number;
  /** Icon sizes for ICO output; defaults to all of ICO_SIZES. */
  icoSizes?: number[];
}

/**
 * Build a sharp instance for the source file, decoding bmp/ico ourselves (sharp
 * cannot read them) into raw RGBA first. gif/svg/etc. are handled natively;
 * animated inputs collapse to the first frame (sharp's default).
 */
async function loadSharp(input: string): Promise<sharp.Sharp> {
  const ext = extensionOf(input);
  if (ext === "bmp") {
    const raw = decodeBmp(new Uint8Array(await readFile(input)));
    return sharpFromRaw(raw);
  }
  if (ext === "ico") {
    const images = readIco(new Uint8Array(await readFile(input)));
    const best = images[0]; // largest
    if (best.isPng) {
      return sharp(Buffer.from(best.bytes));
    }
    const raw = decodeIcoDib(best.bytes);
    return sharpFromRaw(raw);
  }
  if (!sharpCanDecode(ext)) {
    throw new Error(`sharp 无法解码 .${ext}`);
  }
  // `animated:false` keeps only the first frame for gif/webp inputs.
  return sharp(await readFile(input), { animated: false });
}

function sharpFromRaw(raw: RawImage): sharp.Sharp {
  return sharp(Buffer.from(raw.data), {
    raw: { width: raw.width, height: raw.height, channels: 4 },
  });
}

/** Clamp a 0.1–1.0 quality to the 1–100 integer sharp expects. */
function qualityPercent(quality: number | undefined, fallback: number): number {
  if (typeof quality !== "number" || !Number.isFinite(quality)) return fallback;
  return Math.max(1, Math.min(100, Math.round(quality * 100)));
}

/**
 * Convert an image file to `output` in `targetExt`. png/jpg/webp/avif/tiff/gif
 * go through sharp's encoders; bmp and ico are produced with our own encoders
 * fed by sharp's raw/png output.
 */
export async function convertImage(
  input: string,
  output: string,
  targetExt: string,
  options: ImageConvertOptions = {},
): Promise<void> {
  const ext = targetExt.toLowerCase();
  const image = await loadSharp(input);

  if (ext === "bmp") {
    const { data, info } = await image
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const bmp = encodeBmp(new Uint8Array(data), info.width, info.height);
    await writeFile(output, Buffer.from(bmp));
    return;
  }

  if (ext === "ico") {
    const sizes = (options.icoSizes && options.icoSizes.length ? options.icoSizes : [...ICO_SIZES])
      .map((n) => Math.round(n))
      .filter((n) => n >= 8 && n <= 256)
      .sort((a, b) => a - b);
    const entries = [];
    for (const size of sizes.length ? sizes : [32]) {
      const png = await image
        .clone()
        .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      entries.push({ width: size, height: size, png: new Uint8Array(png) });
    }
    const ico = encodeIco(entries);
    await writeFile(output, Buffer.from(ico));
    return;
  }

  let pipeline = image;
  switch (ext) {
    case "png":
      pipeline = pipeline.png();
      break;
    case "jpg":
    case "jpeg":
      // JPEG has no alpha; flatten onto white.
      pipeline = pipeline
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: qualityPercent(options.quality, 90) });
      break;
    case "webp":
      pipeline = pipeline.webp({ quality: qualityPercent(options.quality, 90) });
      break;
    case "avif":
      pipeline = pipeline.avif({ quality: qualityPercent(options.quality, 60) });
      break;
    case "tiff":
    case "tif":
      pipeline = pipeline.tiff();
      break;
    case "gif":
      pipeline = pipeline.gif();
      break;
    default:
      throw new Error(`不支持的图片目标格式：${ext}`);
  }
  await pipeline.toFile(output);
}

/** Decode any supported image to a PNG data URL (for the UI preview/pdf). */
export async function imageToPngBuffer(input: string): Promise<Buffer> {
  const image = await loadSharp(input);
  return image.png().toBuffer();
}
