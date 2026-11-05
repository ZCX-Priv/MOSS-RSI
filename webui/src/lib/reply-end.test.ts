// webui/src/lib/reply-end.test.ts
// 「一段 AI 回复的结尾」判定：复制按钮每条回复结尾都带；重新生成/诊断仅最新一段。

import { describe, it, expect } from 'bun:test';
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
      msg('a2', 'assistant', { content: '第一段回复' }), // 第一段回复的结尾
      msg('u2', 'user'),
      msg('a3', 'assistant', { content: '第二段回复' }), // 第二段回复的结尾（最新）
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
      msg('a1', 'assistant', { content: '回复正文' }),
      msg('notice', 'assistant', { maxTurnsNotice: { maxTurns: 30 } }),
    ];
    const { replyEndIds, lastReplyEndId } = computeReplyEnds(messages);
    expect([...replyEndIds]).toEqual(['a1']);
    expect(lastReplyEndId).toBe('a1');
    expect(isSystemCard(messages[2])).toBe(true);
  });

  it('输出触顶卡同理（跳过系统卡找下一条真实对话消息）', () => {
    const messages = [
      msg('a1', 'assistant', { content: '回复正文' }),
      msg('limit', 'assistant', { outputLimitNotice: {} }),
    ];
    const { replyEndIds, lastReplyEndId } = computeReplyEnds(messages);
    expect([...replyEndIds]).toEqual(['a1']);
    expect(lastReplyEndId).toBe('a1');
  });

  it('压缩卡夹在中间被跳过：其前后 assistant 的结尾判定不受影响', () => {
    const messages = [
      msg('a1', 'assistant', { content: '回复一' }),
      msg('comp', 'assistant', { compaction: { before: 0, after: 0 } as never }),
      msg('u2', 'user'),
      msg('a2', 'assistant', { content: '回复二' }),
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

  it('末尾 thinking-only 的 assistant：thinking 视为正文，它自己成为最新回复结尾（操作栏在其底部）', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', { content: '真实回复' }),
      msg('a2', 'assistant', { content: '', thinking: '只有思考内容' }),
    ];
    const { replyEndIds, lastReplyEndId } = computeReplyEnds(messages);
    // a2 阻断 a1 的结尾判定：上一轮工具消息/回复的按钮栏不再跑到新一轮思考折叠行之上
    expect([...replyEndIds]).toEqual(['a2']);
    expect(lastReplyEndId).toBe('a2');
    expect(isReplyEnd(messages, 2)).toBe(true);
  });

  it('末尾连续多个空 assistant：仍回退到最近一条有正文的回复', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', { content: '第一段' }),
      msg('u2', 'user'),
      msg('a2', 'assistant', { content: '第二段' }),
      msg('a3', 'assistant', { content: '   ' }),
      msg('a4', 'assistant', { content: '' }),
    ];
    const { replyEndIds, lastReplyEndId } = computeReplyEnds(messages);
    expect([...replyEndIds].sort()).toEqual(['a1', 'a2']);
    expect(lastReplyEndId).toBe('a2');
  });

  it('只有空 assistant：有 thinking → 算回复结尾；完全空 → 不渲染操作栏', () => {
    const withThinking = [
      msg('u1', 'user'),
      msg('a1', 'assistant', { content: '', thinking: '只有思考' }),
    ];
    const { replyEndIds, lastReplyEndId } = computeReplyEnds(withThinking);
    expect([...replyEndIds]).toEqual(['a1']);
    expect(lastReplyEndId).toBe('a1');

    // 完全空（无正文 / 无思考 / 无工具）：仍是空占位，不抢占回复结尾
    const empty = [msg('u1', 'user'), msg('a1', 'assistant', { content: '' })];
    expect([...computeReplyEnds(empty).replyEndIds]).toEqual([]);
    expect(computeReplyEnds(empty).lastReplyEndId).toBeNull();
  });

  it('空 assistant 中间夹在工具轮次：不影响前后真实回复结尾判定', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', { content: '先说明', toolCalls: [{ id: 't1', name: 'read', arguments: '{}' }] }),
      msg('t1', 'tool', { toolCallId: 't1' }),
      msg('a2', 'assistant', { content: '' }),
      msg('a3', 'assistant', { content: '最终回复' }),
    ];
    const { replyEndIds, lastReplyEndId } = computeReplyEnds(messages);
    expect([...replyEndIds]).toEqual(['a3']);
    expect(lastReplyEndId).toBe('a3');
  });
});
