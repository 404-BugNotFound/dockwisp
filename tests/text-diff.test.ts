import assert from "node:assert/strict";
import test from "node:test";
import {
  computeTextDiff,
  diffChars,
  splitLines,
} from "../src/core/text-diff";

test("splitLines normalizes CRLF and CR", () => {
  assert.deepEqual(splitLines("a\r\nb\rc\nd"), ["a", "b", "c", "d"]);
  assert.deepEqual(splitLines(""), [""]);
  assert.deepEqual(splitLines("one"), ["one"]);
});

test("identical text produces only equal rows and zero stats", () => {
  const result = computeTextDiff("a\nb\nc", "a\nb\nc");
  assert.equal(result.stats.added, 0);
  assert.equal(result.stats.removed, 0);
  assert.equal(result.stats.modified, 0);
  assert.ok(result.rows.every((row) => row.type === "equal"));
  assert.equal(result.rows.length, 3);
});

test("pure insertion is counted on the right side", () => {
  const result = computeTextDiff("a\nc", "a\nb\nc");
  assert.equal(result.stats.added, 1);
  assert.equal(result.stats.removed, 0);
  const insert = result.rows.find((row) => row.type === "insert");
  assert.ok(insert);
  assert.equal(insert.left, null);
  assert.ok(insert.right);
  assert.equal(insert.right.text, "b");
  assert.equal(insert.right.lineNumber, 2);
});

test("pure deletion is counted on the left side", () => {
  const result = computeTextDiff("a\nb\nc", "a\nc");
  assert.equal(result.stats.added, 0);
  assert.equal(result.stats.removed, 1);
  const del = result.rows.find((row) => row.type === "delete");
  assert.ok(del);
  assert.equal(del.right, null);
  assert.ok(del.left);
  assert.equal(del.left.text, "b");
  assert.equal(del.left.lineNumber, 2);
});

test("a changed line becomes a modify row with char segments", () => {
  const result = computeTextDiff("hello world", "hello brave world");
  const modify = result.rows.find((row) => row.type === "modify");
  assert.ok(modify);
  assert.ok(modify.left);
  assert.ok(modify.right);
  assert.equal(result.stats.modified, 1);
  assert.equal(result.stats.added, 1);
  assert.equal(result.stats.removed, 1);
  assert.ok(modify.left.segments && modify.left.segments.length > 0);
  assert.ok(modify.right.segments && modify.right.segments.length > 0);
  // Reassembling segments must reproduce the original lines.
  assert.equal(
    modify.left.segments.map((s) => s.text).join(""),
    "hello world",
  );
  assert.equal(
    modify.right.segments.map((s) => s.text).join(""),
    "hello brave world",
  );
});

test("ignoreWhitespace treats whitespace-only changes as equal", () => {
  const noisy = computeTextDiff("a b\tc", "ab  c");
  assert.ok(noisy.stats.added + noisy.stats.removed > 0);
  const clean = computeTextDiff("a b\tc", "ab  c", { ignoreWhitespace: true });
  assert.equal(clean.stats.added, 0);
  assert.equal(clean.stats.removed, 0);
});

test("ignoreCase treats case-only changes as equal", () => {
  const sensitive = computeTextDiff("Hello", "hello");
  assert.ok(sensitive.stats.added + sensitive.stats.removed > 0);
  const insensitive = computeTextDiff("Hello", "hello", { ignoreCase: true });
  assert.equal(insensitive.stats.added, 0);
  assert.equal(insensitive.stats.removed, 0);
});

test("diffChars marks only the differing span", () => {
  const { left, right } = diffChars("cat", "cot");
  assert.equal(left.map((s) => s.text).join(""), "cat");
  assert.equal(right.map((s) => s.text).join(""), "cot");
  // The "a"/"o" difference must be flagged as changed on both sides.
  assert.ok(left.some((s) => s.changed && s.text.includes("a")));
  assert.ok(right.some((s) => s.changed && s.text.includes("o")));
  // The shared prefix "c" and suffix "t" stay unchanged.
  assert.ok(left.some((s) => !s.changed && s.text.includes("c")));
});

test("diffChars handles unicode by code point", () => {
  const { left, right } = diffChars("café", "cafe");
  assert.equal(left.map((s) => s.text).join(""), "café");
  assert.equal(right.map((s) => s.text).join(""), "cafe");
});

test("empty vs non-empty yields inserts plus one paired empty line", () => {
  // An empty string is one empty line, which pairs with the first right line.
  const result = computeTextDiff("", "a\nb\nc");
  assert.equal(result.stats.added, 3);
  assert.equal(result.stats.removed, 1);
  assert.equal(result.stats.modified, 1);

  // A shared first line then extra lines on the right is a pure insert.
  const pureInsert = computeTextDiff("a", "a\nb\nc");
  assert.equal(pureInsert.stats.added, 2);
  assert.equal(pureInsert.stats.removed, 0);
});

test("handles large input within reasonable time", () => {
  const size = 20000;
  const left = [];
  const right = [];
  for (let i = 0; i < size; i++) {
    left.push(`line ${i}`);
    // Change roughly every 500th line so the edit distance stays modest.
    right.push(i % 500 === 0 ? `line ${i} changed` : `line ${i}`);
  }
  const started = Date.now();
  const result = computeTextDiff(left.join("\n"), right.join("\n"));
  const elapsed = Date.now() - started;
  assert.equal(result.stats.modified, size / 500);
  assert.ok(elapsed < 4000, `diff took too long: ${elapsed}ms`);
});

test("line numbers are tracked independently per side", () => {
  const result = computeTextDiff("a\nb\nc\nd", "a\nx\nc\nd");
  const modify = result.rows.find((row) => row.type === "modify");
  assert.ok(modify);
  assert.ok(modify.left);
  assert.ok(modify.right);
  assert.equal(modify.left.lineNumber, 2);
  assert.equal(modify.right.lineNumber, 2);
  const lastEqual = result.rows[result.rows.length - 1];
  assert.ok(lastEqual.left);
  assert.ok(lastEqual.right);
  assert.equal(lastEqual.left.lineNumber, 4);
  assert.equal(lastEqual.right.lineNumber, 4);
});

test("prefix/suffix trimming keeps equal ends and isolates the change", () => {
  // Only the middle line differs; shared head and tail must stay equal.
  const result = computeTextDiff("a\nb\nc\nd\ne", "a\nb\nX\nd\ne");
  const equals = result.rows.filter((row) => row.type === "equal");
  assert.equal(equals.length, 4);
  assert.equal(result.stats.modified, 1);
  // Every reconstructed line still matches its source.
  const leftText = result.rows
    .filter((row) => row.left)
    .map((row) => row.left!.text)
    .join("\n");
  assert.equal(leftText, "a\nb\nc\nd\ne");
});

test("wholesale change stays fast and remains reconstructable (budget fallback)", () => {
  // Two 50k-line texts that share nothing — the exact Myers script would be
  // astronomically large, so the diff must degrade to a block replace quickly.
  const size = 50000;
  const left = [];
  const right = [];
  for (let i = 0; i < size; i++) {
    left.push(`alpha_${i}_left`);
    right.push(`omega_${i}_right`);
  }
  const started = Date.now();
  const result = computeTextDiff(left.join("\n"), right.join("\n"));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4000, `wholesale diff took too long: ${elapsed}ms`);
  // All left lines removed and all right lines added (paired as modifies).
  assert.equal(result.stats.removed, size);
  assert.equal(result.stats.added, size);
  // Reconstruct both sides to prove the fallback script is lossless.
  const leftOut = [];
  const rightOut = [];
  for (const row of result.rows) {
    if (row.left) leftOut.push(row.left.text);
    if (row.right) rightOut.push(row.right.text);
  }
  assert.equal(leftOut.join("\n"), left.join("\n"));
  assert.equal(rightOut.join("\n"), right.join("\n"));
});

test("diffChars degrades gracefully on long unrelated strings", () => {
  const left = "x".repeat(8000);
  const right = "y".repeat(8000);
  const started = Date.now();
  const { left: ls, right: rs } = diffChars(left, right);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `char diff took too long: ${elapsed}ms`);
  assert.equal(ls.map((s) => s.text).join(""), left);
  assert.equal(rs.map((s) => s.text).join(""), right);
});
