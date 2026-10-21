import assert from "node:assert/strict";
import test from "node:test";
import {
  type ByteReader,
  type IconImageEntry,
  decodeIconImage,
  pickIconImage,
  readPeIconGroup,
} from "../src/core/pe-icon";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A fake PNG stream: signature plus an IHDR declaring `size` x `size`. */
function fakePng(size: number): Buffer {
  const data = Buffer.alloc(32);
  Buffer.from(PNG_SIGNATURE).copy(data, 0);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "latin1");
  data.writeUInt32BE(size, 16);
  data.writeUInt32BE(size, 20);
  return data;
}

/** A 32bpp DIB icon image filled with one BGRA colour, plus an AND mask. */
function dib32(size: number, bgra: [number, number, number, number]): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let index = 0; index < size * size; index += 1) pixels.set(bgra, index * 4);
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([header, pixels, mask]);
}

/** A 2x2 4bpp DIB: palette[0] red, palette[1] blue; top-left pixel masked out. */
function dib4(): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(2, 4);
  header.writeInt32LE(4, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(4, 14);
  const palette = Buffer.alloc(16 * 4);
  palette.set([0, 0, 255, 0], 0); // index 0: red (BGR order)
  palette.set([255, 0, 0, 0], 4); // index 1: blue
  // Bottom-up rows, 4-byte stride. Bottom row: [1, 0]; top row: [0, 1].
  const pixels = Buffer.from([0x10, 0, 0, 0, 0x01, 0, 0, 0]);
  // AND mask rows (bottom-up): bottom row opaque, top row first pixel transparent.
  const mask = Buffer.from([0x00, 0, 0, 0, 0x80, 0, 0, 0]);
  return Buffer.concat([header, palette, pixels, mask]);
}

const subdir = (offset: number): number => (0x80000000 | offset) >>> 0;

interface FakeIcon {
  id: number;
  width: number;
  bitCount: number;
  data: Buffer;
}

/**
 * Build a minimal PE32+ image whose only section (.rsrc) holds the given icon
 * groups. Each group is a list of RT_ICON ids; icons are shared by id.
 */
function buildPe(groups: Array<{ id: number; icons: number[] }>, icons: FakeIcon[]): Buffer {
  const sectionRva = 0x1000;
  const fileAlign = 0x200;
  const headersSize = fileAlign;

  // Resource layout: root dir -> type dirs -> name dirs -> lang dirs -> data entries -> blobs.
  const chunks: Buffer[] = [];
  let cursor = 0;
  const reserve = (size: number): number => {
    const offset = cursor;
    cursor += size;
    return offset;
  };
  const directory = (count: number): { offset: number; buffer: Buffer } => {
    const buffer = Buffer.alloc(16 + count * 8);
    buffer.writeUInt16LE(count, 14);
    const offset = reserve(buffer.length);
    chunks.push(buffer);
    return { offset, buffer };
  };

  const groupBlobs = groups.map((group) => {
    const blob = Buffer.alloc(6 + group.icons.length * 14);
    blob.writeUInt16LE(1, 2);
    blob.writeUInt16LE(group.icons.length, 4);
    group.icons.forEach((iconId, index) => {
      const icon = icons.find((item) => item.id === iconId)!;
      const base = 6 + index * 14;
      blob.writeUInt8(icon.width >= 256 ? 0 : icon.width, base);
      blob.writeUInt8(icon.width >= 256 ? 0 : icon.width, base + 1);
      blob.writeUInt16LE(1, base + 4);
      blob.writeUInt16LE(icon.bitCount, base + 6);
      blob.writeUInt32LE(icon.data.length, base + 8);
      blob.writeUInt16LE(icon.id, base + 12);
    });
    return { id: group.id, blob };
  });

  const root = directory(2);
  const iconTypeDir = directory(icons.length);
  const groupTypeDir = directory(groupBlobs.length);
  // RT_ICON (3) sorts before RT_GROUP_ICON (14).
  root.buffer.writeUInt32LE(3, 16);
  root.buffer.writeUInt32LE(subdir(iconTypeDir.offset), 20);
  root.buffer.writeUInt32LE(14, 24);
  root.buffer.writeUInt32LE(subdir(groupTypeDir.offset), 28);

  const blobsToPlace: Array<{ entry: Buffer; data: Buffer }> = [];
  const addLeaf = (typeDir: Buffer, index: number, id: number, data: Buffer): void => {
    const langDir = directory(1);
    typeDir.writeUInt32LE(id, 16 + index * 8);
    typeDir.writeUInt32LE(subdir(langDir.offset), 20 + index * 8);
    const entry = Buffer.alloc(16);
    const entryOffset = reserve(16);
    chunks.push(entry);
    langDir.buffer.writeUInt32LE(0x0409, 16);
    langDir.buffer.writeUInt32LE(entryOffset, 20);
    blobsToPlace.push({ entry, data });
  };
  [...icons].sort((a, b) => a.id - b.id).forEach((icon, index) =>
    addLeaf(iconTypeDir.buffer, index, icon.id, icon.data),
  );
  [...groupBlobs].sort((a, b) => a.id - b.id).forEach((group, index) =>
    addLeaf(groupTypeDir.buffer, index, group.id, group.blob),
  );
  for (const { entry, data } of blobsToPlace) {
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    const offset = reserve(padded.length);
    chunks.push(padded);
    entry.writeUInt32LE(sectionRva + offset, 0);
    entry.writeUInt32LE(data.length, 4);
  }
  const rsrc = Buffer.concat(chunks);
  const rawSize = Math.ceil(rsrc.length / fileAlign) * fileAlign;

  const headers = Buffer.alloc(headersSize);
  headers.writeUInt16LE(0x5a4d, 0);
  const peOffset = 0x80;
  headers.writeUInt32LE(peOffset, 0x3c);
  headers.writeUInt32LE(0x00004550, peOffset);
  headers.writeUInt16LE(0x8664, peOffset + 4);
  headers.writeUInt16LE(1, peOffset + 6);
  const optionalSize = 240;
  headers.writeUInt16LE(optionalSize, peOffset + 20);
  const optional = peOffset + 24;
  headers.writeUInt16LE(0x20b, optional);
  headers.writeUInt32LE(16, optional + 108);
  headers.writeUInt32LE(sectionRva, optional + 112 + 16);
  headers.writeUInt32LE(rsrc.length, optional + 112 + 20);
  const section = optional + optionalSize;
  headers.write(".rsrc", section, "latin1");
  headers.writeUInt32LE(rsrc.length, section + 8);
  headers.writeUInt32LE(sectionRva, section + 12);
  headers.writeUInt32LE(rawSize, section + 16);
  headers.writeUInt32LE(headersSize, section + 20);

  return Buffer.concat([headers, rsrc, Buffer.alloc(rawSize - rsrc.length)]);
}

function reader(file: Buffer): ByteReader {
  return (offset, length) => file.subarray(offset, offset + length);
}

test("readPeIconGroup reads the first icon group's images", () => {
  const icons: FakeIcon[] = [
    { id: 1, width: 16, bitCount: 32, data: dib32(16, [1, 2, 3, 255]) },
    { id: 2, width: 256, bitCount: 32, data: fakePng(256) },
    { id: 3, width: 32, bitCount: 32, data: dib32(32, [9, 9, 9, 255]) },
  ];
  const file = buildPe([{ id: 1, icons: [1, 2] }, { id: 7, icons: [3] }], icons);
  const entries = readPeIconGroup(reader(file));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.width), [16, 256]);
  assert.ok(entries[1].data.equals(fakePng(256)));
});

test("readPeIconGroup selects groups by index or by negative resource id", () => {
  const icons: FakeIcon[] = [
    { id: 1, width: 16, bitCount: 32, data: dib32(16, [0, 0, 0, 255]) },
    { id: 3, width: 32, bitCount: 32, data: dib32(32, [0, 0, 0, 255]) },
  ];
  const file = buildPe([{ id: 1, icons: [1] }, { id: 7, icons: [3] }], icons);
  assert.equal(readPeIconGroup(reader(file), 1)[0].width, 32);
  assert.equal(readPeIconGroup(reader(file), -7)[0].width, 32);
  assert.deepEqual(readPeIconGroup(reader(file), 5), []);
});

test("readPeIconGroup returns [] for non-PE, truncated or icon-less input", () => {
  assert.deepEqual(readPeIconGroup(reader(Buffer.alloc(0))), []);
  assert.deepEqual(readPeIconGroup(reader(Buffer.from("not a pe file at all"))), []);
  const file = buildPe([{ id: 1, icons: [1] }], [
    { id: 1, width: 16, bitCount: 32, data: dib32(16, [0, 0, 0, 255]) },
  ]);
  assert.deepEqual(readPeIconGroup(reader(file.subarray(0, 0x210))), []);
  const noResources = Buffer.from(file);
  noResources.writeUInt32LE(0, 0x80 + 24 + 112 + 16);
  assert.deepEqual(readPeIconGroup(reader(noResources)), []);
});

test("pickIconImage prefers the smallest image at least the target size", () => {
  const entries: IconImageEntry[] = [
    { width: 16, height: 16, bitCount: 32, data: dib32(16, [0, 0, 0, 255]) },
    { width: 256, height: 256, bitCount: 32, data: fakePng(256) },
    { width: 64, height: 64, bitCount: 32, data: dib32(64, [0, 0, 0, 255]) },
    { width: 48, height: 48, bitCount: 32, data: dib32(48, [0, 0, 0, 255]) },
  ];
  assert.equal(pickIconImage(entries, 64)?.width, 64);
  assert.equal(pickIconImage(entries, 100)?.width, 256);
  assert.equal(pickIconImage(entries.slice(0, 1), 64)?.width, 16);
  assert.equal(pickIconImage([], 64), undefined);
});

test("decodeIconImage passes PNG through and decodes 32bpp DIBs top-down", () => {
  const png = fakePng(256);
  assert.deepEqual(decodeIconImage(png), { kind: "png", data: png });
  const decoded = decodeIconImage(dib32(4, [10, 20, 30, 128]));
  assert.ok(decoded && decoded.kind === "bitmap");
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 4);
  assert.deepEqual([...decoded.bgra.subarray(0, 4)], [10, 20, 30, 128]);
});

test("decodeIconImage applies the palette and AND mask for low-depth DIBs", () => {
  const decoded = decodeIconImage(dib4());
  assert.ok(decoded && decoded.kind === "bitmap");
  // Top row: [0 (red, masked), 1 (blue)]; bottom row: [1 (blue), 0 (red)].
  assert.deepEqual([...decoded.bgra], [
    0, 0, 255, 0, 255, 0, 0, 255,
    255, 0, 0, 255, 0, 0, 255, 255,
  ]);
});

test("decodeIconImage rejects malformed data", () => {
  assert.equal(decodeIconImage(Buffer.alloc(10)), null);
  const bad = dib32(4, [0, 0, 0, 255]);
  bad.writeUInt16LE(7, 14);
  assert.equal(decodeIconImage(bad), null);
});
