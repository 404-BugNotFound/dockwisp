import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  convertCurrency,
  convertUnits,
  evaluateExpression,
  parseCurrencyPair,
} from "../src/core/calculator";
import { resolveTextTool } from "../src/core/text-tools";

// --- Calculator -----------------------------------------------------------

test("evaluates arithmetic with precedence and parentheses", () => {
  assert.equal(evaluateExpression("1 + 2 * 3")?.display, "7");
  assert.equal(evaluateExpression("(1 + 2) * 3")?.display, "9");
  assert.equal(evaluateExpression("2 ^ 10")?.display, "1024");
  assert.equal(evaluateExpression("2 ^ -1")?.display, "0.5");
});

test("handles percent, constants, functions and normalization", () => {
  assert.equal(evaluateExpression("50%")?.display, "0.5");
  assert.equal(evaluateExpression("200 * 15%")?.display, "30");
  assert.equal(evaluateExpression("sqrt(16)")?.display, "4");
  assert.equal(evaluateExpression("round(pi)")?.display, "3");
  assert.equal(evaluateExpression("10 × 2")?.display, "20");
  assert.equal(evaluateExpression("1,000 + 1")?.display, "1001");
});

test("avoids floating-point noise", () => {
  assert.equal(evaluateExpression("0.1 + 0.2")?.display, "0.3");
});

test("rejects bare numbers and non-expressions", () => {
  assert.equal(evaluateExpression("42"), null);
  assert.equal(evaluateExpression("1password"), null);
  assert.equal(evaluateExpression(""), null);
  assert.equal(evaluateExpression("hello world"), null);
});

// --- Unit conversion ------------------------------------------------------

test("converts length with multiple syntaxes", () => {
  assert.equal(convertUnits("10 km mi")?.display, "6.213711922 mi");
  assert.equal(convertUnits("10 km to mi")?.display, "6.213711922 mi");
  assert.equal(convertUnits("10km→mi")?.display, "6.213711922 mi");
});

test("converts temperature with affine formulas", () => {
  assert.equal(convertUnits("100 c f")?.value, 212);
  assert.equal(convertUnits("32 f c")?.value, 0);
  assert.equal(convertUnits("0 c k")?.value, 273.15);
});

test("converts data using 1024-based units", () => {
  assert.equal(convertUnits("1 gb mb")?.value, 1024);
  assert.equal(convertUnits("1024 kb mb")?.value, 1);
});

test("converts speed units with a slash", () => {
  const converted = convertUnits("100 km/h mph");
  assert.ok(converted !== null);
  assert.ok(Math.abs(converted!.value - 62.1371192237) < 1e-6);
});

test("rejects incompatible or unknown units", () => {
  assert.equal(convertUnits("10 km kg"), null);
  assert.equal(convertUnits("10 foo bar"), null);
  assert.equal(convertUnits("10 km km"), null);
});

// --- Currency -------------------------------------------------------------

test("parses and converts currency with a mock rate map", () => {
  const rates = { USD: 1, CNY: 7.1234, EUR: 0.92 };
  const pair = parseCurrencyPair("100 USD to CNY");
  assert.deepEqual(pair, { amount: 100, from: "USD", to: "CNY" });
  const converted = convertCurrency(pair!.amount, pair!.from, pair!.to, rates);
  assert.ok(converted !== null);
  assert.ok(Math.abs(converted! - 712.34) < 1e-6);
  // Cross rate through USD base.
  const eurToCny = convertCurrency(10, "EUR", "CNY", rates);
  assert.ok(Math.abs(eurToCny! - (10 / 0.92) * 7.1234) < 1e-6);
});

test("currency pair detection ignores non-currency tokens", () => {
  assert.equal(parseCurrencyPair("10 km mi"), null);
  assert.equal(parseCurrencyPair("100 usd"), null);
  assert.equal(convertCurrency(1, "USD", "XXX", { USD: 1 }), null);
});

// --- Text tools -----------------------------------------------------------

test("formats valid JSON and reports invalid JSON", () => {
  const good = resolveTextTool('json {"a":1,"b":[2,3]}');
  assert.equal(good?.action, "copy");
  assert.equal(good?.payload, '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  const auto = resolveTextTool('{"x":1}');
  assert.equal(auto?.action, "copy");
  const bad = resolveTextTool("json {nope}");
  assert.equal(bad?.action, "info");
  assert.equal(bad?.title, "JSON 解析失败");
});

test("base64 encodes and decodes round trip", () => {
  const encoded = resolveTextTool("b64 hello 世界");
  assert.equal(encoded?.action, "copy");
  const decoded = resolveTextTool(`b64d ${encoded?.payload}`);
  assert.equal(decoded?.payload, "hello 世界");
  assert.equal(resolveTextTool("base64d !!!not base64!!!"), null);
});

test("formats timestamps both directions", () => {
  const now = new Date(2026, 9, 19, 12, 0, 0);
  const seconds = Math.floor(now.getTime() / 1000);
  const fromSeconds = resolveTextTool(`ts ${seconds}`, now);
  assert.equal(fromSeconds?.action, "copy");
  assert.equal(fromSeconds?.title, "2026-10-19 12:00:00");
  // Auto-detect a bare 10-digit timestamp with the lower score.
  const auto = resolveTextTool(String(seconds), now);
  assert.equal(auto?.score, 1500);
  assert.equal(auto?.title, "2026-10-19 12:00:00");
  const toSeconds = resolveTextTool("ts 2026-10-19 12:00:00", now);
  assert.equal(toSeconds?.title, String(seconds));
  assert.equal(toSeconds?.subtitle, "时间 → 时间戳");
  // A bare date-like input is a timestamp tool, not subtraction.
  const autoDate = resolveTextTool("2026-10-19", now);
  assert.equal(autoDate?.score, 1500);
  assert.equal(autoDate?.subtitle, "时间 → 时间戳");
});

test("computes hash digests", () => {
  const md5 = resolveTextTool("md5 hello");
  assert.equal(md5?.payload, createHash("md5").update("hello").digest("hex"));
  const sha256 = resolveTextTool("sha256 hello");
  assert.equal(sha256?.payload, createHash("sha256").update("hello").digest("hex"));
});

test("applies regex and reports invalid patterns", () => {
  const matches = resolveTextTool("regex /\\d+/ :: a1 b22 c333");
  assert.equal(matches?.action, "copy");
  assert.equal(matches?.payload, "1\n22\n333");
  const none = resolveTextTool("regex /zzz/ :: abc");
  assert.equal(none?.action, "info");
  assert.equal(none?.title, "无匹配");
  const invalid = resolveTextTool("regex /([/ :: abc");
  assert.equal(invalid?.action, "info");
  assert.equal(invalid?.title, "正则表达式无效");
  assert.equal(resolveTextTool("regex /\\d+/ abc"), null);
});

test("does not hijack arbitrary text", () => {
  assert.equal(resolveTextTool("hello world"), null);
  assert.equal(resolveTextTool("1password"), null);
});
