// webui/src/lib/reply-end.ts
// 「一段 AI 回复的结尾」判定（纯函数，便于单测）：
// - 复制按钮：每条「总 AI 消息」（每段回复结尾）都带
// - 重新生成 / 诊断(Harness)：仅最新一段回复结尾
//
// agentic 回复中，中间轮次的 assistant 消息后面必是 tool 消息 → 非结尾（不夹带操作栏）。

import type { TaskMessage } from '@/types/api';

/** 系统卡片（轮数触顶 / 输出触顶 / 压缩卡）：不属于任何一段 AI 回复 */
export function isSystemCard(m: TaskMessage): boolean {
  return !!(m.maxTurnsNotice || m.outputLimitNotice || m.compaction);
}

/**
 * assistant 消息是否为「一段 AI 回复的结尾」：
 * 其后的下一条「真实对话消息」是 user（或已到列表末尾）→ 是结尾。
 */
export function isReplyEnd(messages: TaskMessage[], i: number): boolean {
  const m = messages[i];
  if (!m || m.role !== 'assistant' || isSystemCard(m)) return false;
  for (let j = i + 1; j < messages.length; j++) {
    if (isSystemCard(messages[j])) continue;
    return messages[j].role === 'user';
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
    if (isSystemCard(m)) continue; // 系统卡片不属于任何一段回复，跳过且不改变 nextRole
    if (m.role === 'assistant' && (nextRole === null || nextRole === 'user')) {
      replyEndIds.add(m.id);
      // 从后往前遇到的第一个回复结尾 = 列表顺序中最后一段回复
      if (lastReplyEndId === null) lastReplyEndId = m.id;
    }
    nextRole = m.role;
  }
  return { replyEndIds, lastReplyEndId };
}
