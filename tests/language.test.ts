import assert from "node:assert/strict";
import test from "node:test";
import { detectLanguagePair } from "../src/translation/language";

test("chooses English for Chinese and Chinese for English", () => {
  assert.deepEqual(detectLanguagePair("这是一个测试"), { source: "zh-CN", target: "en" });
  assert.deepEqual(detectLanguagePair("Hello world"), { source: "en", target: "zh-CN" });
});
