// src/modules/context/budgeter/estimator.ts
// token 估算：跨语言自适应（英文趋势 ~4 字节/token，CJK ~1 rune/token），
// 消息级估算含 chat framing 与 tool_call 结构开销。

import type { ContextMessage } from '../types';

/** 单条消息的 chat framing 开销（role/name 等结构字段） */
const MSG_FRAMING_TOKENS = 4;
/** 单个 tool_call 的结构开销（id/type 包裹） */
const TOOLCALL_FRAMING_TOKENS = 8;

/**
 * 跨语言 token 估算：
 * - 拉丁主导（bytes/rune ≈ 1）：~4 字节/token → ceil(bytes/4)
 * - CJK 主导（bytes/rune > 2，即大量多字节字符）：~1 rune/token → runeCount
 * 按字节/字符比率自适应，避免英文场景系统性高估 4 倍（实际比率经 TokenCalibrator 从真实 usage 校准）。
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  const bytes = Buffer.byteLength(text, 'utf8');
  // rune 计数（正确处理代理对：emoji 等）
  let runes = 0;
  for (const _ of text) runes++;
  if (runes === 0) return 0;
  const bytesPerRune = bytes / runes;
  if (bytesPerRune > 2) return runes; // CJK 主导
  return Math.ceil(bytes / 4); // 拉丁主导
}

/** 单条消息 token 估算（thinking 不计——发送视图不携带 thinking） */
export function estimateMessageTokens(m: ContextMessage): number {
  let total = MSG_FRAMING_TOKENS;
  total += estimateTextTokens(m.content);
  if (m.toolCallId) total += estimateTextTokens(m.toolCallId);
  if (m.name) total += estimateTextTokens(m.name);
  if (m.toolCalls) {
    for (const tc of m.toolCalls) {
      total += TOOLCALL_FRAMING_TOKENS;
      total += estimateTextTokens(tc.id);
      total += estimateTextTokens(tc.name);
      total += estimateTextTokens(tc.arguments);
    }
  }
  return total;
}

/** 消息列表 token 估算总和 */
export function estimateMessagesTokens(msgs: readonly ContextMessage[]): number {
  let total = 0;
  for (const m of msgs) total += estimateMessageTokens(m);
  return total;
}

/** 消息实际发送字符数（校准用：与 provider 计费的 prompt 对齐的内容口径） */
export function messageChars(m: ContextMessage): number {
  let n = m.content.length;
  if (m.name) n += m.name.length;
  if (m.toolCallId) n += m.toolCallId.length;
  if (m.toolCalls) {
    for (const tc of m.toolCalls) {
      n += tc.name.length + tc.arguments.length + tc.id.length;
    }
  }
  return n;
}

/** 消息列表总字符数 */
export function messagesChars(msgs: readonly ContextMessage[]): number {
  let n = 0;
  for (const m of msgs) n += messageChars(m);
  return n;
}

/**
 * 解析模型上下文窗口 token 数。
 * ModelConfig.contextWindow 形如 '200k' / '1m' / '128000'；缺失/非法回退 128000。
 */
export function parseContextWindow(contextWindow: string | undefined): number {
  if (!contextWindow) return 128000;
  const raw = contextWindow.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(raw);
  if (!match) {
    const plain = Number.parseInt(raw, 10);
    return Number.isFinite(plain) && plain > 0 ? plain : 128000;
  }
  const value = Number.parseFloat(match[1]);
  const unit = match[2];
  const mult = unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1;
  const tokens = Math.round(value * mult);
  return tokens > 0 ? tokens : 128000;
}
