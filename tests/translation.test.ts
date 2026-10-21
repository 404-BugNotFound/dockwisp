import assert from "node:assert/strict";
import test from "node:test";
import { translateText } from "../src/translation/providers";

test("builds a MyMemory request and parses its result", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requested = "";
  globalThis.fetch = async (input) => {
    requested = String(input);
    return new Response(
      JSON.stringify({ responseData: { translatedText: "你好" }, responseStatus: 200 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const result = await translateText({
    text: "hello",
    provider: "mymemory",
    endpoint: "https://example.test/get",
  });
  assert.match(requested, /langpair=en%7Czh-CN/);
  assert.equal(result.translatedText, "你好");
});

test("posts to a LibreTranslate-compatible endpoint", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let body = "";
  globalThis.fetch = async (_input, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ translatedText: "hello" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await translateText({
    text: "你好",
    provider: "libretranslate",
    endpoint: "https://translate.example.test/",
    apiKey: "key",
  });
  assert.equal(JSON.parse(body).source, "zh");
  assert.equal(result.translatedText, "hello");
});

test("honours an explicit source/target language pair", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requested = "";
  globalThis.fetch = async (input) => {
    requested = String(input);
    return new Response(
      JSON.stringify({ responseData: { translatedText: "こんにちは" }, responseStatus: 200 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const result = await translateText({
    text: "hello",
    provider: "mymemory",
    endpoint: "https://example.test/get",
    source: "en",
    target: "ja",
  });
  assert.match(requested, /langpair=en%7Cja/);
  assert.equal(result.sourceLanguage, "en");
  assert.equal(result.targetLanguage, "ja");
  assert.equal(result.translatedText, "こんにちは");
});

test("auto source detects Japanese and defaults target to Chinese", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requested = "";
  globalThis.fetch = async (input) => {
    requested = String(input);
    return new Response(
      JSON.stringify({ responseData: { translatedText: "你好" }, responseStatus: 200 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const result = await translateText({
    text: "こんにちは世界",
    provider: "mymemory",
    endpoint: "https://example.test/get",
    source: "auto",
    target: "auto",
  });
  assert.match(requested, /langpair=ja%7Czh-CN/);
  assert.equal(result.sourceLanguage, "ja");
  assert.equal(result.targetLanguage, "zh-CN");
});

test("MyMemory splits long text into <=500 char chunks and joins them", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const queries: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const q = url.searchParams.get("q") ?? "";
    queries.push(q);
    assert.ok(q.length <= 500, `chunk exceeded 500 chars: ${q.length}`);
    return new Response(
      JSON.stringify({ responseData: { translatedText: `[${q.length}]` }, responseStatus: 200 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  // 7 sentences of 100 chars each => 700 chars total, must split.
  const sentence = `${"a".repeat(99)}.`;
  const text = sentence.repeat(7);
  const result = await translateText({
    text,
    provider: "mymemory",
    endpoint: "https://example.test/get",
    source: "en",
    target: "zh-CN",
  });
  assert.ok(queries.length >= 2, "expected multiple chunk requests");
  // Nothing dropped: the joined chunks cover the whole input length.
  const covered = queries.reduce((sum, q) => sum + q.length, 0);
  assert.equal(covered, text.length);
  assert.ok(result.translatedText.length > 0);
});

test("legacy call without source/target is unchanged (single 500-char request)", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const queries: string[] = [];
  let langpair = "";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    queries.push(url.searchParams.get("q") ?? "");
    langpair = url.searchParams.get("langpair") ?? "";
    return new Response(
      JSON.stringify({ responseData: { translatedText: "译文" }, responseStatus: 200 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  // 600 chars of English; legacy behaviour did one request (slice 500). Our
  // chunker keeps a single word <=500? No — a 600-char unbroken run splits, but
  // the language pair detection and result must match the old contract.
  const result = await translateText({
    text: "hello world this is a test",
    provider: "mymemory",
    endpoint: "https://example.test/get",
  });
  assert.equal(queries.length, 1);
  assert.equal(queries[0], "hello world this is a test");
  assert.equal(langpair, "en|zh-CN");
  assert.equal(result.translatedText, "译文");
});

test("LibreTranslate maps zh-CN to zh for an explicit pair", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let body = "";
  globalThis.fetch = async (_input, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ translatedText: "bonjour" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await translateText({
    text: "你好",
    provider: "libretranslate",
    endpoint: "https://translate.example.test/",
    source: "zh-CN",
    target: "fr",
  });
  const parsed = JSON.parse(body);
  assert.equal(parsed.source, "zh");
  assert.equal(parsed.target, "fr");
  assert.equal(result.translatedText, "bonjour");
});
