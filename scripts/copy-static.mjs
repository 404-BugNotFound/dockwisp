import { copyFile, cp, mkdir } from "node:fs/promises";

await mkdir("dist/renderer", { recursive: true });
await cp("src/renderer", "dist/renderer", { recursive: true });
await mkdir("dist/main", { recursive: true });
await copyFile("src/main/ocr-warmup.png", "dist/main/ocr-warmup.png");
