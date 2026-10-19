// tools/context/index.ts
// context 工具 execute 逻辑：统一上下文工具，按 action 分派。
//   compact —— AI 自主压缩当前对话上下文（运行中可用；折叠较早消息为结构化摘要）
//   search  —— 历史智能检索（BM25）：本对话原始上下文（含已压缩原文）/ 跨 session 全量
// 元数据见同目录 tool.json。

import type { ToolContext, ToolResult } from '../types';
import { ServiceNames } from '../../../core/types';
import type { AgentEngine, ContextEngine, HistorySearchResult } from '../../contracts';

interface ContextParams {
  action?: string;
  // --- compact ---
  focus?: string;
  // --- search ---
  query?: string;
  scope?: string;
  includeCompacted?: boolean;
  includeTool?: boolean;
  topK?: number;
}

function errorText(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** action=compact：AI 自主压缩（跳过 busy 检查，运行中可用） */
async function runCompact(p: ContextParams, ctx: ToolContext): Promise<ToolResult> {
  const engine = ctx.services.tryResolve<ContextEngine>(ServiceNames.CONTEXT_ENGINE);
  if (!engine) {
    return errorText('Error: context engine not available');
  }
  if (typeof engine.compactNow !== 'function') {
    return errorText('Error: context engine does not support model-initiated compaction');
  }
  try {
    const outcome = await engine.compactNow(ctx.sessionId, p.focus);
    if (!outcome.ok || !outcome.compaction) {
      return {
        content: [
          {
            type: 'text',
            text: `压缩未执行：${outcome.reason ?? 'compaction not applicable'}`,
          },
        ],
        metadata: { ok: false, reason: outcome.reason },
      };
    }
    const c = outcome.compaction;
    return {
      content: [
        {
          type: 'text',
          text: `已完成上下文压缩：${c.beforeTokens} → ${c.afterTokens} tokens，折叠 ${c.compactedCount} 条消息。摘要已替代较早消息，原始内容仍保存在会话中（可用 context search 检索）。`,
        },
      ],
      metadata: { ok: true, compactionId: c.id, beforeTokens: c.beforeTokens, afterTokens: c.afterTokens },
    };
  } catch (err) {
    return errorText(`Error: compaction failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** action=search：历史检索（BM25；本对话 / 跨 session） */
function runSearch(p: ContextParams, ctx: ToolContext): ToolResult {
  if (!p.query) {
    return errorText('Error: query is required for search');
  }
  const engine = ctx.services.tryResolve<AgentEngine>(ServiceNames.AGENT_ENGINE);
  if (!engine || typeof engine.searchMessages !== 'function') {
    return errorText('Error: agent history search unavailable');
  }

  const scope = p.scope === 'all' ? 'all' : 'current';
  const topK = Math.min(50, Math.max(1, p.topK ?? 10));

  let hits: HistorySearchResult[];
  try {
    hits = engine.searchMessages({
      query: p.query,
      scope,
      sessionId: ctx.sessionId,
      topK,
      includeCompacted: p.includeCompacted !== false,
      includeTool: p.includeTool === true,
    });
  } catch (err) {
    return errorText(`Error: search failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (hits.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `未检索到与「${p.query}」相关的历史记录（scope=${scope}）。`,
        },
      ],
      metadata: { count: 0, scope },
    };
  }

  const lines = hits.map(h => {
    const tag = `${h.sessionId}#${h.index}`;
    const flags = `${h.compacted ? '｜已压缩' : ''}`;
    const time = h.timestamp ? ` ${h.timestamp}` : '';
    return `- [${tag}] ${h.role}${flags}${time}\n  ${h.snippet}`;
  });
  return {
    content: [
      {
        type: 'text',
        text: `检索到 ${hits.length} 条相关历史（scope=${scope}，score 降序，含已压缩原文）：\n${lines.join('\n')}`,
      },
    ],
    metadata: { count: hits.length, scope },
  };
}

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = (params ?? {}) as ContextParams;
    switch (p.action) {
      case 'compact':
        return runCompact(p, ctx);
      case 'search':
        return runSearch(p, ctx);
      default:
        return errorText('Error: action must be one of compact, search');
    }
  },
};
