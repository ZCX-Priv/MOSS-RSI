// src/modules/context/compressor/index.ts
// 压缩执行主流程：
//   plan（planner）→ summarize（summarizer，cache-aligned）→ 标记 compacted →
//   插入摘要消息 → 写入 compactions 历史
// 被压缩消息保留原文 + compacted=true 标记（发送视图排除，前端历史完整）；
// 多轮压缩：旧摘要消息一并进入可压缩区，由新摘要指令要求合并。

import { randomUUID } from 'node:crypto';
import type { Environment, Logger } from '../../../core/types';
import type {
  CompactionConfig,
  CompactionRecord,
  ContextMessage,
  ContextSessionLike,
} from '../types';
import type { LLMRouter } from '../../contracts';
import { estimateMessagesTokens, estimateTextTokens } from '../budgeter/estimator';
import { planCompaction, isProtectedMessage } from './planner';
import { summarizeRegion, SummarizeError } from './summarizer';
import { COMPACTION_SUMMARY_MSG_NAME } from '../compiler/view-builder';

/** 摘要消息包裹标签 */
export const SUMMARY_TAG_OPEN = '<compaction-summary>';
export const SUMMARY_TAG_CLOSE = '</compaction-summary>';

export interface CompactSessionInput {
  env: Environment;
  config: CompactionConfig;
  llm: LLMRouter;
  logger: Logger;
  /** 静态系统提示词（cache-aligned 摘要请求前缀） */
  staticSystemPrompt: string;
  /** 已解析的摘要模型请求名（providers 扁平视图的 model 字段或主模型名） */
  summaryModelId: string;
  /** 摘要模型记录名（遥测记录用：配置值） */
  summaryModelConfigured: string;
  /** 上下文窗口 token */
  windowTokens: number;
  /** 触发方式 */
  trigger: 'auto' | 'manual';
  /** 手动压缩附加焦点 */
  focus?: string;
}

export interface CompactOutcome {
  /** null = 压缩未执行（区太小/摘要失败）；reason 说明原因 */
  record: CompactionRecord | null;
  reason?: string;
}

/**
 * 解析摘要模型请求名。
 * @param configured config.context.compaction.summaryModel（'inherit' 或模型 id）
 * @param mainModel 本轮主模型请求名
 * @param apiModels 模型列表（id → model 映射）
 * @returns { requestModel, resolved } resolved=false 表示配置的模型不存在（回退主模型）
 */
export function resolveSummaryModel(
  configured: string,
  mainModel: string,
  apiModels: Array<{ id: string; model: string }>,
): { requestModel: string; resolved: boolean } {
  if (configured === 'inherit' || configured === '' || configured === mainModel) {
    return { requestModel: mainModel, resolved: true };
  }
  const found = apiModels.find(m => m.id === configured || m.model === configured);
  if (found) return { requestModel: found.model, resolved: true };
  return { requestModel: mainModel, resolved: false };
}

/**
 * 对会话执行一次压缩（原地修改 session：标记 compacted、插入摘要消息、追加历史记录）。
 * 调用方负责持久化与 WS 推送。
 */
export async function compactSession(
  session: ContextSessionLike,
  input: CompactSessionInput,
): Promise<CompactOutcome> {
  const { config, llm, logger, env, staticSystemPrompt, windowTokens, trigger, focus } = input;
  const startedAt = Date.now();

  // 1. 活跃消息（未删未压缩）
  const active = session.messages.filter(m => !m.deletedAt && !m.compacted);

  // 2. 规划
  const plan = planCompaction(
    active,
    windowTokens,
    config.tailKeepRatio,
    config.minFoldTokens,
    config.minCompactMessages,
  );
  if (!plan.ok) {
    return { record: null, reason: plan.reason };
  }

  // 3. 可压缩区（保护 skill-inject；env-context 已被 head 排除）
  const region = active
    .slice(plan.startIdx, plan.endIdx + 1)
    .filter(m => !isProtectedMessage(m));
  if (region.length === 0) {
    return { record: null, reason: 'no compactable messages (all protected)' };
  }
  const beforeTokens = estimateMessagesTokens(active);

  // 4. 生成摘要（单次失败即放弃本轮）
  let summary: string;
  try {
    summary = await summarizeRegion({
      env,
      config,
      llm,
      staticSystemPrompt,
      region,
      focus,
      summaryModelId: input.summaryModelId,
    });
  } catch (err) {
    const msg = err instanceof SummarizeError ? err.message : err instanceof Error ? err.message : String(err);
    logger.warn('context: compaction summarization failed', { sessionId: session.id, error: msg });
    return { record: null, reason: `summarization failed: ${msg}` };
  }

  // 4.5 收缩比检查（DSH shrink check）：摘要必须显著小于被压缩区，否则放弃本轮。
  // 目的：杜绝“摘要≈原文”的空转——这正是“越压越傻 / 反复压缩”的直接成因。
  const summaryTokens = estimateTextTokens(summary) + 8; // +8 结构/包装开销
  if (summaryTokens > plan.regionTokens * config.maxShrinkRatio) {
    logger.warn('context: compaction aborted (shrink check failed)', {
      sessionId: session.id,
      regionTokens: plan.regionTokens,
      summaryTokens,
      maxShrinkRatio: config.maxShrinkRatio,
    });
    return {
      record: null,
      reason: `shrink check failed: summary ${summaryTokens} > region ${plan.regionTokens} × ${config.maxShrinkRatio}`,
    };
  }
  const projectedAfter = beforeTokens - plan.regionTokens + summaryTokens;
  if (projectedAfter >= beforeTokens) {
    return { record: null, reason: `compaction would not reduce tokens (${projectedAfter} >= ${beforeTokens})` };
  }

  // 5. 物理折叠被压缩区间（体积治理：原文不再保留，session 文件与内存有界）。
  // 原实现仅标记 compacted=true，原文永久驻留内存与磁盘，小时级长任务下只增不减；
  // 现直接从 session.messages 移除被压缩消息，由摘要消息替代（业界 /compact 标准做法）。
  // 工具结果保持全文（用户要求：利好 LLM 读大文件）——折叠的只是已退出请求视图的旧消息。
  const compactedSet = new Set(region);

  // 6. 摘要消息插入：紧跟被压缩区间最后一条消息之后（保持消息流时序）。
  // 插入点必须在物理删除前计算（lastRegionMsg 定位）
  const lastRegionMsg = region[region.length - 1];
  const insertAt = session.messages.lastIndexOf(lastRegionMsg) + 1;
  const summaryMessage: ContextMessage = {
    role: 'user',
    name: COMPACTION_SUMMARY_MSG_NAME,
    content: `${SUMMARY_TAG_OPEN}\n${summary}\n${SUMMARY_TAG_CLOSE}`,
    timestamp: new Date().toISOString(),
  };
  session.messages.splice(insertAt, 0, summaryMessage);
  // 按对象身份移除被压缩消息（保护消息 skill-inject/env-context 与已删除死消息不受影响；
  // 摘要消息不在 removeSet 中自然保留，落在被折叠区间原位）
  session.messages = session.messages.filter(m => !compactedSet.has(m));

  // 7. 压缩后估算（env-context + 新摘要 + 尾部）
  const afterActive = session.messages.filter(m => !m.deletedAt && !m.compacted);
  const afterTokens = estimateMessagesTokens(afterActive);

  // 8. 历史记录
  const record: CompactionRecord = {
    id: randomUUID(),
    at: new Date().toISOString(),
    trigger,
    beforeTokens,
    afterTokens,
    compactedCount: compactedSet.size,
    foldedMessageCount: compactedSet.size,
    summary,
    boundaryTimestamp: lastRegionMsg.timestamp,
    summaryModel: input.summaryModelConfigured,
    durationMs: Date.now() - startedAt,
  };
  if (!session.compactions) session.compactions = [];
  session.compactions.push(record);

  logger.info('context: compaction completed', {
    sessionId: session.id,
    trigger,
    compactedCount: record.compactedCount,
    beforeTokens,
    afterTokens,
    durationMs: record.durationMs,
  });

  return { record };
}
