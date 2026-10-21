import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOcrText, ocrResizeDimensions } from "../src/main/ocr";

test("removes spaces the OCR engine inserts between CJK characters", () => {
  assert.equal(normalizeOcrText("截 图 测 试"), "截图测试");
  assert.equal(normalizeOcrText("你 好 世 界"), "你好世界");
});

test("keeps spaces between Latin words", () => {
  assert.equal(normalizeOcrText("Hello world 2026"), "Hello world 2026");
});

test("strips CJK spacing but preserves CJK-Latin boundaries", () => {
  assert.equal(normalizeOcrText("Dockwisp 截 图 OCR 测 试"), "Dockwisp 截图 OCR 测试");
});

test("drops spaces before CJK punctuation", () => {
  assert.equal(normalizeOcrText("你好 ，世界 。"), "你好，世界。");
});

test("preserves line breaks", () => {
  assert.equal(
    normalizeOcrText("第 一 行\n第 二 行"),
    "第一行\n第二行",
  );
  assert.equal(
    normalizeOcrText("Hello world\n截 图 测 试"),
    "Hello world\n截图测试",
  );
});

test("normalizes CRLF to LF and trims trailing whitespace", () => {
  assert.equal(normalizeOcrText("第 一 行  \r\n第 二 行"), "第一行\n第二行");
});

test("upscales small OCR captures without exceeding the model input size", () => {
  assert.deepEqual(ocrResizeDimensions(500, 64), { width: 1000, height: 128 });
  assert.deepEqual(ocrResizeDimensions(1200, 800), { width: 1920, height: 1280 });
  assert.equal(ocrResizeDimensions(1920, 1080), null);
  assert.equal(ocrResizeDimensions(0, 100), null);
});
