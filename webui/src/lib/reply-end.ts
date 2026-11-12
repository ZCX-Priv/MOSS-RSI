// webui/src/lib/reply-end.ts
// 「一段 AI 回复的结尾」判定（纯函数，便于单测）：
// - 复制按钮：每条「总 AI 消息」（每段回复结尾）都带
// - 重新生成 / 诊断(Harness)：仅最新一段回复结尾
//
// agentic 回复中，中间轮次的 assistant 消息后面必是 tool 消息 → 非结尾（不夹带操作栏）。

import type { TaskMessage } from '@/types/api';
import { stripInjectBlock } from './inject-block';

/** 系统卡片（轮数触顶 / 输出触顶 / 压缩卡）：不属于任何一段 AI 回复 */
export function isSystemCard(m: TaskMessage): boolean {
  return !!(m.maxTurnsNotice || m.outputLimitNotice || m.compaction);
}

/**
 * assistant 消息是否有「可操作正文」——与 MessageActions 的渲染条件保持一致：
 * 错误卡 / 有工具调用 / 可见正文非空 / 有思考内容。
 *
 * 为什么纳入 thinking：agentic 多轮中，新一轮回复往往先产出思考、正文与工具调用稍后到达。
 * 若把「只有 thinking」的 assistant 当成空占位跳过，上一轮工具消息会被误判为「回复结尾」，
 * 操作栏就渲染在它的末尾（位于新一轮的思考折叠行之上）——用户看到的按钮栏位置错乱。
 * 把 thinking 视为正文后，该消息自身成为回复结尾，操作栏落在它底部（思考折叠行下方）。
 *
 * 完全空（无正文 / 无 thinking / 无工具）的 assistant 仍跳过：刷新后末尾的空占位
 * 不应抢占 lastReplyEndId，否则前一条真实回复会失去操作栏。
 */
function hasReplyBody(m: TaskMessage): boolean {
  if (m.isError) return true;
  if ((m.toolCalls?.length ?? 0) > 0) return true;
  if ((m.thinking ?? '').trim().length > 0) return true;
  return stripInjectBlock(m.content).trim().length > 0;
}

/**
 * 「不可见的空 assistant 占位」：无正文 / 无思考 / 无工具 / 非错误 / 非系统卡 / 非中断。
 * 这类消息来自流式开始时的空占位或进程中断后的空回合：
 * - MessageBubble 不渲染气泡；
 * - 列表宿主必须把整条渲染为 null（含外层 padding），否则会留下几 px 的幽灵高度，
 *   表现为「响应中」先出现、随后下移几 px 才出现正文。
 */
export function isEmptyAssistantPlaceholder(m: TaskMessage): boolean {
  if (m.role !== 'assistant') return false;
  if (m.isError || isSystemCard(m) || m.interrupted) return false;
  if ((m.toolCalls?.length ?? 0) > 0) return false;
  if ((m.thinking ?? '').trim().length > 0) return false;
  return stripInjectBlock(m.content).trim().length === 0;
}

/**
 * assistant 消息是否为「一段 AI 回复的结尾」：
 * 其后的下一条「真实对话消息」是 user（或已到列表末尾）→ 是结尾。
 * 空占位 assistant（无正文/无工具调用/非错误）与系统卡片同样跳过。
 */
export function isReplyEnd(messages: TaskMessage[], i: number): boolean {
  const m = messages[i];
  if (!m || m.role !== 'assistant' || isSystemCard(m) || !hasReplyBody(m)) return false;
  for (let j = i + 1; j < messages.length; j++) {
    const next = messages[j];
    if (isSystemCard(next) || (next.role === 'assistant' && !hasReplyBody(next))) continue;
    return next.role === 'user';
  }
  return true;
}

export interface ReplyEnds {
  /** 所有「回复结尾」消息 id */
  replyEndIds: Set<string>;
  /** 最新的一段回复结尾消息 id（无则 null） */
  lastReplyEndId: string | null;
}

/**
 * 一次性 O(n) 预计算所有回复结尾及其中的最新一条。
 *
 * 旧实现是「每条 assistant 向后扫描找下一条非系统消息」的最坏 O(n²)：
 * 流式期间每次 store 追加（每 rAF/100ms）都会重算，长会话会把主线程占满
 * （UI 卡死、停止按钮点不动的直接诱因之一）。
 * 从后往前维护 nextRole 即可单遍完成，语义与 isReplyEnd 完全一致。
 */
export function computeReplyEnds(messages: TaskMessage[]): ReplyEnds {
  const replyEndIds = new Set<string>();
  let lastReplyEndId: string | null = null;
  /** 下一条「非系统卡片」消息的角色；null = 列表末尾 */
  let nextRole: TaskMessage['role'] | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // 系统卡片不属于任何一段回复，跳过且不改变 nextRole；
    // 空占位 assistant（刷新后末尾只有 thinking / 完全为空）同理 —— 否则它会
    // 抢走 lastReplyEndId 并让前一条真实回复失去结尾资格（按钮栏整体消失）。
    if (isSystemCard(m)) continue;
    if (m.role === 'assistant' && !hasReplyBody(m)) continue;
    if (m.role === 'assistant' && (nextRole === null || nextRole === 'user')) {
      replyEndIds.add(m.id);
      // 从后往前遇到的第一个回复结尾 = 列表顺序中最后一段回复
      if (lastReplyEndId === null) lastReplyEndId = m.id;
    }
    nextRole = m.role;
  }
  return { replyEndIds, lastReplyEndId };
}
