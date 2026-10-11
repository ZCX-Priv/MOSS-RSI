// src/modules/context/compressor/planner.ts
// 压缩规划：
// - 尾部逐字保留区：从末尾向前累积至 tailKeepRatio × 窗口预算
// - 边界对齐：保留区开头不能是孤立 tool 消息（其 assistant 已被压缩掉）
// - head 恒保留区：env-context 锚定消息之前（含）永不压缩
// - 经济学检查：可压缩区 token ≥ minFoldTokens 才值得一次摘要调用

import type { ContextMessage } from '../types';
import { estimateMessageTokens, estimateMessagesTokens } from '../budgeter/estimator';
import { ENV_CONTEXT_MSG_NAME } from '../compiler/env-context';
import { COMPACTION_SUMMARY_MSG_NAME } from '../compiler/view-builder';

/** 尾部保底最少消息数（即使超预算也保留最近 2 条，避免空尾部） */
const MIN_RECENT_KEEP = 2;
/** 可压缩区最少消息数（低于此值跳过压缩） */
export const MIN_COMPACT_MESSAGES = 2;

export interface CompactionPlan {
  /** 可压缩区起始索引（含；基于传入的活跃消息数组） */
  startIdx: number;
  /** 可压缩区结束索引（含） */
  endIdx: number;
  /** 可压缩区估算 token（含旧摘要消息） */
  regionTokens: number;
  /** 可压缩区消息数 */
  regionCount: number;
  /** 规划是否有效（区够大、经济学检查通过） */
  ok: boolean;
  /** 无效原因 */
  reason?: string;
}

/** 是否触发自动压缩：估算 ≥ 窗口 × compactRatio */
export function shouldCompact(estimatedTokens: number, windowTokens: number, compactRatio: number): boolean {
  if (windowTokens <= 0) return false;
  return estimatedTokens >= Math.floor(windowTokens * compactRatio);
}

/**
 * 规划压缩边界。
 * @param activeMsgs 活跃消息（调用方已过滤 deletedAt/compacted；含锚定消息）
 * @param windowTokens 上下文窗口 token
 * @param tailKeepRatio 尾部保留比例（占窗口）
 * @param minFoldTokens 可压缩区最小 token（经济学检查）
 */
export function planCompaction(
  activeMsgs: readonly ContextMessage[],
  windowTokens: number,
  tailKeepRatio: number,
  minFoldTokens: number,
): CompactionPlan {
  // head：env-context 锚定之后的消息才可压缩（env-context 恒为第 0 条活跃消息）
  let head = 0;
  if (activeMsgs.length > 0 && activeMsgs[0].name === ENV_CONTEXT_MSG_NAME) {
    head = 1;
  }

  const invalid = (reason: string): CompactionPlan => ({
    startIdx: head,
    endIdx: head - 1,
    regionTokens: 0,
    regionCount: 0,
    ok: false,
    reason,
  });

  if (activeMsgs.length - head < MIN_COMPACT_MESSAGES) {
    return invalid('too few compactable messages');
  }

  // 尾部逐字保留区：从末尾向前累积
  const tailBudget = Math.max(1, Math.floor(windowTokens * tailKeepRatio));
  let start = activeMsgs.length;
  let acc = 0;
  for (let i = activeMsgs.length - 1; i > head; i--) {
    const t = estimateMessageTokens(activeMsgs[i]);
    if (activeMsgs.length - i > MIN_RECENT_KEEP && acc + t > tailBudget) break;
    acc += t;
    start = i;
  }

  // 边界对齐：保留区开头不能是孤立 tool（回退把它的 assistant 一并保留）
  while (start > head && start < activeMsgs.length && activeMsgs[start].role === 'tool') {
    start--;
  }

  // 可压缩区 = [head, start-1]
  const endIdx = start - 1;
  if (endIdx < head) {
    return invalid('tail retention covers all messages');
  }
  const regionCount = start - head;
  if (regionCount < MIN_COMPACT_MESSAGES) {
    return invalid(`compactable region too small (${regionCount} messages)`);
  }
  const regionTokens = estimateMessagesTokens(activeMsgs.slice(head, start));
  if (regionTokens < minFoldTokens) {
    return invalid(`fold economics: region ${regionTokens} tokens < min ${minFoldTokens}`);
  }

  return { startIdx: head, endIdx, regionTokens, regionCount, ok: true };
}

/** 判断消息是否为压缩保护区（锚定消息：env-context / skill-inject；摘要消息参与合并压缩） */
export function isProtectedMessage(m: ContextMessage): boolean {
  return m.name === ENV_CONTEXT_MSG_NAME || m.name === 'skill-inject';
}

/** 判断是否为摘要消息（多轮压缩时并入新摘要） */
export function isCompactionSummaryMessage(m: ContextMessage): boolean {
  return m.name === COMPACTION_SUMMARY_MSG_NAME;
}
