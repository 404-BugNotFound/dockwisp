/**
 * Pure text-diff algorithms for the "文本对比" tool. No Electron imports so the
 * module can run in the main process (via ipc) and in Node tests alike.
 *
 * Line-level diff uses Myers' O(ND) algorithm over per-line integer ids
 * (hashed through a Map) so large inputs stay fast. Character-level diff runs
 * the same algorithm over code points, but only for lines that were paired as
 * a modification, keeping the extra work bounded.
 */

export interface DiffOptions {
  /** Treat lines that differ only in whitespace as equal. */
  ignoreWhitespace?: boolean;
  /** Treat lines that differ only in letter case as equal. */
  ignoreCase?: boolean;
}

export type DiffRowType = "equal" | "modify" | "insert" | "delete";

/** A run of characters on one side, flagged as changed or untouched. */
export interface CharSegment {
  text: string;
  changed: boolean;
}

export interface DiffCell {
  /** 1-based line number within its own side. */
  lineNumber: number;
  text: string;
  /** Character-level breakdown, only present on "modify" rows. */
  segments?: CharSegment[];
}

export interface DiffRow {
  type: DiffRowType;
  left: DiffCell | null;
  right: DiffCell | null;
}

export interface DiffStats {
  /** Lines present on the right but changed (pure inserts + modifications). */
  added: number;
  /** Lines present on the left but changed (pure deletes + modifications). */
  removed: number;
  /** Rows where a left line was paired with a changed right line. */
  modified: number;
  /** Total diff rows (added + removed accounting), handy for navigation. */
  changedRows: number;
}

export interface DiffResult {
  rows: DiffRow[];
  stats: DiffStats;
}

type EditType = "equal" | "delete" | "insert";

interface Edit {
  type: EditType;
  /** Index into the "a" (left) sequence, for equal/delete. */
  aIndex: number;
  /** Index into the "b" (right) sequence, for equal/insert. */
  bIndex: number;
}

/**
 * Myers' edit-distance budgets. Beyond these the diff degrades to a block
 * replace, which keeps the main process responsive on wholesale changes (two
 * texts that share almost nothing) where an exact script is neither affordable
 * nor more useful than "these lines differ".
 */
const LINE_MAX_D = 4000;
const CHAR_MAX_D = 2000;

/** Split text into lines, normalizing CRLF/CR to LF first. */
export function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/** Normalized comparison key for a line given the active options. */
function lineKey(line: string, options: DiffOptions): string {
  let key = line;
  if (options.ignoreWhitespace) key = key.replace(/\s+/g, "");
  if (options.ignoreCase) key = key.toLowerCase();
  return key;
}

/**
 * Map each element to a small integer id so the diff core compares numbers.
 * Both sequences share one id space so equal elements get equal ids.
 */
function intern(a: string[], b: string[]): { aIds: number[]; bIds: number[] } {
  const ids = new Map<string, number>();
  const toId = (value: string): number => {
    let id = ids.get(value);
    if (id === undefined) {
      id = ids.size;
      ids.set(value, id);
    }
    return id;
  };
  return { aIds: a.map(toId), bIds: b.map(toId) };
}

/**
 * Myers' greedy O(ND) diff over the (already prefix/suffix-trimmed) ranges.
 * Returns an ordered edit script, or null when the edit distance exceeds
 * `maxD` — the caller then falls back to a linear "replace the block" script.
 * The trace is stored compactly (only the 2d+1 live diagonals per round) so
 * memory stays bounded by the budget rather than O((n+m)^2).
 */
function myers(a: number[], b: number[], maxD: number): Edit[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const limit = Math.min(max, maxD);
  const offset = max;
  const size = 2 * max + 1;

  const v = new Int32Array(size);
  // Compact trace: one row of length (2d+1) per d, instead of a full copy.
  const trace: Int32Array[] = [];

  let reached = false;
  outer: for (let d = 0; d <= limit; d++) {
    const row = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]; // move down => insert from b
      } else {
        x = v[offset + k - 1] + 1; // move right => delete from a
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      row[k + d] = x;
      if (x >= n && y >= m) {
        trace.push(row);
        reached = true;
        break outer;
      }
    }
    trace.push(row);
  }
  if (!reached) return null; // over budget — caller degrades to a block replace

  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    // The choice of predecessor diagonal depends on V from the *previous*
    // round (trace[d-1]); trace[d] only tells us the end point of this round.
    const prev = trace[d - 1];
    const pd = d - 1;
    const k = x - y;
    let prevK: number;
    const left = k - 1 >= -pd ? prev[k - 1 + pd] : -1;
    const right = k + 1 <= pd ? prev[k + 1 + pd] : -1;
    if (k === -d || (k !== d && left < right)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prev[prevK + pd];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      edits.push({ type: "equal", aIndex: x - 1, bIndex: y - 1 });
      x--;
      y--;
    }
    if (x === prevX) {
      edits.push({ type: "insert", aIndex: prevX, bIndex: prevY });
    } else {
      edits.push({ type: "delete", aIndex: prevX, bIndex: prevY });
    }
    x = prevX;
    y = prevY;
  }
  // Round 0: whatever remains is the common prefix walked diagonally.
  while (x > 0 && y > 0) {
    edits.push({ type: "equal", aIndex: x - 1, bIndex: y - 1 });
    x--;
    y--;
  }
  edits.reverse();
  return edits;
}

/**
 * Linear fallback when the Myers budget is exceeded: emit every deletion of
 * `a` followed by every insertion of `b`. Correct (the pieced-back lines match
 * the originals) and O(n+m); the pairing step still turns delete/insert runs
 * into modify rows, so the UI stays useful on wholesale changes.
 */
function fallbackDiff(a: number[], b: number[]): Edit[] {
  const edits: Edit[] = [];
  for (let i = 0; i < a.length; i++) {
    edits.push({ type: "delete", aIndex: i, bIndex: 0 });
  }
  for (let j = 0; j < b.length; j++) {
    edits.push({ type: "insert", aIndex: a.length, bIndex: j });
  }
  return edits;
}

/**
 * Diff two id sequences with equal ends trimmed first, a bounded Myers in the
 * middle, and a linear fallback when the middle is too divergent. Output is a
 * full edit script in terms of the original indices.
 */
function diffCore(a: number[], b: number[], maxD: number): Edit[] {
  const n = a.length;
  const m = b.length;

  let start = 0;
  const minLen = Math.min(n, m);
  while (start < minLen && a[start] === b[start]) start++;

  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = myers(midA, midB, maxD) ?? fallbackDiff(midA, midB);

  const edits: Edit[] = [];
  for (let i = 0; i < start; i++) edits.push({ type: "equal", aIndex: i, bIndex: i });
  for (const e of middle) {
    if (e.type === "equal") {
      edits.push({ type: "equal", aIndex: e.aIndex + start, bIndex: e.bIndex + start });
    } else if (e.type === "delete") {
      edits.push({ type: "delete", aIndex: e.aIndex + start, bIndex: e.bIndex + start });
    } else {
      edits.push({ type: "insert", aIndex: e.aIndex + start, bIndex: e.bIndex + start });
    }
  }
  for (let i = 0; i < n - endA; i++) {
    edits.push({ type: "equal", aIndex: endA + i, bIndex: endB + i });
  }
  return edits;
}

/** Merge adjacent segments that share the same `changed` flag. */
function pushSegment(segments: CharSegment[], text: string, changed: boolean): void {
  if (text === "") return;
  const last = segments[segments.length - 1];
  if (last && last.changed === changed) {
    last.text += text;
  } else {
    segments.push({ text, changed });
  }
}

/**
 * Character-level diff of two single lines. Returns a segment list for each
 * side: the left marks deletions as changed, the right marks insertions.
 */
export function diffChars(
  left: string,
  right: string,
): { left: CharSegment[]; right: CharSegment[] } {
  const a = Array.from(left);
  const b = Array.from(right);
  const { aIds, bIds } = intern(a, b);
  const edits = diffCore(aIds, bIds, CHAR_MAX_D);

  const leftSegments: CharSegment[] = [];
  const rightSegments: CharSegment[] = [];
  for (const edit of edits) {
    if (edit.type === "equal") {
      pushSegment(leftSegments, a[edit.aIndex], false);
      pushSegment(rightSegments, b[edit.bIndex], false);
    } else if (edit.type === "delete") {
      pushSegment(leftSegments, a[edit.aIndex], true);
    } else {
      pushSegment(rightSegments, b[edit.bIndex], true);
    }
  }
  return { left: leftSegments, right: rightSegments };
}

/**
 * Compute a side-by-side line diff. Consecutive deletes and inserts between two
 * equal regions are paired into "modify" rows (with character-level detail);
 * any leftover becomes pure insert/delete rows.
 */
export function computeTextDiff(
  left: string,
  right: string,
  options: DiffOptions = {},
): DiffResult {
  const leftLines = splitLines(left);
  const rightLines = splitLines(right);
  const aKeys = leftLines.map((line) => lineKey(line, options));
  const bKeys = rightLines.map((line) => lineKey(line, options));
  const { aIds, bIds } = intern(aKeys, bKeys);
  const edits = diffCore(aIds, bIds, LINE_MAX_D);

  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let modified = 0;

  // Buffer runs of deletes/inserts so we can pair them into modify rows.
  let pendingDeletes: number[] = [];
  let pendingInserts: number[] = [];

  const flushPending = (): void => {
    const pairs = Math.min(pendingDeletes.length, pendingInserts.length);
    for (let i = 0; i < pairs; i++) {
      const aIndex = pendingDeletes[i];
      const bIndex = pendingInserts[i];
      const chars = diffChars(leftLines[aIndex], rightLines[bIndex]);
      rows.push({
        type: "modify",
        left: {
          lineNumber: aIndex + 1,
          text: leftLines[aIndex],
          segments: chars.left,
        },
        right: {
          lineNumber: bIndex + 1,
          text: rightLines[bIndex],
          segments: chars.right,
        },
      });
      modified++;
      added++;
      removed++;
    }
    for (let i = pairs; i < pendingDeletes.length; i++) {
      const aIndex = pendingDeletes[i];
      rows.push({
        type: "delete",
        left: { lineNumber: aIndex + 1, text: leftLines[aIndex] },
        right: null,
      });
      removed++;
    }
    for (let i = pairs; i < pendingInserts.length; i++) {
      const bIndex = pendingInserts[i];
      rows.push({
        type: "insert",
        left: null,
        right: { lineNumber: bIndex + 1, text: rightLines[bIndex] },
      });
      added++;
    }
    pendingDeletes = [];
    pendingInserts = [];
  };

  for (const edit of edits) {
    if (edit.type === "equal") {
      flushPending();
      rows.push({
        type: "equal",
        left: { lineNumber: edit.aIndex + 1, text: leftLines[edit.aIndex] },
        right: { lineNumber: edit.bIndex + 1, text: rightLines[edit.bIndex] },
      });
    } else if (edit.type === "delete") {
      pendingDeletes.push(edit.aIndex);
    } else {
      pendingInserts.push(edit.bIndex);
    }
  }
  flushPending();

  return {
    rows,
    stats: { added, removed, modified, changedRows: added + removed - modified },
  };
}
