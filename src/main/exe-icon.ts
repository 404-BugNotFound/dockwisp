import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { nativeImage, type NativeImage } from "electron";
import { decodeIconImage, pickIconImage, readPeIconGroup } from "../core/pe-icon";

const PE_EXTENSIONS = new Set([".exe", ".dll"]);
/** Rendered size: the launcher shows 40px icons, so 64px stays sharp at 150%. */
const ICON_SIZE = 64;

export function hasPeIcon(filePath: string): boolean {
  return PE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Load the icon embedded in an .exe/.dll as a NativeImage, or `undefined` when
 * the file has no readable icon resource. Only the headers and icon resources
 * are read from disk.
 */
export function loadPeIcon(filePath: string, iconIndex = 0): NativeImage | undefined {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    const entries = readPeIconGroup((offset, length) => {
      const buffer = Buffer.alloc(length);
      const bytesRead = readSync(fd, buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    }, iconIndex);
    const entry = pickIconImage(entries, ICON_SIZE);
    if (!entry) return undefined;
    const decoded = decodeIconImage(entry.data);
    if (!decoded) return undefined;
    let image =
      decoded.kind === "png"
        ? nativeImage.createFromBuffer(decoded.data)
        : nativeImage.createFromBitmap(decoded.bgra, {
            width: decoded.width,
            height: decoded.height,
          });
    if (image.isEmpty()) return undefined;
    const size = image.getSize();
    if (size.width > ICON_SIZE || size.height > ICON_SIZE) {
      image = image.resize({ width: ICON_SIZE, height: ICON_SIZE, quality: "best" });
    }
    return image;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}
