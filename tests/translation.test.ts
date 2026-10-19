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
