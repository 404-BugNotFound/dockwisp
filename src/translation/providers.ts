import { detectLanguagePair } from "./language";

export interface TranslationRequest {
  text: string;
  provider: "mymemory" | "libretranslate";
  endpoint: string;
  apiKey?: string;
}

export interface TranslationResult {
  sourceText: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  provider: string;
}

function timeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}

async function translateWithMyMemory(request: TranslationRequest): Promise<TranslationResult> {
  const pair = detectLanguagePair(request.text);
  const url = new URL(request.endpoint || "https://api.mymemory.translated.net/get");
  url.searchParams.set("q", request.text.slice(0, 500));
  url.searchParams.set("langpair", `${pair.source}|${pair.target}`);
  const response = await fetch(url, { signal: timeoutSignal(12_000) });
  if (!response.ok) throw new Error(`翻译服务返回 HTTP ${response.status}`);
  const body = (await response.json()) as {
    responseStatus?: number;
    responseDetails?: string;
    responseData?: { translatedText?: string };
  };
  const translatedText = body.responseData?.translatedText?.trim();
  if (!translatedText) throw new Error(body.responseDetails || "翻译服务未返回结果");
  return {
    sourceText: request.text,
    translatedText,
    sourceLanguage: pair.source,
    targetLanguage: pair.target,
    provider: "MyMemory",
  };
}

async function translateWithLibre(request: TranslationRequest): Promise<TranslationResult> {
  const pair = detectLanguagePair(request.text);
  const endpoint = request.endpoint.replace(/\/$/, "") || "http://127.0.0.1:5000";
  const response = await fetch(`${endpoint}/translate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      q: request.text,
      source: pair.source === "zh-CN" ? "zh" : pair.source,
      target: pair.target === "zh-CN" ? "zh" : pair.target,
      format: "text",
      api_key: request.apiKey || undefined,
    }),
    signal: timeoutSignal(15_000),
  });
  if (!response.ok) throw new Error(`翻译服务返回 HTTP ${response.status}`);
  const body = (await response.json()) as { translatedText?: string; error?: string };
  if (!body.translatedText) throw new Error(body.error || "翻译服务未返回结果");
  return {
    sourceText: request.text,
    translatedText: body.translatedText.trim(),
    sourceLanguage: pair.source,
    targetLanguage: pair.target,
    provider: "LibreTranslate",
  };
}

export async function translateText(request: TranslationRequest): Promise<TranslationResult> {
  const text = request.text.trim();
  if (!text) throw new Error("没有可翻译的文本");
  if (text.length > 5_000) throw new Error("选中文本过长，请缩短后重试");
  return request.provider === "libretranslate"
    ? translateWithLibre({ ...request, text })
    : translateWithMyMemory({ ...request, text });
}
