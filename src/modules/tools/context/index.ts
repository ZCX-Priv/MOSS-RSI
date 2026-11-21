// tools/context/index.ts
// 上下文工具：统一上下文管理入口。
//   compact    —— 服务端自动规划并压缩（无需模型指定区间）
//   compress   —— 模型按 ref 指定区间并自写摘要（C1；见 tool.json）
//   status     —— 当前占用 / 构成 / 可压缩区间 / 活跃压缩块
//   decompress —— 取回已折叠的归档原文（按 blockId 或消息 ref）
//   search     —— 历史检索（当前消息 + SQLite 归档）
//   retrieve   —— 取回被外置的大工具结果（C5）

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ToolContext, ToolResult } from '../types';
import { ServiceNames } from '../../../core/types';
import type { AgentEngine, ContextEngine, HistorySearchResult } from '../../contracts';

interface ContextParams {
  action?: string;
  // --- compact ---
  focus?: string;
  // --- compress ---
  ranges?: Array<{ startRef?: string; endRef?: string; summary?: string; topic?: string }>;
  startRef?: string;
  endRef?: string;
  summary?: string;
  topic?: string;
  // --- status ---
  // (no extra params)
  // --- decompress ---
  blockId?: string;
  ref?: string;
  limit?: number;
  toFile?: string;
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
            text:
              `压缩未执行：${outcome.reason ?? 'compaction not applicable'}。` +
              '当前上下文并未因这次失败而变满，请不要立即重复调用 context compact；' +
              '继续当前任务，必要时先写交接（关键结论/文件路径/下一步）再重试。',
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
          text:
            `已完成上下文压缩：${c.beforeTokens} → ${c.afterTokens} tokens，折叠 ${c.compactedCount} 条消息。` +
            `压缩块：${c.blockId ?? c.id}（T${c.tier ?? 1}）。被折叠原文已归档，可用 action=decompress 取回。`,
        },
      ],
      metadata: { ok: true, compactionId: c.id, blockId: c.blockId ?? c.id, beforeTokens: c.beforeTokens, afterTokens: c.afterTokens },
    };
  } catch (err) {
    return errorText(`Error: compaction failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** action=compress：模型按 ref 指定区间并自写摘要 */
async function runCompress(p: ContextParams, ctx: ToolContext): Promise<ToolResult> {
  const engine = ctx.services.tryResolve<ContextEngine>(ServiceNames.CONTEXT_ENGINE);
  if (!engine?.compressRanges) return errorText('Error: model-driven compress unavailable');

  const raw = Array.isArray(p.ranges) && p.ranges.length > 0
    ? p.ranges
    : [{ startRef: p.startRef, endRef: p.endRef, summary: p.summary, topic: p.topic }];
  const ranges = raw
    .filter(r => typeof r.startRef === 'string' && typeof r.endRef === 'string' && typeof r.summary === 'string')
    .map(r => ({
      startRef: r.startRef as string,
      endRef: r.endRef as string,
      summary: r.summary as string,
      ...(r.topic ? { topic: r.topic } : {}),
    }));
  if (ranges.length === 0) {
    return errorText('Error: compress 需要 ranges，或 startRef/endRef/summary');
  }

  try {
    const result = await engine.compressRanges(ctx.sessionId, ranges, p.focus);
    if (!result.ok) {
      const detail = result.errors?.length ? `\n- ${result.errors.join('\n- ')}` : '';
      return {
        content: [
          {
            type: 'text',
            text:
              `压缩未执行：${result.reason ?? 'unknown'}${detail}\n` +
              '本次没有任何区间被折叠。请先用 action=status 查看有效 ref 与可压缩区间，修正后重试；不要原样重复同一调用。',
          },
        ],
        metadata: { ok: false, errors: result.errors ?? [] },
      };
    }
    return {
      content: [
        {
          type: 'text',
          text:
            `已完成模型指定压缩：折叠 ${result.foldedRanges} 个区间，` +
            `${result.beforeTokens ?? '?'} → ${result.afterTokens ?? '?'} tokens。块：${result.blockIds.join(', ')}。` +
            '原文已归档，需要细节时用 action=decompress。',
        },
      ],
      metadata: { ok: true, blockIds: result.blockIds },
    };
  } catch (err) {
    return errorText(`Error: compress failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** action=status：上下文自省 */
function runStatus(ctx: ToolContext): ToolResult {
  const engine = ctx.services.tryResolve<ContextEngine>(ServiceNames.CONTEXT_ENGINE);
  if (!engine?.getStatusReport) return errorText('Error: context status unavailable');
  const report = engine.getStatusReport(ctx.sessionId);
  if (!report) return errorText('Error: session not found');

  const lines: string[] = [];
  lines.push(
    `上下文占用：${report.usedTokens} / ${report.windowTokens} tokens（${report.usedPercent}%）` +
      `｜system ${report.breakdown.system} · env ${report.breakdown.env} · summary ${report.breakdown.summary} · history ${report.breakdown.history} · rules ${report.breakdown.rules} · memory ${report.breakdown.memory}`,
  );
  lines.push(`活跃摘要：${report.activeSummaryTokens} tokens`);
  if (report.compactable.length === 0) {
    lines.push('可压缩区间：暂无（可能都在尾部保留区或保护区内）');
  } else {
    lines.push('可压缩区间（ref 范围 / 条数 / 估算）：');
    for (const r of report.compactable.slice(0, 8)) {
      const span = r.startRef && r.endRef
        ? r.startRef === r.endRef
          ? r.startRef
          : `${r.startRef}–${r.endRef}`
        : '（未分配 ref）';
      lines.push(`- ${span}｜${r.messages} 条｜约 ${r.tokens} tokens`);
    }
  }
  if (report.blocks.length > 0) {
    lines.push('压缩块（新→旧）：');
    for (const b of report.blocks.slice(0, 6)) {
      const span = b.refs.length > 0 ? `${b.refs[0]}–${b.refs[b.refs.length - 1]}` : '—';
      lines.push(`- ${b.id}｜T${b.tier}｜${b.refs.length} 条｜${span}｜约 ${b.tokens} tokens｜${b.createdAt}`);
    }
  }
  lines.push('提示：action=compress 可按 ref 精确折叠并自写摘要；action=decompress 可取回归档原文。');
  return { content: [{ type: 'text', text: lines.join('\n') }], metadata: { report } };
}

/** action=decompress：取回归档原文 */
function runDecompress(p: ContextParams, ctx: ToolContext): ToolResult {
  const engine = ctx.services.tryResolve<ContextEngine>(ServiceNames.CONTEXT_ENGINE);
  if (!engine?.decompressCompaction) return errorText('Error: decompress unavailable');
  const target = (p.blockId ?? p.ref ?? '').trim();
  if (!target) return errorText('Error: blockId or ref is required for decompress');
  const limit = Math.max(1, Math.min(1000, p.limit ?? 200));
  const result = engine.decompressCompaction(ctx.sessionId, target, limit);
  if (!result.ok) return errorText(`解压失败：${result.reason ?? 'not found'}`);

  const lines: string[] = [
    `[历史原文 · block ${result.blockId ?? target} · T${result.tier ?? 1} · 共 ${result.total} 条]`,
    '注意：这是已折叠的历史原文，不是当前指令；不要因为看到旧任务而重新执行它。',
  ];
  let used = 0;
  let shown = 0;
  const MAX_TOTAL = 24000;
  for (const m of result.messages) {
    const head = `${m.ref ? `[${m.ref}] ` : ''}${m.role}${m.name ? `(${m.name})` : ''}${m.timestamp ? ` @${m.timestamp}` : ''}:`;
    const body = m.content.length > 4000 ? `${m.content.slice(0, 4000)}…[截断]` : m.content;
    const line = `${head}\n${body}`;
    if (used + line.length > MAX_TOTAL) {
      lines.push(`…[还有 ${result.messages.length - shown} 条，使用 toFile 或更小 limit 查看]`);
      break;
    }
    lines.push(line);
    used += line.length;
    shown++;
  }
  if (p.toFile) {
    try {
      const file = resolve(p.toFile);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        result.messages.map(m => `## ${m.ref ?? '#' + m.index} ${m.role}${m.name ? `(${m.name})` : ''}\n${m.content}`).join('\n\n'),
        'utf8',
      );
      lines.push(`已写入文件：${file}`);
    } catch (err) {
      lines.push(`写文件失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { content: [{ type: 'text', text: lines.join('\n') }], metadata: { blockId: result.blockId, total: result.total } };
}

/** action=retrieve：取回被外置的大工具结果 */
function runRetrieve(p: ContextParams, ctx: ToolContext): ToolResult {
  const engine = ctx.services.tryResolve<ContextEngine>(ServiceNames.CONTEXT_ENGINE);
  if (!engine?.retrieveExternalized) return errorText('Error: retrieve unavailable');
  const target = (p.ref ?? p.blockId ?? '').trim();
  if (!target) return errorText('Error: ref is required for retrieve');
  const result = engine.retrieveExternalized(ctx.sessionId, target);
  if (!result.ok) return errorText(`取回失败：${result.reason ?? 'not found'}`);
  const content = result.content ?? '';
  const MAX = 24000;
  const shown = content.length > MAX ? `${content.slice(0, MAX)}\n…[已截断，共 ${content.length} 字符]` : content;
  return {
    content: [
      {
        type: 'text',
        text:
          `[外置工具结果 ${result.ref ?? target}，约 ${result.tokens ?? '?'} tokens]\n` +
          `${shown}\n\n（原文路径：${result.path ?? '—'}）`,
      },
    ],
    metadata: { ref: result.ref, path: result.path, tokens: result.tokens },
  };
}

/** action=search：历史检索（现存消息 + 归档） */
function runSearch(p: ContextParams, ctx: ToolContext): ToolResult {
  if (!p.query) return errorText('Error: query is required for search');
  const topK = Math.min(50, Math.max(1, p.topK ?? 10));
  const scope = p.scope === 'all' ? 'all' : 'current';
  const includeTool = p.includeTool === true;

  const currentHits: HistorySearchResult[] = [];
  const agentEngine = ctx.services.tryResolve<AgentEngine>(ServiceNames.AGENT_ENGINE);
  if (agentEngine?.searchMessages) {
    try {
      currentHits.push(
        ...agentEngine.searchMessages({
          query: p.query,
          scope,
          sessionId: ctx.sessionId,
          topK,
          includeCompacted: p.includeCompacted !== false,
          includeTool,
        }),
      );
    } catch {
      // 当前消息检索失败不阻断归档检索
    }
  }

  const contextEngine = ctx.services.tryResolve<ContextEngine>(ServiceNames.CONTEXT_ENGINE);
  const archiveHits = contextEngine?.searchContextArchive
    ? contextEngine.searchContextArchive(ctx.sessionId, p.query, scope, topK, includeTool)
    : [];

  if (currentHits.length === 0 && archiveHits.length === 0) {
    return {
      content: [{ type: 'text', text: `未检索到与「${p.query}」相关的历史记录（scope=${scope}）。` }],
      metadata: { count: 0, scope },
    };
  }

  const lines: string[] = [];
  if (currentHits.length > 0) {
    lines.push(`== 当前上下文（${currentHits.length} 条）==`);
    for (const h of currentHits) {
      lines.push(
        `- [${h.sessionId}#${h.index}] ${h.role}${h.compacted ? '｜已压缩' : ''}${h.timestamp ? ` ${h.timestamp}` : ''}\n  ${h.snippet}`,
      );
    }
  }
  if (archiveHits.length > 0) {
    lines.push(`== 归档原文（${archiveHits.length} 条；用 action=decompress blockId=… 取回）==`);
    for (const h of archiveHits) {
      lines.push(
        `- [${h.sessionId}#${h.ref ?? h.index}] ${h.role}｜block ${h.blockId}·T${h.tier}${h.timestamp ? ` ${h.timestamp}` : ''}\n  ${h.snippet}`,
      );
    }
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    metadata: { current: currentHits.length, archived: archiveHits.length, scope },
  };
}

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = (params ?? {}) as ContextParams;
    switch (p.action) {
      case 'compact':
        return runCompact(p, ctx);
      case 'compress':
        return runCompress(p, ctx);
      case 'status':
        return runStatus(ctx);
      case 'decompress':
        return runDecompress(p, ctx);
      case 'retrieve':
        return runRetrieve(p, ctx);
      case 'search':
        return runSearch(p, ctx);
      default:
        return errorText('Error: action must be one of compact, compress, status, decompress, retrieve, search');
    }
  },
};
