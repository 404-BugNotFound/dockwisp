/**
 * The built-in feature table (screenshot, settings, plugins, hosts, text diff,
 * file convert, window switch, …) and fuzzy matching for it. Pure logic: it
 * never imports electron. Each feature carries a title plus Chinese / English /
 * alias keywords; a query is scored against the title and every keyword with
 * the shared matcher (prefix, pinyin, initials) and the strongest hit wins.
 *
 * The raw matcher score is lifted into the built-in band so a solid match
 * (exact / prefix / token) ranks alongside system commands (1150–1300) and
 * ahead of an equally-relevant application, while weak fuzzy noise is dropped.
 */

import { buildSearchForms, scoreQuery } from "./matcher";
import type { SearchForms } from "./types";

export interface BuiltinFeature {
  /** Matches the `builtin:*` id the launcher already uses for each tool. */
  id: string;
  title: string;
  keywords: string[];
}

export const BUILTIN_FEATURES: BuiltinFeature[] = [
  {
    id: "builtin:settings",
    title: "设置",
    keywords: ["设置", "配置", "选项", "偏好", "settings", "config", "preferences"],
  },
  {
    id: "builtin:plugins",
    title: "插件",
    keywords: ["插件", "扩展", "插件管理", "plugins", "plugin", "extension"],
  },
  {
    id: "builtin:screenshot",
    title: "截图",
    keywords: ["截图", "截屏", "区域截图", "screenshot", "capture", "snip", "ocr"],
  },
  {
    id: "builtin:hosts",
    title: "hosts 切换",
    keywords: ["hosts", "hosts切换", "切换hosts", "域名", "host"],
  },
  {
    id: "builtin:diff",
    title: "文本对比",
    keywords: ["文本对比", "对比", "比较", "文本比较", "差异", "diff", "compare"],
  },
  {
    id: "builtin:convert",
    title: "文件转换",
    keywords: ["文件转换", "格式转换", "转换", "convert", "transform"],
  },
  {
    id: "builtin:window-search",
    title: "切换窗口",
    keywords: ["切换窗口", "窗口", "window", "switch window"],
  },
  {
    id: "builtin:translate-window",
    title: "翻译",
    keywords: ["翻译", "文本翻译", "translate", "translation"],
  },
];

/** Precompute the search forms for every title + keyword once at load time. */
const FEATURE_FORMS: Array<{ id: string; forms: SearchForms[] }> = BUILTIN_FEATURES.map(
  (feature) => ({
    id: feature.id,
    forms: [feature.title, ...feature.keywords].map((text) => buildSearchForms(text)),
  }),
);

/**
 * The weakest matcher tier we accept. scoreQuery returns substring/prefix/token
 * hits at 600+ and pure subsequence noise below ~450; this floor keeps real
 * matches (including pinyin/initials) while dropping incidental letters.
 */
const MIN_RAW_SCORE = 500;
/** Lifts a matched feature into the built-in band (system commands: 1150–1300). */
const BUILTIN_SCORE_BOOST = 250;
/** Keep built-ins below primary tools (currency/unit at 1750+). */
const BUILTIN_SCORE_CAP = 1300;

export interface BuiltinFeatureMatch {
  id: string;
  score: number;
}

/**
 * Score every built-in feature against `query` and return the ones that match,
 * strongest first. An empty/whitespace query matches nothing.
 */
export function matchBuiltinFeatures(query: string): BuiltinFeatureMatch[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const matches: BuiltinFeatureMatch[] = [];
  for (const feature of FEATURE_FORMS) {
    let best = -1;
    for (const forms of feature.forms) {
      const raw = scoreQuery(normalized, forms);
      if (raw > best) best = raw;
    }
    if (best < MIN_RAW_SCORE) continue;
    matches.push({
      id: feature.id,
      score: Math.min(BUILTIN_SCORE_CAP, Math.round(best) + BUILTIN_SCORE_BOOST),
    });
  }
  return matches.sort((left, right) => right.score - left.score);
}

/** Score for a sentence-like English query: shown first, but below built-ins. */
const ENGLISH_SENTENCE_SCORE = 1_050;
/** Score for a single English word: listed, but below matching applications. */
const ENGLISH_WORD_SCORE = 150;

/**
 * Decide whether a query reads as English text worth offering a translation
 * for, and how prominently. Returns -1 when it does not. URLs, paths, e-mail
 * addresses, CJK text and number-heavy expressions are excluded; a lone word is
 * offered with a low score so app results (e.g. "chrome") stay on top.
 */
export function englishTranslateScore(query: string): number {
  const text = query.trim();
  if (text.length < 2 || text.length > 5_000) return -1;
  if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text)) return -1;
  if (/:\/\/|^www\.|[\\/]|@|^[a-z]:/i.test(text)) return -1;
  const compact = text.replace(/\s+/g, "");
  const letters = (compact.match(/[a-z]/gi) ?? []).length;
  if (letters < 2 || letters / compact.length < 0.7) return -1;
  const words = text.split(/\s+/).filter((word) => /[a-z]{2,}/i.test(word));
  if (words.length >= 2 || letters >= 16) return ENGLISH_SENTENCE_SCORE;
  return words.length === 1 ? ENGLISH_WORD_SCORE : -1;
}
