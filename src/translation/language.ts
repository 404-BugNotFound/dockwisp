export interface LanguagePair {
  source: string;
  target: string;
}

/**
 * Original auto-detection used by OCR-screenshot translation and middle-click
 * selection translation: a binary Chinese/English guess. Kept byte-for-byte in
 * behaviour so those callers are unaffected.
 */
export function detectLanguagePair(text: string): LanguagePair {
  const meaningful = text.replace(/[\s\d\p{P}\p{S}]/gu, "");
  if (!meaningful) return { source: "en", target: "zh-CN" };
  const chinese = (meaningful.match(/[\u3400-\u9fff]/g) ?? []).length;
  return chinese / meaningful.length >= 0.2
    ? { source: "zh-CN", target: "en" }
    : { source: "en", target: "zh-CN" };
}

/**
 * Broader single-language guess for the translation editor window, where the
 * user may paste Japanese or Korean. Returns a language code compatible with
 * the provider mapping ("zh-CN", "en", "ja", "ko"). This is a heuristic script
 * sniff, not a full language classifier.
 */
export function detectLanguage(text: string): string {
  const meaningful = text.replace(/[\s\d\p{P}\p{S}]/gu, "");
  if (!meaningful) return "en";

  // Hangul (Korean) syllables and jamo.
  const korean = (meaningful.match(/[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]/g) ?? []).length;
  // Hiragana + Katakana are unambiguously Japanese.
  const kana = (meaningful.match(/[\u3040-\u309f\u30a0-\u30ff]/g) ?? []).length;
  // Han characters: shared by Chinese and Japanese kanji.
  const han = (meaningful.match(/[\u3400-\u9fff]/g) ?? []).length;
  const total = meaningful.length;

  if (korean / total >= 0.2) return "ko";
  if (kana / total >= 0.1) return "ja";
  if (han / total >= 0.2) return "zh-CN";
  return "en";
}

/**
 * Resolve a requested source/target (each may be "auto" or a concrete code)
 * into a concrete language pair. Falls back to the Chinese/English auto logic
 * extended with Japanese/Korean detection.
 */
export function resolveLanguagePair(
  text: string,
  source?: string,
  target?: string,
): LanguagePair {
  const resolvedSource = !source || source === "auto" ? detectLanguage(text) : source;
  let resolvedTarget = target;
  if (!resolvedTarget || resolvedTarget === "auto") {
    resolvedTarget = resolvedSource === "zh-CN" ? "en" : "zh-CN";
  }
  return { source: resolvedSource, target: resolvedTarget };
}
