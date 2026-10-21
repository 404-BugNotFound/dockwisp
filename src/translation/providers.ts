import { detectLanguagePair, resolveLanguagePair, LanguagePair } from "./language";

export interface TranslationRequest {
  text: string;
  provider: "mymemory" | "libretranslate";
  endpoint: string;
  apiKey?: string;
  /** "auto" or a language code (e.g. "en", "zh-CN"). Omit to keep legacy behaviour. */
  source?: string;
  /** "auto" or a language code. Omit to keep legacy behaviour. */
  target?: string;
}

export interface TranslationResult {
  sourceText: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  provider: string;
}

const MYMEMORY_CHUNK = 500;

function timeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}

/**
 * Pick the language pair. When neither source nor target is supplied the call
 * is a legacy one (OCR screenshot / middle-click selection) and must behave
 * exactly as before — a binary Chinese/English guess. If either is supplied,
 * resolve with the broader detector that also knows Japanese and Korean.
 */
function pairFor(request: TranslationRequest): LanguagePair {
  if (request.source === undefined && request.target === undefined) {
    return detectLanguagePair(request.text);
  }
  return resolveLanguagePair(request.text, request.source, request.target);
}

/** LibreTranslate uses bare ISO codes; map our "zh-CN" style to them. */
function libreCode(code: string): string {
  if (code === "zh-CN" || code === "zh-TW") return "zh";
  return code;
}

/**
 * Split text into pieces no longer than MYMEMORY_CHUNK, preferring to break on
 * line breaks and then sentence punctuation so each request stays coherent. A
 * single run longer than the limit is hard-split as a last resort.
 */
function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current) chunks.push(current);
    current = "";
  };

  // Split into sentence-ish units while keeping their trailing delimiters.
  const units = text.match(/[^\n。．.!?！？]*(?:[\n。．.!?！？]+|$)/gu) ?? [text];
  for (const unit of units) {
    if (!unit) continue;
    if (unit.length > limit) {
      flush();
      for (let i = 0; i < unit.length; i += limit) {
        chunks.push(unit.slice(i, i + limit));
      }
      continue;
    }
    if (current.length + unit.length > limit) flush();
    current += unit;
  }
  flush();
  return chunks.filter((chunk) => chunk.length > 0);
}

async function myMemoryChunk(
  endpoint: string,
  chunk: string,
  pair: LanguagePair,
): Promise<string> {
  const url = new URL(endpoint || "https://api.mymemory.translated.net/get");
  url.searchParams.set("q", chunk);
  url.searchParams.set("langpair", `${pair.source}|${pair.target}`);
  const response = await fetch(url, { signal: timeoutSignal(12_000) });
  if (!response.ok) throw new Error(`翻译服务返回 HTTP ${response.status}`);
  const body = (await response.json()) as {
    responseStatus?: number;
    responseDetails?: string;
    responseData?: { translatedText?: string };
  };
  const translatedText = body.responseData?.translatedText;
  if (translatedText === undefined || translatedText === null || translatedText === "") {
    throw new Error(body.responseDetails || "翻译服务未返回结果");
  }
  return translatedText;
}

async function translateWithMyMemory(request: TranslationRequest): Promise<TranslationResult> {
  const pair = pairFor(request);
  const endpoint = request.endpoint || "https://api.mymemory.translated.net/get";
  const chunks = chunkText(request.text, MYMEMORY_CHUNK);
  const parts: string[] = [];
  for (const chunk of chunks) {
    // Sequential requests keep order and stay within the free-tier rate limit.
    parts.push(await myMemoryChunk(endpoint, chunk, pair));
  }
  const translatedText = parts.join("").trim();
  if (!translatedText) throw new Error("翻译服务未返回结果");
  return {
    sourceText: request.text,
    translatedText,
    sourceLanguage: pair.source,
    targetLanguage: pair.target,
    provider: "MyMemory",
  };
}

async function translateWithLibre(request: TranslationRequest): Promise<TranslationResult> {
  const pair = pairFor(request);
  const endpoint = request.endpoint.replace(/\/$/, "") || "http://127.0.0.1:5000";
  const response = await fetch(`${endpoint}/translate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      q: request.text,
      source: pair.source === "auto" ? "auto" : libreCode(pair.source),
      target: libreCode(pair.target),
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
