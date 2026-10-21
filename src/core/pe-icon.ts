/**
 * Extract the icon embedded in a Windows PE file (.exe/.dll) without relying on
 * the shell. Electron's `app.getFileIcon` returns the generic program icon for
 * many executables (for example large Electron apps) even though the file
 * carries a proper RT_GROUP_ICON resource; reading the resource directly gives
 * the icon Explorer shows.
 *
 * All parsing goes through a random-access `read` callback so callers only
 * touch the headers and the few resource blocks that are needed, never the
 * whole (possibly hundreds of MB) file.
 */

/** Read `length` bytes at `offset`; may return fewer bytes at end of file. */
export type ByteReader = (offset: number, length: number) => Buffer;

export interface IconImageEntry {
  /** Nominal width from the group directory (0 in the file means 256). */
  width: number;
  height: number;
  bitCount: number;
  /** Raw RT_ICON payload: a PNG stream or a DIB (BITMAPINFOHEADER + pixels). */
  data: Buffer;
}

export type DecodedIcon =
  | { kind: "png"; data: Buffer }
  | { kind: "bitmap"; width: number; height: number; bgra: Buffer };

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const MAX_ICON_BYTES = 4 * 1024 * 1024;
const MAX_DIR_ENTRIES = 4096;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readExact(read: ByteReader, offset: number, length: number): Buffer {
  if (offset < 0 || length < 0 || !Number.isFinite(offset)) throw new Error("bad offset");
  const buffer = read(offset, length);
  if (buffer.length < length) throw new Error("unexpected end of file");
  return buffer;
}

interface Section {
  virtualAddress: number;
  virtualSize: number;
  rawSize: number;
  rawPointer: number;
}

interface ResourceEntry {
  /** Numeric id, or undefined for a named entry. */
  id?: number;
  isDirectory: boolean;
  /** Offset relative to the start of the resource section. */
  offset: number;
}

class ResourceReader {
  constructor(
    private readonly read: ByteReader,
    private readonly sections: Section[],
    private readonly rootOffset: number,
  ) {}

  rvaToOffset(rva: number): number {
    for (const section of this.sections) {
      const span = Math.max(section.virtualSize, section.rawSize);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
        return section.rawPointer + (rva - section.virtualAddress);
      }
    }
    throw new Error("rva outside sections");
  }

  /** Directory entries in file order (named entries first, then ascending ids). */
  entries(relativeOffset: number): ResourceEntry[] {
    const header = readExact(this.read, this.rootOffset + relativeOffset, 16);
    const count = header.readUInt16LE(12) + header.readUInt16LE(14);
    if (count > MAX_DIR_ENTRIES) throw new Error("resource directory too large");
    if (count === 0) return [];
    const table = readExact(this.read, this.rootOffset + relativeOffset + 16, count * 8);
    const result: ResourceEntry[] = [];
    for (let index = 0; index < count; index += 1) {
      const name = table.readUInt32LE(index * 8);
      const target = table.readUInt32LE(index * 8 + 4);
      result.push({
        id: name & 0x80000000 ? undefined : name & 0xffff,
        isDirectory: (target & 0x80000000) !== 0,
        offset: target & 0x7fffffff,
      });
    }
    return result;
  }

  /** Follow the first language (or deeper first child) down to the data bytes. */
  leafData(entry: ResourceEntry, depth = 0): Buffer {
    if (entry.isDirectory) {
      if (depth > 4) throw new Error("resource tree too deep");
      const children = this.entries(entry.offset);
      if (children.length === 0) throw new Error("empty resource directory");
      return this.leafData(children[0], depth + 1);
    }
    const dataEntry = readExact(this.read, this.rootOffset + entry.offset, 16);
    const rva = dataEntry.readUInt32LE(0);
    const size = dataEntry.readUInt32LE(4);
    if (size === 0 || size > MAX_ICON_BYTES) throw new Error("bad resource size");
    return readExact(this.read, this.rvaToOffset(rva), size);
  }
}

function openResources(read: ByteReader): ResourceReader | null {
  const dos = readExact(read, 0, 64);
  if (dos.readUInt16LE(0) !== 0x5a4d) return null; // "MZ"
  const peOffset = dos.readUInt32LE(0x3c);
  const coff = readExact(read, peOffset, 24);
  if (coff.readUInt32LE(0) !== 0x00004550) return null; // "PE\0\0"
  const sectionCount = coff.readUInt16LE(6);
  const optionalSize = coff.readUInt16LE(20);
  if (sectionCount === 0 || sectionCount > 96 || optionalSize < 2) return null;
  const optional = readExact(read, peOffset + 24, optionalSize);
  const magic = optional.readUInt16LE(0);
  const directoryBase = magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1;
  if (directoryBase < 0 || optional.length < directoryBase) return null;
  const directoryCount = optional.readUInt32LE(directoryBase - 4);
  // The resource table is data directory #2.
  if (directoryCount < 3 || optional.length < directoryBase + 24) return null;
  const resourceRva = optional.readUInt32LE(directoryBase + 16);
  if (resourceRva === 0) return null;

  const table = readExact(read, peOffset + 24 + optionalSize, sectionCount * 40);
  const sections: Section[] = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const base = index * 40;
    sections.push({
      virtualSize: table.readUInt32LE(base + 8),
      virtualAddress: table.readUInt32LE(base + 12),
      rawSize: table.readUInt32LE(base + 16),
      rawPointer: table.readUInt32LE(base + 20),
    });
  }
  const probe = new ResourceReader(read, sections, 0);
  return new ResourceReader(read, sections, probe.rvaToOffset(resourceRva));
}

/**
 * Read the image entries of one icon group. `iconIndex` follows the shell
 * convention: a non-negative value selects the n-th group in resource order
 * (0 is the icon Explorer shows), a negative value selects resource id
 * `-iconIndex`. Returns `[]` when the file has no usable icon.
 */
export function readPeIconGroup(read: ByteReader, iconIndex = 0): IconImageEntry[] {
  let resources: ResourceReader | null;
  try {
    resources = openResources(read);
  } catch {
    return [];
  }
  if (!resources) return [];
  try {
    const types = resources.entries(0);
    const groupType = types.find((entry) => entry.id === RT_GROUP_ICON && entry.isDirectory);
    const iconType = types.find((entry) => entry.id === RT_ICON && entry.isDirectory);
    if (!groupType || !iconType) return [];
    const groups = resources.entries(groupType.offset);
    const group =
      iconIndex >= 0 ? groups[iconIndex] : groups.find((entry) => entry.id === -iconIndex);
    if (!group) return [];
    const directory = resources.leafData(group);
    if (directory.length < 6 || directory.readUInt16LE(2) !== 1) return [];
    const count = Math.min(directory.readUInt16LE(4), Math.floor((directory.length - 6) / 14));
    const icons = new Map<number, ResourceEntry>();
    for (const entry of resources.entries(iconType.offset)) {
      if (entry.id !== undefined) icons.set(entry.id, entry);
    }
    const result: IconImageEntry[] = [];
    for (let index = 0; index < count; index += 1) {
      const base = 6 + index * 14;
      const icon = icons.get(directory.readUInt16LE(base + 12));
      if (!icon) continue;
      let data: Buffer;
      try {
        data = resources.leafData(icon);
      } catch {
        continue;
      }
      result.push({
        width: directory.readUInt8(base) || 256,
        height: directory.readUInt8(base + 1) || 256,
        bitCount: directory.readUInt16LE(base + 6),
        data,
      });
    }
    return result;
  } catch {
    return [];
  }
}

function isPng(data: Buffer): boolean {
  return data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** Actual pixel size and depth of an entry, read from the payload itself. */
function entryInfo(entry: IconImageEntry): { size: number; depth: number } {
  if (isPng(entry.data)) {
    const size = entry.data.length >= 24 ? entry.data.readUInt32BE(16) : entry.width;
    return { size, depth: 32 };
  }
  if (entry.data.length >= 16) {
    return { size: Math.abs(entry.data.readInt32LE(4)), depth: entry.data.readUInt16LE(14) };
  }
  return { size: entry.width, depth: entry.bitCount };
}

/**
 * Choose the image to render at `targetSize` px: the smallest image at least
 * that large (else the largest), preferring the highest colour depth.
 */
export function pickIconImage(
  entries: IconImageEntry[],
  targetSize: number,
): IconImageEntry | undefined {
  const scored = entries.map((entry) => ({ entry, ...entryInfo(entry) }));
  scored.sort((left, right) => {
    const leftFits = left.size >= targetSize ? 0 : 1;
    const rightFits = right.size >= targetSize ? 0 : 1;
    if (leftFits !== rightFits) return leftFits - rightFits;
    if (left.size !== right.size) {
      return leftFits === 0 ? left.size - right.size : right.size - left.size;
    }
    return right.depth - left.depth;
  });
  return scored[0]?.entry;
}

/**
 * Decode an RT_ICON payload. PNG payloads are returned as-is; DIB payloads
 * (1/4/8/24/32 bpp with AND mask) are converted to top-down BGRA pixels.
 * Returns `null` for unsupported or malformed data.
 */
export function decodeIconImage(data: Buffer): DecodedIcon | null {
  if (isPng(data)) return { kind: "png", data };
  if (data.length < 40) return null;
  const headerSize = data.readUInt32LE(0);
  const width = data.readInt32LE(4);
  const height = Math.floor(Math.abs(data.readInt32LE(8)) / 2);
  const bitCount = data.readUInt16LE(14);
  const compression = data.readUInt32LE(16);
  if (headerSize < 40 || width <= 0 || height <= 0 || width > 1024 || height > 1024) return null;
  if (compression !== 0 && !(compression === 3 && bitCount === 32)) return null;
  if (![1, 4, 8, 24, 32].includes(bitCount)) return null;

  let paletteSize = 0;
  if (bitCount <= 8) {
    const used = data.readUInt32LE(32);
    paletteSize = used > 0 && used <= 1 << bitCount ? used : 1 << bitCount;
  }
  // BI_BITFIELDS with a plain BITMAPINFOHEADER stores three masks after it.
  const masksSize = compression === 3 && headerSize === 40 ? 12 : 0;
  const paletteOffset = headerSize;
  const pixelOffset = headerSize + masksSize + paletteSize * 4;
  const xorStride = Math.ceil((width * bitCount) / 32) * 4;
  const andStride = Math.ceil(width / 32) * 4;
  const andOffset = pixelOffset + xorStride * height;
  if (andOffset > data.length) return null;
  const hasMask = andOffset + andStride * height <= data.length;

  const bgra = Buffer.alloc(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y += 1) {
    const row = pixelOffset + (height - 1 - y) * xorStride;
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      if (bitCount === 32) {
        data.copy(bgra, out, row + x * 4, row + x * 4 + 4);
        if (bgra[out + 3] !== 0) anyAlpha = true;
      } else if (bitCount === 24) {
        data.copy(bgra, out, row + x * 3, row + x * 3 + 3);
        bgra[out + 3] = 255;
      } else {
        const bitPos = x * bitCount;
        const byte = data[row + (bitPos >> 3)];
        const shift = 8 - bitCount - (bitPos & 7);
        const index = (byte >> shift) & ((1 << bitCount) - 1);
        const color = paletteOffset + Math.min(index, paletteSize - 1) * 4;
        data.copy(bgra, out, color, color + 3);
        bgra[out + 3] = 255;
      }
    }
  }
  // 32bpp images carry alpha themselves; older depths (and 32bpp images whose
  // alpha channel is all zero) use the 1bpp AND mask for transparency.
  if (!(bitCount === 32 && anyAlpha) && hasMask) {
    for (let y = 0; y < height; y += 1) {
      const row = andOffset + (height - 1 - y) * andStride;
      for (let x = 0; x < width; x += 1) {
        const transparent = (data[row + (x >> 3)] >> (7 - (x & 7))) & 1;
        bgra[(y * width + x) * 4 + 3] = transparent ? 0 : 255;
      }
    }
  } else if (bitCount === 32 && !anyAlpha) {
    for (let index = 3; index < bgra.length; index += 4) bgra[index] = 255;
  }
  return { kind: "bitmap", width, height, bgra };
}
