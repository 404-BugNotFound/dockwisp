import assert from "node:assert/strict";
import test from "node:test";
import { findScrollOffset, LongStitcher } from "../src/main/long-stitch";

const WIDTH = 32;
const HEIGHT = 200;

/** Deterministic pseudo-random byte for reproducible synthetic rows. */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return Math.floor((x - Math.floor(x)) * 256);
}

/**
 * Build a tall "document" where each row has a distinct color derived from its
 * global row index, so a window into it is uniquely matchable.
 */
function makeDocument(rows: number): Uint8Array {
  const data = new Uint8Array(WIDTH * rows * 4);
  for (let y = 0; y < rows; y++) {
    const r = noise(y + 1);
    const g = noise(y * 7 + 3);
    const b = noise(y * 13 + 5);
    for (let x = 0; x < WIDTH; x++) {
      const p = (y * WIDTH + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
  }
  return data;
}

/** A HEIGHT-row window of the document starting at global row `top`. */
function frameAt(document: Uint8Array, top: number): Uint8Array {
  const start = top * WIDTH * 4;
  return document.slice(start, start + WIDTH * HEIGHT * 4);
}

const document = makeDocument(2_000);

test("measures downward scroll distance between frames", () => {
  const prev = frameAt(document, 0);
  const next = frameAt(document, 50);
  assert.equal(findScrollOffset(prev, next, WIDTH, HEIGHT), 50);
});

test("returns 0 when the frame did not change", () => {
  const prev = frameAt(document, 120);
  const next = frameAt(document, 120);
  assert.equal(findScrollOffset(prev, next, WIDTH, HEIGHT), 0);
});

test("returns null for unrelated content", () => {
  const prev = frameAt(document, 0);
  const other = makeDocument(2_000 + 999);
  const next = other.slice(400 * WIDTH * 4, 400 * WIDTH * 4 + WIDTH * HEIGHT * 4);
  // A fresh document seeded differently should not match the first.
  const result = findScrollOffset(prev, next, WIDTH, HEIGHT);
  assert.ok(result === null || result === 0 ? result !== 0 : true);
  assert.equal(result, null);
});

test("stitches overlapping frames into the correct tall image", () => {
  const stitcher = new LongStitcher(WIDTH, frameAt(document, 0), HEIGHT);
  assert.equal(stitcher.height, HEIGHT);
  assert.equal(stitcher.push(frameAt(document, 60)), true);
  assert.equal(stitcher.height, HEIGHT + 60);
  assert.equal(stitcher.push(frameAt(document, 150)), true);
  assert.equal(stitcher.height, HEIGHT + 150);

  const pixels = stitcher.toPixels();
  // The stitched result must equal the original document region [0, HEIGHT+150).
  const expected = document.slice(0, WIDTH * (HEIGHT + 150) * 4);
  assert.equal(pixels.length, expected.length);
  assert.deepEqual(pixels, expected);
});

test("ignores frames with no change", () => {
  const stitcher = new LongStitcher(WIDTH, frameAt(document, 0), HEIGHT);
  assert.equal(stitcher.push(frameAt(document, 0)), false);
  assert.equal(stitcher.height, HEIGHT);
});

test("ignores frames that cannot be matched", () => {
  const stitcher = new LongStitcher(WIDTH, frameAt(document, 0), HEIGHT);
  const other = makeDocument(5_000);
  const unrelated = other.slice(800 * WIDTH * 4, 800 * WIDTH * 4 + WIDTH * HEIGHT * 4);
  assert.equal(stitcher.push(unrelated), false);
  assert.equal(stitcher.height, HEIGHT);
  // A valid frame after a rejected one still stitches against the seed.
  assert.equal(stitcher.push(frameAt(document, 40)), true);
  assert.equal(stitcher.height, HEIGHT + 40);
});

test("stops growing at the maximum height", () => {
  const maxHeight = HEIGHT + 100;
  const stitcher = new LongStitcher(WIDTH, frameAt(document, 0), HEIGHT, maxHeight);
  assert.equal(stitcher.push(frameAt(document, 80)), true);
  assert.equal(stitcher.height, HEIGHT + 80);
  // This scroll would exceed the cap; only the remaining rows are appended.
  assert.equal(stitcher.push(frameAt(document, 160)), true);
  assert.equal(stitcher.height, maxHeight);
  assert.equal(stitcher.full, true);
  // Once full, further frames are rejected.
  assert.equal(stitcher.push(frameAt(document, 240)), false);
  assert.equal(stitcher.height, maxHeight);
  assert.equal(stitcher.toPixels().length, WIDTH * maxHeight * 4);
});
