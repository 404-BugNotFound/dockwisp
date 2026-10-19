export interface LanguagePair {
  source: string;
  target: string;
}

export function detectLanguagePair(text: string): LanguagePair {
  const meaningful = text.replace(/[\s\d\p{P}\p{S}]/gu, "");
  if (!meaningful) return { source: "en", target: "zh-CN" };
  const chinese = (meaningful.match(/[\u3400-\u9fff]/g) ?? []).length;
  return chinese / meaningful.length >= 0.2
    ? { source: "zh-CN", target: "en" }
    : { source: "en", target: "zh-CN" };
}
