// webui/src/lib/thinking-language.ts
// 思维链语言判定：用于决定是否展示「原文 / 译文」胶囊。
// 与后端 ThinkingTranslator 的 looksLikeTargetLanguage 同口径（CJK / 拉丁字母占比），
// 只取首段采样，避免长思维链在流式过程中被反复全量扫描。

/** 语言判定采样上限：首段足以代表整段语言 */
export const THINKING_LANGUAGE_SAMPLE_CHARS = 2048;

/**
 * 文本是否已是目标语言（字符集比例启发式）。
 * - 目标 zh：CJK 占（CJK + 拉丁字母）比例 ≥ 0.5；
 * - 目标 en：CJK 占比 ≤ 0.02；
 * - 无字母（纯符号/数字/空文本）视为未知，返回 false（需要翻译入口）。
 */
export function looksLikeLanguage(text: string, target: 'zh' | 'en'): boolean {
  let cjk = 0;
  let latin = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) cjk++;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin++;
  }
  const total = cjk + latin;
  if (total === 0) return false;
  const ratio = cjk / total;
  return target === 'zh' ? ratio >= 0.5 : ratio <= 0.02;
}

/** i18next 语言码 → 判定目标（本项目只支持 zh/en） */
export function resolveThinkingLang(language: string | undefined): 'zh' | 'en' {
  return (language ?? '').toLowerCase().startsWith('en') ? 'en' : 'zh';
}
