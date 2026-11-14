// src/modules/voice/language.ts
// ASR 语言与文本后处理的纯函数（无原生依赖，便于单测）。
//
// 目标：
// - auto 模式不再依赖单一模型 lang：模型输出 + 文字脚本双重校验，短句/噪声段复用会话语言；
// - 清理 Whisper/SenseVoice 在静音、音乐、噪声上产生的非语音标记；
// - 规范化中英混排空格与重复标点，避免把识别噪声直接写进输入框。

export type ScriptLanguage = 'zh' | 'ja' | 'ko' | 'latin' | 'other';

/** 非语音标记（大小写不敏感；含 Whisper 常见幻觉标签） */
const NON_SPEECH_MARKERS = [
  '[blank_audio]',
  '[silence]',
  '[no speech]',
  '[inaudible]',
  '(silence)',
  '(music)',
  '[music]',
  '♪',
  '[applause]',
  '[laughter]',
  '(applause)',
  '(laughter)',
  '[background noise]',
];

/** 统计文字脚本（按字符数占比判断；忽略数字/标点/空白） */
export function detectScript(text: string): ScriptLanguage {
  let han = 0;
  let hiragana = 0;
  let katakana = 0;
  let hangul = 0;
  let latin = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x4e00 && code <= 0x9fff) han += 1;
    else if (code >= 0x3040 && code <= 0x309f) hiragana += 1;
    else if (code >= 0x30a0 && code <= 0x30ff) katakana += 1;
    else if (code >= 0xac00 && code <= 0xd7af) hangul += 1;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin += 1;
  }
  if (hangul > 0 && hangul >= han) return 'ko';
  if (hiragana + katakana > 0) return 'ja';
  if (han > 0 && han >= latin) return 'zh';
  if (latin > 0) return 'latin';
  if (han > 0) return 'zh';
  return 'other';
}

/** 脚本 → 语言码（latin 默认 en；other 返回 null 表示无法判断） */
function scriptToLanguage(script: ScriptLanguage): string | null {
  if (script === 'zh') return 'zh';
  if (script === 'ja') return 'ja';
  if (script === 'ko') return 'ko';
  if (script === 'latin') return 'en';
  return null;
}

/**
 * 解析最终语言：
 * - 模型 lang 与文字脚本一致 → 采用模型值；
 * - 短文本 / 脚本不明确 → 复用会话上一次语言（避免单段误判导致语言抖动）；
 * - 脚本与模型 lang 明显冲突 → 以文字脚本为准（音译/幻觉时更可靠）。
 */
export function resolveLanguage(
  modelLang: string | undefined,
  text: string,
  previous?: string,
): string | undefined {
  const script = detectScript(text);
  const scriptLang = scriptToLanguage(script);
  const normalizedModel = (modelLang ?? '').trim().toLowerCase();
  const modelSupported = ['zh', 'en', 'ja', 'ko', 'yue'].includes(normalizedModel)
    ? normalizedModel === 'yue'
      ? 'zh'
      : normalizedModel
    : undefined;

  // 文本太短（如「好」「OK」）时脚本证据不足：优先复用上一条稳定语言
  const meaningfulChars = [...text].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).length;
  if (meaningfulChars > 0 && meaningfulChars < 4 && previous) {
    return previous;
  }
  if (scriptLang && modelSupported && scriptLang !== modelSupported) {
    // 中日韩汉字共享区容易把日文判成中文；有假名时 detectScript 会判 ja，不会走到这里
    return scriptLang;
  }
  return modelSupported ?? scriptLang ?? previous;
}

/** 去除控制标签 / 非语音标记 / 重复标点，并规范化中英混排空格 */
export function normalizeAsrText(text: string): string {
  let out = text ?? '';
  // SenseVoice/Whisper 控制标签：<|zh|><|NEUTRAL|><|Speech|>
  out = out.replace(/<\|[^|]*\|>/g, '');
  // 非语音标记（可能带括号/空格差异）
  for (const marker of NON_SPEECH_MARKERS) {
    out = out.replace(new RegExp(escapeRegExp(marker), 'gi'), ' ');
  }
  // 其他 [xxx] / (xxx) 纯英文标签（长度很短且不含中日韩字符）视为非语音
  out = out.replace(/[[(]([A-Za-z _-]{2,24})[\])]/g, (match, inner: string) => {
    const lower = inner.toLowerCase().trim();
    if (
      /^(music|silence|noise|applause|laughter|blank|inaudible|no speech|background noise)$/.test(
        lower,
      )
    ) {
      return ' ';
    }
    return match;
  });
  out = out.replace(/\s+/g, ' ').trim();
  // 中文/日文/韩文与拉丁字母之间保留一个空格（便于阅读），CJK 之间去掉空格
  out = out.replace(/([\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])\s+(?=[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])/g, '$1');
  // 重复标点压缩：。。/，，/！！/？？ → 单个
  out = out.replace(/([。，、！？!?.,])\1+/g, '$1');
  // 行首尾多余标点/空白
  out = out.replace(/^[，。、；;,\s]+/, '').replace(/[，、；;,\s]+$/, '');
  return out.trim();
}

/** 是否为纯确认/寒暄（记忆蒸馏等场景过滤用） */
export function isTrivialAcknowledgement(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 32 &&
    /^(?:收到|明白|好的|了解|已收到|ok|got it)[。.!！]?$/i.test(trimmed)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
