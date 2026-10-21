import assert from "node:assert/strict";
import test from "node:test";
import { englishTranslateScore, matchBuiltinFeatures } from "../src/core/builtin-features";

/** Ids present in the result, strongest first. */
function ids(query: string): string[] {
  return matchBuiltinFeatures(query).map((match) => match.id);
}

test("single char 文 hits both 文件转换 and 文本对比", () => {
  const hits = ids("文");
  assert.ok(hits.includes("builtin:convert"), "应命中文件转换");
  assert.ok(hits.includes("builtin:diff"), "应命中文本对比");
});

test("文件 hits 文件转换", () => {
  assert.ok(ids("文件").includes("builtin:convert"));
});

test("对比 / diff / wbdb all hit 文本对比", () => {
  assert.ok(ids("对比").includes("builtin:diff"), "对比");
  assert.ok(ids("diff").includes("builtin:diff"), "diff");
  assert.ok(ids("compare").includes("builtin:diff"), "compare");
  assert.ok(ids("wbdb").includes("builtin:diff"), "wbdb 首字母");
});

test("转换 and convert and wjzh hit 文件转换", () => {
  assert.ok(ids("转换").includes("builtin:convert"), "转换");
  assert.ok(ids("convert").includes("builtin:convert"), "convert");
  assert.ok(ids("wjzh").includes("builtin:convert"), "wjzh 首字母");
  assert.ok(ids("gszh").includes("builtin:convert"), "格式转换首字母 gszh");
});

test("hosts and 域名 hit hosts 切换", () => {
  assert.ok(ids("hosts").includes("builtin:hosts"), "hosts");
  assert.ok(ids("域名").includes("builtin:hosts"), "域名");
});

test("截图 / screenshot / jt hit 截图", () => {
  assert.ok(ids("截图").includes("builtin:screenshot"), "截图");
  assert.ok(ids("screenshot").includes("builtin:screenshot"), "screenshot");
  assert.ok(ids("jt").includes("builtin:screenshot"), "jt 首字母");
});

test("设置 / settings hit 设置", () => {
  assert.ok(ids("设置").includes("builtin:settings"), "设置");
  assert.ok(ids("settings").includes("builtin:settings"), "settings");
  assert.ok(ids("sz").includes("builtin:settings"), "sz 首字母");
});

test("插件 / plugins hit 插件", () => {
  assert.ok(ids("插件").includes("builtin:plugins"), "插件");
  assert.ok(ids("plugins").includes("builtin:plugins"), "plugins");
});

test("窗口 / window hit 切换窗口", () => {
  assert.ok(ids("窗口").includes("builtin:window-search"), "窗口");
  assert.ok(ids("window").includes("builtin:window-search"), "window");
});

test("unrelated words do not match", () => {
  assert.deepEqual(matchBuiltinFeatures(""), []);
  assert.deepEqual(matchBuiltinFeatures("   "), []);
  assert.equal(ids("qwerty").length, 0, "qwerty 不应命中");
  assert.equal(ids("天气预报").length, 0, "天气预报 不应命中");
  assert.equal(ids("zxcvbnm").length, 0, "随机字母不应命中");
});

test("exact title scores land in the built-in band", () => {
  const convert = matchBuiltinFeatures("文件转换").find((m) => m.id === "builtin:convert");
  assert.ok(convert);
  assert.ok(convert!.score >= 1150, `文件转换 分数 ${convert!.score} 应进入内置区间`);
});

test("翻译 / translate / fy hit the translation window", () => {
  assert.ok(ids("翻译").includes("builtin:translate-window"), "翻译");
  assert.ok(ids("translate").includes("builtin:translate-window"), "translate");
  assert.ok(ids("fy").includes("builtin:translate-window"), "fy 首字母");
});

test("englishTranslateScore ranks sentences high and single words low", () => {
  const sentence = englishTranslateScore("How are you today?");
  const word = englishTranslateScore("chrome");
  assert.ok(sentence >= 1000, `句子分数 ${sentence}`);
  assert.ok(word > 100 && word < 600, `单词分数 ${word} 应低于应用匹配`);
  assert.ok(englishTranslateScore("internationalization") >= 1000, "长单词视为句子");
});

test("englishTranslateScore ignores non-English and non-text input", () => {
  for (const value of [
    "",
    "a",
    "你好世界",
    "hello 世界",
    "https://example.com",
    "www.example.com",
    "C:\\Windows",
    "src/main",
    "user@example.com",
    "1+2*3",
    "100 usd",
  ]) {
    assert.equal(englishTranslateScore(value), -1, value);
  }
});
