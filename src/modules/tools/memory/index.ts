// tools/memory/index.ts
// memory 工具 execute 逻辑：统一记忆工具，按 action 分派。
//   save       —— 保存一条长期记忆到记忆宫殿（L3 深度检索配套写入入口）
//   search     —— L3 深度检索记忆宫殿（全量跨翼 BM25；结果含 id，供 update/delete/pin 使用）
//   list_rooms —— 列出记忆宫殿树（翼→房间→厅）
//   update     —— 按 id 修正一条记忆（含 room 迁移；至少一个字段）
//   delete     —— 按 id 删除被推翻的记忆
//   pin        —— 按 id 置顶/取消置顶（进入/退出 L1 关键事实常驻层）
// 元数据见同目录 tool.json。

import type { ToolContext, ToolResult } from '../types';
import { ServiceNames } from '../../../core/types';
import { MEMORY_HALLS } from '../../../modules/memory/types';
import type { MemoryHall, MemoryUpsertInput } from '../../../modules/memory/types';
import type { MemoryEngineServiceImpl } from '../../../modules/memory/service';

type MemoryHallType = (typeof MEMORY_HALLS)[number];

interface MemoryParams {
  action?: string;
  // --- save ---
  room?: string;
  hall?: string;
  verbatim?: string;
  insight?: string;
  tags?: string[];
  importance?: number;
  pinned?: boolean;
  // --- update / delete / pin ---
  id?: string;
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
  if (!p.hall || !MEMORY_HALLS.includes(p.hall as MemoryHallType)) {
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
      hall: p.hall as MemoryHallType,
      verbatim: p.verbatim ?? p.insight,
      insight: p.insight,
      ...(Array.isArray(p.tags) ? { tags: p.tags } : {}),
      ...(typeof p.importance === 'number' ? { importance: p.importance } : {}),
      source: { sessionId: ctx.sessionId },
      // Agent 主动记录
      origin: 'active',
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
    p.hall && MEMORY_HALLS.includes(p.hall as MemoryHallType)
      ? (p.hall as MemoryHallType)
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
      `- [${m.wing}/${m.room}/${m.hall}] id=${m.id} (相关度 ${m.score.toFixed(2)} · 重要性${m.importance.toFixed(1)}${m.pinned ? '，置顶' : ''}) ${m.insight}\n  原文：${m.verbatim.slice(0, 200)}${m.verbatim.length > 200 ? '…' : ''}`,
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

/** action=update：按 id 修正记忆（至少一个字段；改 room 时引擎负责迁移文件） */
function runUpdate(p: MemoryParams, ctx: ToolContext): ToolResult {
  if (!p.id) {
    return errorText('Error: id is required (use action=search to get memory ids)');
  }
  if (p.hall !== undefined && !MEMORY_HALLS.includes(p.hall as MemoryHallType)) {
    return errorText(`Error: hall must be one of ${MEMORY_HALLS.join(', ')}`);
  }

  const patch: Partial<MemoryUpsertInput> = {
    ...(p.room !== undefined ? { room: p.room } : {}),
    ...(p.hall !== undefined ? { hall: p.hall as MemoryHallType } : {}),
    ...(p.verbatim !== undefined ? { verbatim: p.verbatim } : {}),
    ...(p.insight !== undefined ? { insight: p.insight } : {}),
    ...(Array.isArray(p.tags) ? { tags: p.tags } : {}),
    ...(typeof p.importance === 'number' ? { importance: p.importance } : {}),
    ...(typeof p.pinned === 'boolean' ? { pinned: p.pinned } : {}),
  };
  if (Object.keys(patch).length === 0) {
    return errorText('Error: at least one field to update is required');
  }

  const engine = ctx.services.tryResolve<MemoryEngineServiceImpl>(ServiceNames.MEMORY_ENGINE);
  if (!engine) {
    return errorText('Error: memory engine not available');
  }

  try {
    const record = engine.update(ctx.cwd, p.id, patch);
    if (!record) return errorText(`Error: memory ${p.id} not found`);
    return {
      content: [
        {
          type: 'text',
          text: `已更新记忆 [${record.wing}/${record.room}/${record.hall}] id=${record.id}：${record.insight}`,
        },
      ],
      metadata: { memoryId: record.id, wing: record.wing, room: record.room },
    };
  } catch (err) {
    return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** action=delete：按 id 删除被推翻的记忆 */
function runDelete(p: MemoryParams, ctx: ToolContext): ToolResult {
  if (!p.id) {
    return errorText('Error: id is required (use action=search to get memory ids)');
  }

  const engine = ctx.services.tryResolve<MemoryEngineServiceImpl>(ServiceNames.MEMORY_ENGINE);
  if (!engine) {
    return errorText('Error: memory engine not available');
  }

  const ok = engine.delete(ctx.cwd, p.id);
  if (!ok) return errorText(`Error: memory ${p.id} not found`);
  return {
    content: [{ type: 'text', text: `已删除记忆 id=${p.id}` }],
    metadata: { memoryId: p.id, deleted: true },
  };
}

/** action=pin：按 id 置顶/取消置顶（置顶进入 L1 关键事实常驻层） */
function runPin(p: MemoryParams, ctx: ToolContext): ToolResult {
  if (!p.id) {
    return errorText('Error: id is required (use action=search to get memory ids)');
  }
  if (typeof p.pinned !== 'boolean') {
    return errorText('Error: pinned (boolean) is required');
  }

  const engine = ctx.services.tryResolve<MemoryEngineServiceImpl>(ServiceNames.MEMORY_ENGINE);
  if (!engine) {
    return errorText('Error: memory engine not available');
  }

  try {
    const record = engine.update(ctx.cwd, p.id, { pinned: p.pinned });
    if (!record) return errorText(`Error: memory ${p.id} not found`);
    return {
      content: [
        {
          type: 'text',
          text: `已${record.pinned ? '置顶' : '取消置顶'}记忆 id=${record.id}：${record.insight}`,
        },
      ],
      metadata: { memoryId: record.id, pinned: record.pinned },
    };
  } catch (err) {
    return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
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
      case 'update':
        return runUpdate(p, ctx);
      case 'delete':
        return runDelete(p, ctx);
      case 'pin':
        return runPin(p, ctx);
      default:
        return errorText('Error: action must be one of save, search, list_rooms, update, delete, pin');
    }
  },
};