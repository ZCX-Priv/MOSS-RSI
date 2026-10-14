// src/modules/memory/distiller.ts
// 记忆蒸馏器：run 结束后异步 LLM 提炼（verbatim 之外的洞察层）。
// 复用 compressor 的 LLM Router 调用模式 + summaryModel 解析机制。
// 防重入：session 内存 Set；合并策略：同 room 同 insight token 重合度>0.8 → 更新而非新建。

import type { ContextSessionLike, ContextMessage } from '../context/types';
import type { Logger } from '../../core/types';
import type { LLMRouter } from '../contracts';
import type { UnifiedMessage } from '../llm/types';
import { buildMemoryRecord, globalMemoryRoot, listAllMemories, projectMemoryRoot, projectWing, writeMemory } from './storage';
import { tokenOverlap, tokenize } from './tokenizer';
import type { DistilledMemory } from './types';
import { MEMORY_HALLS } from './types';

/** 蒸馏指令（要求输出结构化 JSON） */
const DISTILL_PROMPT = `分析以下对话，提取值得长期记忆的信息。

只提取满足以下条件的内容（宁缺毋滥）：
1. 用户表达的稳定偏好或工作习惯（hall: preference）
2. 做出的关键决策及理由（hall: decision）
3. 项目的重要发现/约束/架构事实（hall: discovery）
4. 值得记录的重要事件（hall: event）
5. 对未来工作有用的建议（hall: suggestion）

丢弃：调试输出、临时性讨论、寒暄、已被后续消息否定的内容、纯代码细节。

输出严格 JSON（不要 markdown 代码块，不要多余文本）：
{"memories": [{"room": "主题名(英文小写连字符)", "hall": "decision|event|discovery|preference|suggestion", "verbatim": "对话中的原文片段(保留用户原话)", "insight": "一句话洞察(中文)", "tags": ["标签"], "importance": 0.0到1.0}]}
无值得记忆的内容时输出 {"memories": []}
room 命名规范：按主题（如 context-engine、api-design、user-preference），跨次保持一致。importance：关键决策/强偏好 ≥0.8，一般发现 0.5-0.7。`;

/** 可蒸馏消息筛选：user/assistant 且非锚定/非工具消息 */
function distillableMessages(messages: readonly ContextMessage[], fromIndex: number): ContextMessage[] {
  return messages.slice(fromIndex).filter(m => {
    if (m.deletedAt || m.compacted) return false;
    if (m.name) return false; // 锚定消息（env-context/day-rollover/active-rules/memory-l1 等）
    return m.role === 'user' || m.role === 'assistant';
  });
}

/** LLM 输出解析：容错提取 JSON（首个 { 到末个 }） */
function parseDistillOutput(text: string): DistilledMemory[] {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { memories?: unknown };
    if (!Array.isArray(parsed.memories)) return [];
    const out: DistilledMemory[] = [];
    for (const m of parsed.memories) {
      if (typeof m !== 'object' || m === null) continue;
      const rec = m as Partial<DistilledMemory>;
      if (
        typeof rec.room !== 'string' ||
        rec.room === '' ||
        typeof rec.insight !== 'string' ||
        rec.insight === '' ||
        !MEMORY_HALLS.includes(rec.hall as DistilledMemory['hall'])
      ) {
        continue;
      }
      out.push({
        room: rec.room.slice(0, 64),
        hall: rec.hall as DistilledMemory['hall'],
        verbatim: (rec.verbatim ?? '').slice(0, 2000),
        insight: rec.insight.slice(0, 1000),
        ...(Array.isArray(rec.tags)
          ? { tags: rec.tags.filter((x): x is string => typeof x === 'string').slice(0, 8) }
          : {}),
        ...(typeof rec.importance === 'number'
          ? { importance: Math.min(1, Math.max(0, rec.importance)) }
          : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export interface DistillDeps {
  logger: Logger;
  llm: LLMRouter;
  /** 蒸馏模型（已解析的请求 model 名） */
  distillModelId: string;
  /** 触发蒸馏的最小新增消息数 */
  minMessages: number;
  /** 全局个人记忆 wing 固定 'user'；项目记忆写入项目根（系统作用域无项目根 → null） */
  projectRoot: string | null;
  globalRoot: string;
}

export interface DistillResult {
  /** 蒸馏出的记忆条数（写入新建 + 合并更新） */
  created: number;
  merged: number;
  skipped: boolean;
  reason?: string;
}

/**
 * 执行一次蒸馏（同步；调用方 scheduleDistill 异步触发）。
 * 蒸馏范围：session.messages 从 lastDistilledIndex 水位开始的 user/assistant 消息。
 */
export async function distillSession(
  session: ContextSessionLike,
  cwd: string,
  deps: DistillDeps,
): Promise<DistillResult> {
  const state = session.memoryState ?? { excludeFromRecall: [], currentRecalled: [], lastDistilledIndex: 0 };
  session.memoryState = state;

  const region = distillableMessages(session.messages, state.lastDistilledIndex);
  if (region.length < deps.minMessages) {
    return { created: 0, merged: 0, skipped: true, reason: `only ${region.length} new messages` };
  }

  // 构建 LLM 请求（消息裁剪：单条上限 + 总条数上限，防 prompt 膨胀）
  const MAX_MSGS = 60;
  const MAX_CHARS = 1500;
  const regionLimited = region.slice(-MAX_MSGS).map(m => ({
    role: m.role,
    content: m.content.length > MAX_CHARS ? `${m.content.slice(0, MAX_CHARS)}…` : m.content,
  }));
  const messages: UnifiedMessage[] = [
    { role: 'system', content: '你是记忆蒸馏引擎，只输出 JSON。' },
    ...regionLimited,
    { role: 'user', content: DISTILL_PROMPT },
  ];

  let text = '';
  try {
    const response = await deps.llm.complete({
      model: deps.distillModelId,
      messages,
      stream: false,
      max_tokens: 4096,
    });
    text = response.content.trim();
  } catch (err) {
    return {
      created: 0,
      merged: 0,
      skipped: true,
      reason: `llm failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let distilled = parseDistillOutput(text);
  if (distilled.length === 0 && text !== '{"memories": []}') {
    // 解析失败：重试一次（追加格式纠正提示）
    try {
      const retry = await deps.llm.complete({
        model: deps.distillModelId,
        messages: [
          ...messages,
          { role: 'assistant', content: text.slice(0, 2000) },
          { role: 'user', content: '输出不是合法 JSON。重新输出，只输出 JSON，不要任何其他文本。' },
        ],
        stream: false,
        max_tokens: 4096,
      });
      distilled = parseDistillOutput(retry.content);
    } catch {
      // 重试失败放弃
    }
  }

  if (distilled.length === 0) {
    return { created: 0, merged: 0, skipped: true, reason: 'no memories extracted' };
  }

  // 写入：与现有记忆合并（同 room token 重合度 > 0.8 → 更新）
  const wing = projectWing(cwd);
  const existing = [
    ...listAllMemories(deps.globalRoot, 'global'),
    ...(deps.projectRoot ? listAllMemories(deps.projectRoot, 'project') : []),
  ];
  const now = new Date().toISOString();
  let created = 0;
  let merged = 0;

  for (const m of distilled) {
    const isUserPreference = m.hall === 'preference' || m.hall === 'suggestion';
    const targetWing = isUserPreference ? 'user' : wing;
    const record = buildMemoryRecord(
      {
        wing: targetWing,
        room: m.room,
        hall: m.hall,
        verbatim: m.verbatim,
        insight: m.insight,
        tags: m.tags,
        importance: m.importance,
        source: { sessionId: session.id, at: now },
      },
      now,
    );

    // 合并检测：同 wing 同 room 且 insight 语义相近
    const insightTokens = tokenize(m.insight);
    const similar = existing.find(
      e => e.wing === targetWing && e.room === m.room && tokenOverlap(tokenize(e.insight), insightTokens) > 0.8,
    );

    if (similar) {
      // 合并：提升重要性/访问计数，保留最早创建时间
      const updated = {
        ...similar,
        verbatim: `${similar.verbatim}\n---\n${m.verbatim}`.slice(0, 4000),
        accessCount: similar.accessCount + 1,
        importance: Math.min(1, Math.max(similar.importance, record.importance)),
        updatedAt: now,
        tags: [...new Set([...similar.tags, ...(m.tags ?? [])])].slice(0, 12),
      };
      writeMemory(
        similar.scope === 'project' && deps.projectRoot ? deps.projectRoot : deps.globalRoot,
        updated,
      );
      merged++;
    } else {
      // 系统作用域无项目根：项目翼记忆也归档到全局（翼名 'system'）
      const toGlobal = targetWing === 'user' || deps.projectRoot === null;
      writeMemory(toGlobal ? deps.globalRoot : (deps.projectRoot ?? deps.globalRoot), record);
      existing.push({ ...record, scope: toGlobal ? 'global' : 'project' });
      created++;
    }
  }

  // 更新蒸馏水位（含本轮全部消息——非蒸馏消息也越过，避免重复扫描）
  state.lastDistilledIndex = session.messages.length;

  deps.logger.info('memory: distillation complete', {
    sessionId: session.id,
    created,
    merged,
    regionMessages: region.length,
  });
  return { created, merged, skipped: false };
}

export { distillableMessages };
