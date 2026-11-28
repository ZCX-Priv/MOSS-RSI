// webui/src/lib/task-steps.test.ts
// 对话流折叠分组回归：回合尾操作栏位置 + 折叠行稳定身份。
// 运行：bun test webui/src/lib/task-steps.test.ts

import { describe, it, expect } from 'bun:test';
import {
  buildChatItems,
  createFoldKeyStore,
  type ChatListItem,
  type CompactRound,
  type ProcessRun,
} from './task-steps';
import type { TaskMessage, ToolCall } from '../types/api';

function user(id: string): TaskMessage {
  return { id, role: 'user', content: `q-${id}`, timestamp: '2026-01-01T00:00:00.000Z' };
}

function assistant(id: string, patch: Partial<TaskMessage> = {}): TaskMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: '2026-01-01T00:00:01.000Z',
    ...patch,
  };
}

function tool(id: string): ToolCall {
  return { id, name: 'read', arguments: '{}', status: 'done' };
}

function runs(items: ChatListItem[]): ProcessRun[] {
  return items
    .filter((item): item is Extract<ChatListItem, { kind: 'run' }> => item.kind === 'run')
    .map((item) => item.run);
}

function rounds(items: ChatListItem[]): CompactRound[] {
  return items
    .filter((item): item is Extract<ChatListItem, { kind: 'round' }> => item.kind === 'round')
    .map((item) => item.round);
}

function footers(items: ChatListItem[]): TaskMessage[] {
  return items
    .filter(
      (item): item is Extract<ChatListItem, { kind: 'replyFooter' }> =>
        item.kind === 'replyFooter',
    )
    .map((item) => item.message);
}

describe('replyFooter（回合尾操作栏）', () => {
  it('正文 + 工具：操作栏排在正文与工具折叠行之后', () => {
    const items = buildChatItems([
      user('u1'),
      assistant('a1', { content: '正文', toolCalls: [tool('t1')] }),
    ]);
    const bodyIndex = items.findIndex((item) => item.kind === 'body');
    const runIndex = items.findIndex((item) => item.kind === 'run');
    const footerIndex = items.findIndex((item) => item.kind === 'replyFooter');
    expect(bodyIndex).toBeGreaterThan(-1);
    expect(runIndex).toBeGreaterThan(bodyIndex);
    expect(footerIndex).toBeGreaterThan(runIndex);
    expect(footers(items).map((m) => m.id)).toEqual(['a1']);
  });

  it('纯工具回复：仍然有操作栏，且排在 run 之后', () => {
    const items = buildChatItems([
      user('u1'),
      assistant('a1', { toolCalls: [tool('t1')] }),
    ]);
    expect(runs(items)).toHaveLength(1);
    expect(items[items.length - 1]?.kind).toBe('replyFooter');
    expect(footers(items).map((m) => m.id)).toEqual(['a1']);
  });

  it('中间轮（非回复结尾）不产生操作栏', () => {
    const items = buildChatItems([
      user('u1'),
      assistant('a1', { toolCalls: [tool('t1')] }),
      assistant('a2', { toolCalls: [tool('t2')] }),
    ]);
    // 两条纯工具消息合并为一个 run；只有最后一条是回复结尾
    expect(runs(items)).toHaveLength(1);
    expect(runs(items)[0].parts).toHaveLength(2);
    expect(footers(items).map((m) => m.id)).toEqual(['a2']);
  });

  it('错误卡不重复生成操作栏（由 SystemErrorCard 自带）', () => {
    const items = buildChatItems([
      user('u1'),
      assistant('a1', { content: 'boom', isError: true }),
    ]);
    expect(footers(items)).toHaveLength(0);
  });

  it('简洁挡：操作栏排在本轮折叠行之后', () => {
    const items = buildChatItems(
      [user('u1'), assistant('a1', { content: '完成', thinking: '想一下' })],
      'compact',
    );
    const roundIndex = items.findIndex((item) => item.kind === 'round');
    const footerIndex = items.findIndex((item) => item.kind === 'replyFooter');
    expect(roundIndex).toBeGreaterThan(-1);
    expect(footerIndex).toBeGreaterThan(roundIndex);
    expect(footers(items).map((m) => m.id)).toEqual(['a1']);
  });
});

describe('过程折叠行运行状态（片段级）', () => {
  const okResult = {
    content: [{ type: 'text' as const, text: 'ok' }],
  };

  it('工具已完成 + 正文仍流式 → 折叠行已完成', () => {
    const msg = assistant('a1', {
      content: '正文继续输出',
      streaming: true,
      toolCalls: [tool('t1')],
      toolResults: [{ toolCallId: 't1', result: okResult }],
    });
    const run = runs(buildChatItems([user('u1'), msg]))[0];
    expect(run).toBeDefined();
    expect(run.running).toBe(false);
  });

  it('思考已结束 + 正文仍流式 → 已完成；思考仍在流式 → 运行中', () => {
    const done = assistant('a1', {
      content: '正文',
      streaming: true,
      thinking: '想好了',
      thinkingStreaming: false,
    });
    expect(runs(buildChatItems([user('u1'), done]))[0]?.running).toBe(false);

    const streaming = assistant('a2', {
      content: '正文',
      streaming: true,
      thinking: '还在想',
      thinkingStreaming: true,
    });
    expect(runs(buildChatItems([user('u1'), streaming]))[0]?.running).toBe(true);
  });

  it('工具执行中（无结果）→ 运行中；拿到结果后立即完成', () => {
    const executing = assistant('a1', {
      content: '正文',
      streaming: true,
      toolCalls: [{ ...tool('t1'), status: 'executing' }],
    });
    expect(runs(buildChatItems([user('u1'), executing]))[0]?.running).toBe(true);

    const finished = assistant('a1', {
      content: '正文',
      streaming: true,
      toolCalls: [tool('t1')],
      toolResults: [{ toolCallId: 't1', result: okResult }],
    });
    expect(runs(buildChatItems([user('u1'), finished]))[0]?.running).toBe(false);
  });
});

describe('折叠行稳定身份', () => {
  it('prepend 更早的工具消息后，合并 run 的 key 不变', () => {
    const foldKeys = createFoldKeyStore();
    const m2 = assistant('m2', { toolCalls: [tool('t2')] });

    const first = buildChatItems([user('u1'), m2], 'standard', { foldKeys });
    const firstRun = runs(first)[0];
    expect(firstRun).toBeDefined();

    const m1 = assistant('m1', { toolCalls: [tool('t1')] });
    const second = buildChatItems([user('u1'), m1, m2], 'standard', { foldKeys });
    const secondRun = runs(second)[0];
    expect(secondRun).toBeDefined();
    // m1 向后并入已存在的 run：身份沿用 m2 首建时的 foldId
    expect(secondRun.parts).toHaveLength(2);
    expect(secondRun.key).toBe(firstRun.key);
  });

  it('prepend 扩展现有 round 后，round 的 key 不变', () => {
    const foldKeys = createFoldKeyStore();
    const a2 = assistant('a2', { content: '最终正文' });

    const first = buildChatItems([user('u1'), a2], 'compact', { foldKeys });
    const firstRound = rounds(first)[0];
    expect(firstRound).toBeDefined();

    const a1 = assistant('a1', { thinking: '先想' });
    const second = buildChatItems([user('u1'), a1, a2], 'compact', { foldKeys });
    const secondRound = rounds(second)[0];
    expect(secondRound).toBeDefined();
    expect(secondRound.messages).toHaveLength(2);
    expect(secondRound.key).toBe(firstRound.key);
  });

  it('正文把同一 run 拆成两段时，两段使用不同 key', () => {
    const foldKeys = createFoldKeyStore();
    const before = assistant('a1', { thinking: '先想', toolCalls: [tool('t1')] });
    const merged = runs(buildChatItems([user('u1'), before], 'standard', { foldKeys }));
    expect(merged).toHaveLength(1);

    // 正文到达后：thinking 与 tools 分别落在正文两侧 → 拆成两个 run
    const after = assistant('a1', {
      thinking: '先想',
      content: '正文',
      toolCalls: [tool('t1')],
    });
    const split = runs(buildChatItems([user('u1'), after], 'standard', { foldKeys }));
    expect(split).toHaveLength(2);
    const keys = split.map((run) => run.key);
    expect(new Set(keys).size).toBe(2);

    // 再次重建：拆分后的两个身份保持稳定
    const rebuilt = runs(buildChatItems([user('u1'), after], 'standard', { foldKeys }));
    expect(rebuilt.map((run) => run.key)).toEqual(keys);
  });
});
