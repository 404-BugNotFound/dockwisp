/**
 * Pure helpers for the manual long-screenshot (scroll-to-capture) feature.
 *
 * Frames are raw top-down RGBA pixel buffers of a fixed width/height (the
 * physical-pixel capture region). As the user scrolls the target window, each
 * new frame overlaps the previous one; `findScrollOffset` measures how far the
 * content moved up and `LongStitcher` appends only the freshly revealed rows.
 *
 * This module has no Electron dependency so it can be unit tested in isolation.
 */

const DEFAULT_SAMPLE_COUNT = 16;
// Ignore this fraction of the width on each side so a scrollbar (which does not
// move with the content) never dominates the row comparison.
const DEFAULT_SIDE_MARGIN = 0.06;
// Mean per-sample grayscale difference (0-255) under which two rows are treated
// as the same content. Small to reject near-matches, loose enough for antialias
// jitter between frames.
const DEFAULT_MATCH_THRESHOLD = 10;
// A match must overlap at least this many rows, and at least a quarter of the
// frame height, so a few coincidentally similar rows cannot pass as a scroll.
const DEFAULT_MIN_OVERLAP_ROWS = 40;
const DEFAULT_MAX_HEIGHT = 20_000;

interface RowSignatures {
  /** Flat [height * count] grayscale samples, row-major. */
  values: Float64Array;
  /** Samples per row. */
  count: number;
}

/** Column indices to sample for a row, skipping the side margins. */
function sampleColumns(width: number, sampleCount: number, sideMargin: number): number[] {
  const marginX = Math.min(Math.floor(width * sideMargin), Math.floor((width - 1) / 2));
  const usable = Math.max(1, width - marginX * 2);
  const count = Math.max(1, Math.min(sampleCount, usable));
  const columns: number[] = [];
  for (let i = 0; i < count; i++) {
    const column = marginX + Math.floor(((i + 0.5) * usable) / count);
    columns.push(Math.min(width - 1, Math.max(0, column)));
  }
  return columns;
}

/** Grayscale sample signatures for every row of an RGBA frame. */
function rowSignatures(
  frame: Uint8Array,
  width: number,
  height: number,
  sampleCount: number,
  sideMargin: number,
): RowSignatures {
  const columns = sampleColumns(width, sampleCount, sideMargin);
  const count = columns.length;
  const values = new Float64Array(height * count);
  for (let y = 0; y < height; y++) {
    const rowBase = y * width * 4;
    const outBase = y * count;
    for (let i = 0; i < count; i++) {
      const p = rowBase + columns[i] * 4;
      // Rec. 601 luma; alpha is ignored (opaque screen captures).
      values[outBase + i] = 0.299 * frame[p] + 0.587 * frame[p + 1] + 0.114 * frame[p + 2];
    }
  }
  return { values, count };
}

/** Mean per-sample difference between prev rows [dy..) and next rows [0..). */
function overlapError(
  prev: RowSignatures,
  next: RowSignatures,
  dy: number,
  overlap: number,
): number {
  const count = prev.count;
  let sum = 0;
  for (let i = 0; i < overlap; i++) {
    const a = (dy + i) * count;
    const b = i * count;
    let rowDiff = 0;
    for (let k = 0; k < count; k++) rowDiff += Math.abs(prev.values[a + k] - next.values[b + k]);
    sum += rowDiff / count;
  }
  return sum / overlap;
}

export interface ScrollMatchOptions {
  sampleCount?: number;
  sideMargin?: number;
  matchThreshold?: number;
  minOverlapRows?: number;
}

/**
 * Measure how many rows `next` scrolled up relative to `prev`.
 *
 * Returns 0 when the frames show the same content, a positive row count for a
 * downward scroll, or null when no confident match exists (no change that is
 * not identical, an upward scroll, or unrelated content). `prev` and `next`
 * must both be `width * height * 4` byte top-down RGBA buffers.
 */
export function findScrollOffset(
  prev: Uint8Array,
  next: Uint8Array,
  width: number,
  height: number,
  options: ScrollMatchOptions = {},
): number | null {
  if (width < 1 || height < 2) return null;
  const expected = width * height * 4;
  if (prev.length < expected || next.length < expected) return null;

  const sampleCount = options.sampleCount ?? DEFAULT_SAMPLE_COUNT;
  const sideMargin = options.sideMargin ?? DEFAULT_SIDE_MARGIN;
  const threshold = options.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
  const minOverlapRows = options.minOverlapRows ?? DEFAULT_MIN_OVERLAP_ROWS;

  const prevSig = rowSignatures(prev, width, height, sampleCount, sideMargin);
  const nextSig = rowSignatures(next, width, height, sampleCount, sideMargin);

  // Identical content (no scroll) wins before any shifted match is considered.
  if (overlapError(prevSig, nextSig, 0, height) <= threshold) return 0;

  const minOverlap = Math.max(minOverlapRows, Math.floor(height / 4));
  const maxDy = height - minOverlap;
  if (maxDy < 1) return null;

  let bestDy = -1;
  let bestError = Infinity;
  for (let dy = 1; dy <= maxDy; dy++) {
    const error = overlapError(prevSig, nextSig, dy, height - dy);
    // Strict improvement keeps the smallest dy when errors tie.
    if (error < bestError) {
      bestError = error;
      bestDy = dy;
    }
  }
  return bestDy > 0 && bestError <= threshold ? bestDy : null;
}

/**
 * Accumulates a tall image from overlapping scroll frames. The first frame
 * seeds the result; each subsequent frame contributes only the rows revealed
 * at its bottom. Growth stops at `maxHeight` pixels.
 */
export class LongStitcher {
  readonly width: number;
  readonly frameHeight: number;
  readonly maxHeight: number;
  private readonly matchOptions: ScrollMatchOptions;
  private readonly segments: Uint8Array[] = [];
  private totalHeight: number;
  private last: Uint8Array;

  constructor(
    width: number,
    first: Uint8Array,
    frameHeight: number,
    maxHeight: number = DEFAULT_MAX_HEIGHT,
    matchOptions: ScrollMatchOptions = {},
  ) {
    this.width = width;
    this.frameHeight = frameHeight;
    this.maxHeight = maxHeight;
    this.matchOptions = matchOptions;
    const frameBytes = width * frameHeight * 4;
    const seed = first.slice(0, frameBytes);
    const seedHeight = Math.min(frameHeight, maxHeight);
    this.segments.push(seedHeight < frameHeight ? seed.slice(0, width * seedHeight * 4) : seed);
    this.totalHeight = seedHeight;
    this.last = seed;
  }

  /** Current stitched height in pixels. */
  get height(): number {
    return this.totalHeight;
  }

  /** True once the height ceiling has been reached. */
  get full(): boolean {
    return this.totalHeight >= this.maxHeight;
  }

  /**
   * Compare `frame` with the previous one and append any newly revealed rows.
   * Returns true when content was added. Frames that cannot be matched are
   * ignored and leave the previous reference untouched, so a transient bad
   * frame cannot corrupt the stitch.
   */
  push(frame: Uint8Array): boolean {
    if (this.full) return false;
    const frameBytes = this.width * this.frameHeight * 4;
    const dy = findScrollOffset(this.last, frame, this.width, this.frameHeight, this.matchOptions);
    if (dy === null) return false;
    if (dy === 0) {
      this.last = frame.slice(0, frameBytes);
      return false;
    }
    const rows = Math.min(dy, this.maxHeight - this.totalHeight);
    if (rows <= 0) {
      this.last = frame.slice(0, frameBytes);
      return false;
    }
    const startRow = this.frameHeight - dy;
    const sliceStart = startRow * this.width * 4;
    const sliceEnd = (startRow + rows) * this.width * 4;
    this.segments.push(frame.slice(sliceStart, sliceEnd));
    this.totalHeight += rows;
    this.last = frame.slice(0, frameBytes);
    return true;
  }

  /** The stitched image as one top-down RGBA buffer. */
  toPixels(): Uint8Array {
    const out = new Uint8Array(this.width * this.totalHeight * 4);
    let offset = 0;
    for (const segment of this.segments) {
      out.set(segment, offset);
      offset += segment.length;
    }
    return out;
  }
}
