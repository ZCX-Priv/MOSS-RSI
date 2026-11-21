// src/modules/context/compressor/index.ts
// 压缩执行主流程：
//   plan（planner）→ summarize（summarizer，cache-aligned）→ applyFold（归档 + 折叠）→ 写入 compactions 历史
// 被折叠原文先写入 SQLite 归档，再从 session.messages 物理移除，由摘要消息替代。
// 多轮压缩：旧摘要消息一并进入可压缩区，由新摘要指令要求合并（T1→T2→T3）。

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
import { planCompaction, isProtectedMessage, isCompactionSummaryMessage } from './planner';
import { summarizeRegion, SummarizeError } from './summarizer';
import { rebaseDistillWatermark } from './watermark';
import { COMPACTION_SUMMARY_MSG_NAME } from '../compiler/view-builder';
import { archiveCompaction } from '../store/context-store';
import { ensureSessionRefs } from '../refs';

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

/** 根据被压缩区内容判断层级：包含旧摘要则提升一层。 */
export function resolveFoldTier(region: readonly ContextMessage[]): 1 | 2 | 3 {
  const summaries = region.filter(m => isCompactionSummaryMessage(m));
  if (summaries.length === 0) return 1;
  const priorTier = summaries.reduce((max, m) => {
    const t = typeof m.metadata?.tier === 'number' ? m.metadata.tier : 1;
    return Math.max(max, t >= 3 ? 3 : t === 2 ? 2 : 1);
  }, 1);
  return Math.min(3, priorTier + 1) as 1 | 2 | 3;
}

/**
 * 对会话执行一次服务端规划压缩（原地修改 session）。
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
    config.protectedTools,
    config.preserveRecentTokens,
  );
  if (!plan.ok) {
    return { record: null, reason: plan.reason };
  }

  // 3. 可压缩区（保护锚定消息 / protectedTools）
  const region = active
    .slice(plan.startIdx, plan.endIdx + 1)
    .filter(m => !isProtectedMessage(m, config.protectedTools));
  if (region.length === 0) {
    return { record: null, reason: 'no compactable messages (all protected)' };
  }

  const tier = resolveFoldTier(region);

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
      tier,
    });
  } catch (err) {
    const msg = err instanceof SummarizeError ? err.message : err instanceof Error ? err.message : String(err);
    logger.warn('context: compaction summarization failed', { sessionId: session.id, error: msg });
    return { record: null, reason: `summarization failed: ${msg}` };
  }

  // 4.5 收缩比检查（DSH shrink check）：摘要必须显著小于被压缩区，否则放弃本轮。
  const summaryTokens = estimateTextTokens(summary) + 8;
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

  try {
    const record = applyFold({
      env,
      session,
      region,
      summary,
      summaryModel: input.summaryModelConfigured,
      trigger,
      tier,
      durationMs: Date.now() - startedAt,
    });
    logger.info('context: compaction completed', {
      sessionId: session.id,
      trigger,
      compactedCount: record.compactedCount,
      beforeTokens: record.beforeTokens,
      afterTokens: record.afterTokens,
      durationMs: record.durationMs,
      tier: record.tier,
    });
    return { record };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('context: compaction apply failed', { sessionId: session.id, error: msg });
    return { record: null, reason: msg };
  }
}

export interface ApplyFoldInput {
  env: Environment;
  session: ContextSessionLike;
  /** 已被调用方筛选/净化过的待折叠消息（保持 session.messages 对象身份） */
  region: ContextMessage[];
  /** 模型自写或服务端生成的摘要正文（不含标签） */
  summary: string;
  summaryModel: string;
  trigger: 'auto' | 'manual' | 'model';
  /** 摘要层级；缺省按 region 内旧摘要推断 */
  tier?: 1 | 2 | 3;
  /** 块 id；缺省生成 UUID */
  blockId?: string;
  /** 已耗时（手动/模型压缩记录用） */
  durationMs?: number;
}

/**
 * 折叠落地：归档原文 → 插入摘要 → 物理删除 → 记录历史 → 重算蒸馏水位。
 * 归档失败会抛错，调用方必须整体放弃（“可逆”是硬承诺）。
 */
export function applyFold(input: ApplyFoldInput): CompactionRecord {
  const { env, session, region, summary, summaryModel, trigger } = input;
  if (region.length === 0) throw new Error('empty compaction region');

  const startedAt = Date.now();
  ensureSessionRefs(session);
  const blockId = input.blockId ?? randomUUID();
  const tier = input.tier ?? resolveFoldTier(region);
  const refs = region.map(m => m.ref).filter((r): r is string => typeof r === 'string');
  const activeBefore = session.messages.filter(m => !m.deletedAt && !m.compacted);
  const beforeTokens = estimateMessagesTokens(activeBefore);
  const regionTokens = estimateMessagesTokens(region);
  const summaryTokens = estimateTextTokens(summary) + 8;
  const projectedAfter = beforeTokens - regionTokens + summaryTokens;

  // 归档必须先于任何变更
  archiveCompaction(env, {
    id: blockId,
    sessionId: session.id,
    tier,
    refs,
    summary,
    beforeTokens,
    afterTokens: projectedAfter,
    trigger,
    messages: region,
  });

  // 记忆蒸馏水位是数组下标，物理删除后必须按旧下标重算。
  const memoryWatermark = session.memoryState?.lastDistilledIndex;
  const beforeFoldMessages = memoryWatermark === undefined ? null : [...session.messages];
  const compactedSet = new Set(region);

  const lastRegionMsg = region[region.length - 1];
  const insertAt = session.messages.lastIndexOf(lastRegionMsg) + 1;
  const summaryMessage: ContextMessage = {
    role: 'user',
    name: COMPACTION_SUMMARY_MSG_NAME,
    content: `${SUMMARY_TAG_OPEN}\n${summary}\n${SUMMARY_TAG_CLOSE}`,
    timestamp: new Date().toISOString(),
    metadata: { tier, blockId, refs },
  };
  session.messages.splice(insertAt, 0, summaryMessage);
  session.messages = session.messages.filter(m => !compactedSet.has(m));

  if (session.memoryState && beforeFoldMessages) {
    session.memoryState.lastDistilledIndex =
      rebaseDistillWatermark(beforeFoldMessages, session.messages, memoryWatermark) ?? 0;
  }

  const afterActive = session.messages.filter(m => !m.deletedAt && !m.compacted);
  const afterTokens = estimateMessagesTokens(afterActive);

  const record: CompactionRecord = {
    id: blockId,
    at: new Date().toISOString(),
    trigger,
    beforeTokens,
    afterTokens,
    compactedCount: compactedSet.size,
    foldedMessageCount: compactedSet.size,
    summary,
    boundaryTimestamp: lastRegionMsg.timestamp,
    summaryModel,
    durationMs: input.durationMs ?? Date.now() - startedAt,
    tier,
    blockId,
    archiveId: blockId,
    refs,
  };
  if (!session.compactions) session.compactions = [];
  session.compactions.push(record);
  trimCompactionHistory(session);
  // 新摘要立即获得 ref（同一轮视图即可被模型引用；编号仍单调不回退）
  ensureSessionRefs(session);
  return record;
}

/** 会话内保留全文的压缩记录条数；更早记录截断摘要正文（原文已在 SQLite 归档）。 */
const COMPACTION_HISTORY_KEEP_FULL = 20;
const COMPACTION_HISTORY_TRUNCATED_CHARS = 240;

/**
 * 压缩记录治理：session.compactions 会随会话长期累积摘要全文，
 * 这里只保留最近 N 条全文，更早记录保留统计字段 + 截断摘要。
 */
export function trimCompactionHistory(session: ContextSessionLike): void {
  const list = session.compactions;
  if (!list || list.length <= COMPACTION_HISTORY_KEEP_FULL) return;
  const cut = list.length - COMPACTION_HISTORY_KEEP_FULL;
  for (let i = 0; i < cut; i++) {
    const r = list[i];
    if (r.summary.length > COMPACTION_HISTORY_TRUNCATED_CHARS) {
      r.summary = `${r.summary.slice(0, COMPACTION_HISTORY_TRUNCATED_CHARS)}…[已截断，原文见 block ${r.blockId ?? r.id}]`;
    }
  }
}
