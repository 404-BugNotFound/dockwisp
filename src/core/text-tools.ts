import { createHash } from "node:crypto";

/**
 * Pure text utilities for the launcher (JSON/Base64/timestamp/hash/regex). Each
 * returns a small descriptor the main process maps onto a BuiltinMatch.
 */
export interface TextToolResult {
  /** "copy" offers Enter-to-copy; "info" is a non-copyable notice. */
  action: "copy" | "info";
  title: string;
  subtitle: string;
  /** Text copied to the clipboard for "copy" results. */
  payload: string;
  /** Suggested score; auto-detected formats score slightly lower. */
  score: number;
}

function splitPrefix(text: string): { prefix: string; rest: string } | null {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { prefix: match[1].toLowerCase(), rest: match[2] ?? "" };
}

function prettyJson(raw: string): TextToolResult {
  try {
    const parsed = JSON.parse(raw);
    const pretty = JSON.stringify(parsed, null, 2);
    return {
      action: "copy",
      title: pretty,
      subtitle: "JSON 格式化 · Enter 复制",
      payload: pretty,
      score: 1600,
    };
  } catch (error) {
    return {
      action: "info",
      title: "JSON 解析失败",
      subtitle: error instanceof Error ? error.message : String(error),
      payload: "",
      score: 1600,
    };
  }
}

function encodeBase64(text: string): TextToolResult {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return {
    action: "copy",
    title: encoded,
    subtitle: "Base64 编码 · Enter 复制",
    payload: encoded,
    score: 1600,
  };
}

function decodeBase64(text: string): TextToolResult | null {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/=\s]+$/.test(trimmed) || !trimmed) return null;
  const buffer = Buffer.from(trimmed, "base64");
  if (!buffer.length) return null;
  const decoded = buffer.toString("utf8");
  // Reject lossy decodes (non UTF-8 input round-trips to U+FFFD).
  if (decoded.includes("\uFFFD")) return null;
  if (Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/, "") !==
    trimmed.replace(/\s/g, "").replace(/=+$/, "")) {
    return null;
  }
  return {
    action: "copy",
    title: decoded,
    subtitle: "Base64 解码 · Enter 复制",
    payload: decoded,
    score: 1600,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalDate(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** UTC offset label for the local timezone, e.g. "UTC+8" or "UTC-5:30". */
function localOffsetLabel(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const rest = absolute % 60;
  return rest ? `UTC${sign}${hours}:${pad(rest)}` : `UTC${sign}${hours}`;
}

function timestampTool(raw: string, now: Date): TextToolResult | null {
  const value = raw.trim();
  if (!value || value.toLowerCase() === "now") {
    const seconds = Math.floor(now.getTime() / 1000);
    return {
      action: "copy",
      title: formatLocalDate(now),
      subtitle: `时间戳 · ${seconds} · ${localOffsetLabel(now)}`,
      payload: formatLocalDate(now),
      score: 1600,
    };
  }
  if (/^\d{10}$/.test(value)) {
    const date = new Date(Number(value) * 1000);
    return {
      action: "copy",
      title: formatLocalDate(date),
      subtitle: `时间戳 · ${value} · ${localOffsetLabel(date)}`,
      payload: formatLocalDate(date),
      score: 1600,
    };
  }
  if (/^\d{13}$/.test(value)) {
    const date = new Date(Number(value));
    return {
      action: "copy",
      title: formatLocalDate(date),
      subtitle: `时间戳 · ${value} · ${localOffsetLabel(date)}`,
      payload: formatLocalDate(date),
      score: 1600,
    };
  }
  // Date-like input -> seconds timestamp.
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    const seconds = Math.floor(parsed / 1000);
    return {
      action: "copy",
      title: String(seconds),
      subtitle: "时间 → 时间戳",
      payload: String(seconds),
      score: 1600,
    };
  }
  return null;
}

function hashTool(algorithm: "md5" | "sha1" | "sha256", text: string): TextToolResult | null {
  if (!text) return null;
  const digest = createHash(algorithm).update(text, "utf8").digest("hex");
  return {
    action: "copy",
    title: digest,
    subtitle: `${algorithm.toUpperCase()} · Enter 复制`,
    payload: digest,
    score: 1600,
  };
}

function regexTool(rest: string): TextToolResult | null {
  const separator = rest.indexOf("::");
  if (separator < 0) return null;
  const patternPart = rest.slice(0, separator).trim();
  const subject = rest.slice(separator + 2).slice(0, 10_000);
  const slashMatch = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(patternPart);
  const source = slashMatch ? slashMatch[1] : patternPart;
  const flags = slashMatch ? slashMatch[2] : "";
  let regex: RegExp;
  try {
    regex = new RegExp(source, flags.includes("g") ? flags : `${flags}g`);
  } catch (error) {
    return {
      action: "info",
      title: "正则表达式无效",
      subtitle: error instanceof Error ? error.message : String(error),
      payload: "",
      score: 1600,
    };
  }
  const matches = subject.match(regex) ?? [];
  if (!matches.length) {
    return {
      action: "info",
      title: "无匹配",
      subtitle: "正则匹配 · 0 项",
      payload: "",
      score: 1600,
    };
  }
  const joined = matches.join("\n");
  return {
    action: "copy",
    title: joined,
    subtitle: `正则匹配 · ${matches.length} 项`,
    payload: joined,
    score: 1600,
  };
}

/**
 * Resolve a text tool from the input. Triggers only on explicit prefixes
 * (json/b64/b64d/base64d/ts/md5/sha1/sha256/regex), auto JSON ({/[ ...), and
 * auto bare 10/13-digit timestamps. Returns null otherwise.
 */
export function resolveTextTool(
  text: string,
  now: Date = new Date(),
): TextToolResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Auto JSON: whole input is an object/array literal that parses.
  if (/^[[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return prettyJson(trimmed);
    } catch {
      // Fall through; only auto-trigger JSON when it actually parses.
    }
  }

  // Auto date-like input -> seconds timestamp. Checked before auto timestamps
  // and before arithmetic so "2026-10-19" is not evaluated as subtraction.
  if (/^\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.test(trimmed)) {
    const result = timestampTool(trimmed, now);
    if (result) return { ...result, score: 1500 };
  }

  // Auto bare timestamp (slightly lower score so it is easy to override).
  if (/^\d{10}$/.test(trimmed) || /^\d{13}$/.test(trimmed)) {
    const result = timestampTool(trimmed, now);
    if (result) return { ...result, score: 1500 };
  }

  const split = splitPrefix(trimmed);
  if (!split) return null;
  const { prefix, rest } = split;

  switch (prefix) {
    case "json":
      return prettyJson(rest);
    case "b64":
      return rest ? encodeBase64(rest) : null;
    case "b64d":
    case "base64d":
      return rest ? decodeBase64(rest) : null;
    case "ts":
      return timestampTool(rest, now);
    case "md5":
      return hashTool("md5", rest);
    case "sha1":
      return hashTool("sha1", rest);
    case "sha256":
      return hashTool("sha256", rest);
    case "regex":
      return regexTool(rest);
    default:
      return null;
  }
}
