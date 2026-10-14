// webui/src/lib/reply-end.test.ts
// 「一段 AI 回复的结尾」判定：复制按钮每条回复结尾都带；重新生成/诊断仅最新一段。

import { describe, it, expect } from 'vitest';
import { computeReplyEnds, isReplyEnd, isSystemCard } from './reply-end';
import type { TaskMessage } from '@/types/api';

function msg(id: string, role: TaskMessage['role'], extra: Partial<TaskMessage> = {}): TaskMessage {
  return { id, role, content: '', timestamp: new Date(0).toISOString(), ...extra };
}

describe('reply-end：回复结尾判定', () => {
  it('agentic 多轮：中间 assistant 轮（后接 tool）不是结尾，末尾两段回复的结尾各算一处', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', { toolCalls: [{ id: 't1', name: 'read', arguments: '{}' }] }),
      msg('t1', 'tool', { toolCallId: 't1' }),
      msg('a2', 'assistant'), // 第一段回复的结尾
      msg('u2', 'user'),
      msg('a3', 'assistant'), // 第二段回复的结尾（最新）
    ];
    const { replyEndIds, lastReplyEndId } = computeReplyEnds(messages);
    expect([...replyEndIds].sort()).toEqual(['a2', 'a3']);
    expect(lastReplyEndId).toBe('a3');
    expect(isReplyEnd(messages, 1)).toBe(false); // a1 后面是 tool
    expect(isReplyEnd(messages, 3)).toBe(true); // a2 后面是 user
  });

  it('末尾追加 max-turns-notice 卡：卡不算结尾，前一条 assistant 仍是最新回复结尾', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant'),
      msg('notice', 'assistant', { maxTurnsNotice: { maxTurns: 30 } }),
    ];
    const { replyEndIds, lastReplyEndId } = computeReplyEnds(messages);
    expect([...replyEndIds]).toEqual(['a1']);
    expect(lastReplyEndId).toBe('a1');
    expect(isSystemCard(messages[2])).toBe(true);
  });

  it('输出触顶卡同理（跳过系统卡找下一条真实对话消息）', () => {
    const messages = [
      msg('a1', 'assistant'),
      msg('limit', 'assistant', { outputLimitNotice: {} }),
    ];
    const { replyEndIds, lastReplyEndId } = computeReplyEnds(messages);
    expect([...replyEndIds]).toEqual(['a1']);
    expect(lastReplyEndId).toBe('a1');
  });

  it('压缩卡夹在中间被跳过：其前后 assistant 的结尾判定不受影响', () => {
    const messages = [
      msg('a1', 'assistant'),
      msg('comp', 'assistant', { compaction: { before: 0, after: 0 } as never }),
      msg('u2', 'user'),
      msg('a2', 'assistant'),
    ];
    const { replyEndIds, lastReplyEndId } = computeReplyEnds(messages);
    expect([...replyEndIds].sort()).toEqual(['a1', 'a2']);
    expect(lastReplyEndId).toBe('a2');
  });

  it('空列表 / 只有 user 或 tool：无任何回复结尾', () => {
    expect(computeReplyEnds([])).toEqual({ replyEndIds: new Set<string>(), lastReplyEndId: null });
    const messages = [msg('u1', 'user'), msg('t1', 'tool', { toolCallId: 't1' })];
    expect(computeReplyEnds(messages).lastReplyEndId).toBeNull();
  });

  it('错误卡（isError 的 assistant）算回复结尾（可复制/重新生成）', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', { isError: true, errorDetail: 'HTTP 400' }),
    ];
    const { replyEndIds, lastReplyEndId } = computeReplyEnds(messages);
    expect([...replyEndIds]).toEqual(['a1']);
    expect(lastReplyEndId).toBe('a1');
  });
});
