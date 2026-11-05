// tools/memory/index.ts
// memory 工具 execute 逻辑：统一记忆工具，按 action 分派。
//   save       —— 保存一条长期记忆到记忆宫殿（L3 深度检索配套写入入口）
//   search     —— L3 深度检索记忆宫殿（全量跨翼 BM25）
//   list_rooms —— 列出记忆宫殿树（翼→房间→厅）
// 元数据见同目录 tool.json。

import type { ToolContext, ToolResult } from '../types';
import { ServiceNames } from '../../../core/types';
import { MEMORY_HALLS } from '../../../modules/memory/types';
import type { MemoryEngineServiceImpl } from '../../../modules/memory/service';

type MemoryHall = (typeof MEMORY_HALLS)[number];

interface MemoryParams {
  action?: string;
  // --- save ---
  room?: string;
  hall?: string;
  verbatim?: string;
  insight?: string;
  tags?: string[];
  importance?: number;
  // --- search ---
  query?: string;
  wing?: string;
  topK?: number;
}

function errorText(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** action=save：保存记忆（preference/suggestion → 全局 user 翼；其余 → 当前项目翼） */
function runSave(p: MemoryParams, ctx: ToolContext): ToolResult {
  if (!p.room || !p.insight) {
    return errorText('Error: room and insight are required');
  }
  if (!p.hall || !MEMORY_HALLS.includes(p.hall as MemoryHall)) {
    return errorText(`Error: hall must be one of ${MEMORY_HALLS.join(', ')}`);
  }

  const engine = ctx.services.tryResolve<MemoryEngineServiceImpl>(ServiceNames.MEMORY_ENGINE);
  if (!engine) {
    return errorText('Error: memory engine not available');
  }

  try {
    const isUserLevel = p.hall === 'preference' || p.hall === 'suggestion';
    const record = engine.save(ctx.cwd, {
      wing: isUserLevel ? 'user' : engine.currentWing(ctx.cwd),
      room: p.room,
      hall: p.hall as MemoryHall,
      verbatim: p.verbatim ?? p.insight,
      insight: p.insight,
      ...(Array.isArray(p.tags) ? { tags: p.tags } : {}),
      ...(typeof p.importance === 'number' ? { importance: p.importance } : {}),
      source: { sessionId: ctx.sessionId },
    });
    return {
      content: [
        {
          type: 'text',
          text: `已保存记忆 [${record.wing}/${record.room}/${record.hall}] id=${record.id}：${record.insight}`,
        },
      ],
      metadata: { memoryId: record.id, wing: record.wing, room: record.room },
    };
  } catch (err) {
    return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** action=search：L3 深度检索（可按 wing/room/hall 过滤） */
function runSearch(p: MemoryParams, ctx: ToolContext): ToolResult {
  if (!p.query) {
    return errorText('Error: query is required');
  }

  const engine = ctx.services.tryResolve<MemoryEngineServiceImpl>(ServiceNames.MEMORY_ENGINE);
  if (!engine) {
    return errorText('Error: memory engine not available');
  }

  const hall =
    p.hall && MEMORY_HALLS.includes(p.hall as MemoryHall)
      ? (p.hall as MemoryHall)
      : undefined;
  const topK = Math.min(50, Math.max(1, p.topK ?? 10));

  const hits = engine.searchScored(ctx.cwd, p.query, {
    ...(p.wing ? { wing: p.wing } : {}),
    ...(p.room ? { room: p.room } : {}),
    ...(hall ? { hall } : {}),
  }, topK);

  if (hits.length === 0) {
    return {
      content: [{ type: 'text', text: `未找到与「${p.query}」相关的记忆。可用 memory（action=list_rooms）查看宫殿结构。` }],
      metadata: { count: 0 },
    };
  }

  const lines = hits.map(
    m =>
      `- [${m.wing}/${m.room}/${m.hall}] (相关度 ${m.score.toFixed(2)} · 重要性${m.importance.toFixed(1)}${m.pinned ? '，置顶' : ''}) ${m.insight}\n  原文：${m.verbatim.slice(0, 200)}${m.verbatim.length > 200 ? '…' : ''}`,
  );
  return {
    content: [{ type: 'text', text: `检索到 ${hits.length} 条相关记忆：\n${lines.join('\n')}` }],
    metadata: {
      count: hits.length,
      ids: hits.map(h => h.id),
      scores: hits.map(h => Math.round(h.score * 1000) / 1000),
    },
  };
}

/** action=list_rooms：列出记忆宫殿结构（翼→房间→厅） */
function runListRooms(ctx: ToolContext): ToolResult {
  const engine = ctx.services.tryResolve<MemoryEngineServiceImpl>(ServiceNames.MEMORY_ENGINE);
  if (!engine) {
    return errorText('Error: memory engine not available');
  }

  const tree = engine.palaceTree(ctx.cwd);
  if (tree.wings.length === 0) {
    return {
      content: [{ type: 'text', text: '记忆宫殿为空。可用 memory（action=save）保存第一条记忆。' }],
      metadata: { wings: 0 },
    };
  }

  const lines = tree.wings.map(w => {
    const rooms = w.rooms
      .map(r => `  - ${r.room}（${r.count} 条：${r.halls.map(h => `${h.hall}×${h.count}`).join('、')}）`)
      .join('\n');
    return `- 翼「${w.wing}」[${w.scope}]：共 ${w.total} 条\n${rooms}`;
  });
  return {
    content: [{ type: 'text', text: `记忆宫殿结构：\n${lines.join('\n')}` }],
    metadata: { wings: tree.wings.length, total: tree.wings.reduce((s, w) => s + w.total, 0) },
  };
}

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = (params ?? {}) as MemoryParams;
    switch (p.action) {
      case 'save':
        return runSave(p, ctx);
      case 'search':
        return runSearch(p, ctx);
      case 'list_rooms':
        return runListRooms(ctx);
      default:
        return errorText('Error: action must be one of save, search, list_rooms');
    }
  },
};