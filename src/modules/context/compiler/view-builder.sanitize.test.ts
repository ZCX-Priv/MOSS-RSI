// src/modules/context/compiler/view-builder.sanitize.test.ts
// 发送视图配对自愈：修复统计必须上浮，窗口兜底不得留下孤立 tool。

import { describe, it, expect } from 'bun:test';
import { buildRequestView } from './view-builder';
import type { ContextMessage, ContextSessionLike } from '../types';

function mkSession(messages: ContextMessage[]): ContextSessionLike {
  return { id: 's1', messages, updatedAt: new Date().toISOString() };
}

describe('buildRequestView 配对自愈', () => {
  it('缺结果的 tool_calls 被剥离并计入统计', () => {
    const session = mkSession([
      { role: 'user', content: 'do work' },
      {
        role: 'assistant',
        content: 'calling tool',
        toolCalls: [{ id: 't1', name: 'read', arguments: '{}' }],
      },
      // t1 没有对应结果
    ]);

    const view = buildRequestView(session, 'SYSTEM', {});
    expect(view.sanitizeDropped.strippedToolCalls).toBe(1);
    expect(view.messages.some(m => m.toolCalls?.length)).toBe(false);
  });

  it('孤立 tool 结果被丢弃并计入统计', () => {
    const session = mkSession([
      { role: 'user', content: 'do work' },
      { role: 'tool', toolCallId: 'ghost', name: 'read', content: 'orphan' },
    ]);

    const view = buildRequestView(session, 'SYSTEM', {});
    expect(view.sanitizeDropped.orphanTools).toBe(1);
    expect(view.messages.some(m => m.role === 'tool')).toBe(false);
  });

  it('极端裁剪后只剩孤立 tool：最终视图不含孤立 tool', () => {
    const session = mkSession([
      { role: 'tool', toolCallId: 'ghost', name: 'read', content: 'x'.repeat(2000) },
    ]);

    const view = buildRequestView(session, 'SYSTEM', { budgetTokens: 1 });
    expect(view.messages.filter(m => m.role === 'tool')).toHaveLength(0);
    // system 之外没有可发送的对话消息 → 由 governor 标记降级
    expect(view.messages.length).toBe(1);
  });
});
