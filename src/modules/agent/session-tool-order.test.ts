// src/modules/agent/session-tool-order.test.ts
// 中断工具结果顺序修复：assistant(tool_calls) → user → tool 必须收敛为
// assistant → tool → user，否则发送视图 sanitize 会丢弃结果、摘要请求 HTTP 400。

import { describe, test, expect } from 'bun:test';
import { repairToolPairOrder } from './session';
import type { AgentMessage } from '../contracts';

function pair(): AgentMessage[] {
  return [
    {
      role: 'assistant',
      content: '执行中',
      toolCalls: [{ id: 'call_1', name: 'run_code', arguments: '{}' }],
      timestamp: '2026-11-02T08:00:00.000Z',
    },
    {
      role: 'user',
      content: '别跑了',
      timestamp: '2026-11-02T08:00:01.000Z',
    },
    {
      role: 'tool',
      content: 'Error: aborted by user',
      toolCallId: 'call_1',
      name: 'run_code',
      isError: true,
      timestamp: '2026-11-02T08:00:02.000Z',
    },
  ];
}

describe('repairToolPairOrder', () => {
  test('把用户插话后的工具结果搬回所属 assistant 之后', () => {
    const messages = pair();
    const moved = repairToolPairOrder(messages);
    expect(moved).toBe(1);
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
    expect(messages[1].toolCallId).toBe('call_1');
  });

  test('已正确配对时幂等，不改动顺序', () => {
    const messages = pair();
    repairToolPairOrder(messages);
    expect(repairToolPairOrder(messages)).toBe(0);
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
  });

  test('多个 assistant 的工具结果按所属关系归位', () => {
    const messages: AgentMessage[] = [
      { role: 'assistant', content: 'a1', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] },
      { role: 'assistant', content: 'a2', toolCalls: [{ id: 'c2', name: 'read', arguments: '{}' }] },
      { role: 'tool', content: 'r2', toolCallId: 'c2' },
      { role: 'tool', content: 'r1', toolCallId: 'c1' },
    ];
    repairToolPairOrder(messages);
    expect(messages.map((m) => (m.role === 'tool' ? m.toolCallId : m.content))).toEqual([
      'a1',
      'c1',
      'a2',
      'c2',
    ]);
  });
});
