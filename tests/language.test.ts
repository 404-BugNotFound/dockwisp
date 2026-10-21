import assert from "node:assert/strict";
import test from "node:test";
import {
  detectLanguage,
  detectLanguagePair,
  resolveLanguagePair,
} from "../src/translation/language";

test("chooses English for Chinese and Chinese for English", () => {
  assert.deepEqual(detectLanguagePair("这是一个测试"), { source: "zh-CN", target: "en" });
  assert.deepEqual(detectLanguagePair("Hello world"), { source: "en", target: "zh-CN" });
});

test("detectLanguage recognizes Japanese kana and Korean hangul", () => {
  assert.equal(detectLanguage("こんにちは"), "ja");
  assert.equal(detectLanguage("カタカナ"), "ja");
  assert.equal(detectLanguage("안녕하세요"), "ko");
  assert.equal(detectLanguage("这是中文"), "zh-CN");
  assert.equal(detectLanguage("Hello"), "en");
  assert.equal(detectLanguage("123 !!!"), "en");
});

test("resolveLanguagePair honours explicit codes and auto fallbacks", () => {
  assert.deepEqual(resolveLanguagePair("hello", "en", "ja"), { source: "en", target: "ja" });
  // auto target: Chinese source goes to English, otherwise to Chinese.
  assert.deepEqual(resolveLanguagePair("这是中文", "auto", "auto"), {
    source: "zh-CN",
    target: "en",
  });
  assert.deepEqual(resolveLanguagePair("안녕하세요", "auto", "auto"), {
    source: "ko",
    target: "zh-CN",
  });
  // explicit source, auto target.
  assert.deepEqual(resolveLanguagePair("whatever", "fr", "auto"), {
    source: "fr",
    target: "zh-CN",
  });
});
