// webui/src/lib/stream-buffer.test.ts
// offset 续传核心纯函数单测：去重（重放）/ 正常续接（刷新后接流）/ 缺口自检 / 无 offset 兼容。
// 运行：bun test webui/src/lib/stream-buffer.test.ts（或根目录 npm test）

import { describe, it, expect } from 'bun:test';
import {
  enqueueTextChunk,
  finishResync,
  flushPending,
  nextChunkSlice,
  onStreamResyncNeeded,
  resetStreamBuffer,
} from './stream-buffer';
import { useStore } from '../store';

// bun 测试环境无 DOM：为 rAF 兜底（stream-buffer 的 scheduleFlush 会调用它）
const g = globalThis as unknown as {
  requestAnimationFrame?: (cb: (t: number) => void) => number;
  cancelAnimationFrame?: (id: number) => void;
};
if (typeof g.requestAnimationFrame !== 'function') {
  g.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number;
}
if (typeof g.cancelAnimationFrame !== 'function') {
  g.cancelAnimationFrame = (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}

describe('nextChunkSlice', () => {
  it('新消息首片（offset 0，当前长度 0）→ 整段追加', () => {
    expect(nextChunkSlice(0, 0, '你好')).toEqual({ slice: '你好', resync: false });
  });

  it('连续续写 → 整段追加', () => {
    expect(nextChunkSlice(2, 2, '世界')).toEqual({ slice: '世界', resync: false });
  });

  it('重复分片（完全落在已知区间内）→ 丢弃，不重复追加', () => {
    expect(nextChunkSlice(6, 2, '世界')).toEqual({ slice: '', resync: false });
  });

  it('部分重叠（重连重放的典型形态）→ 只追加未收到的尾部', () => {
    // 已知 4 个字符，分片覆盖 [2,6) → 只应追加后 2 个字符
    expect(nextChunkSlice(4, 2, 'cdef')).toEqual({ slice: 'ef', resync: false });
  });

  it('缺口（offset 大于已知长度）→ 要求重新对齐', () => {
    expect(nextChunkSlice(2, 5, 'xyz')).toEqual({ slice: '', resync: true });
  });

  it('无 offset（旧后端 / 非流式来源）→ 退化为尾部追加', () => {
    expect(nextChunkSlice(123, undefined, 'abc')).toEqual({ slice: 'abc', resync: false });
  });

  it('空文本 → 什么都不做', () => {
    expect(nextChunkSlice(0, 0, '')).toEqual({ slice: '', resync: false });
  });

  it('刷新恢复场景：草稿长度作为已知长度，后续分片精确接上（不重不漏）', () => {
    const draft = '前半段回复'; // 服务端草稿内容
    const full = '前半段回复后半段回复'; // 该轮完整内容
    const rest = full.slice(draft.length);
    expect(nextChunkSlice(draft.length, draft.length, rest)).toEqual({ slice: rest, resync: false });
    // 若同一个分片被重复投递（重连重放）→ 第二次判定为重复
    expect(nextChunkSlice(full.length, draft.length, rest)).toEqual({ slice: '', resync: false });
  });

  it('草稿落后于服务端（分片起点在草稿长度之前）→ 只补差额', () => {
    const draftLen = 10;
    // 分片 [4, 14) 到达：应只追加第 10~13 这 4 个字符
    expect(nextChunkSlice(draftLen, 4, 'x'.repeat(10))).toEqual({
      slice: 'x'.repeat(4),
      resync: false,
    });
  });
});

// 缺口对齐的健壮性：不再「一次失败、整轮报废」——冷却窗口内不重复请求，
// 对齐动作结束（finishResync）后仍能再次发起，保证后续分片有机会被重放而不是永久丢弃。
describe('缺口对齐（resync 冷却 + 释放）', () => {
  it('gap 触发一次 resync；冷却内不重复；finishResync 后可再次触发', () => {
    const sid = `test-resync-${Date.now()}`;
    let calls = 0;
    const off = onStreamResyncNeeded(() => {
      calls++;
    });
    useStore.getState().setMessages(sid, []);
    try {
      // 首片即缺口（offset 5 > 当前长度 0）→ 请求对齐
      enqueueTextChunk({ sessionId: sid, messageId: 'm-gap', field: 'content', offset: 5, text: 'abcde' });
      flushPending();
      expect(calls).toBe(1);

      // 冷却窗口内再次缺口 → 不重复请求（避免风暴）
      enqueueTextChunk({ sessionId: sid, messageId: 'm-gap', field: 'content', offset: 6, text: 'f' });
      flushPending();
      expect(calls).toBe(1);

      // 一次对齐动作结束 → 释放冷却，后续缺口仍能再次对齐
      finishResync(sid);
      enqueueTextChunk({ sessionId: sid, messageId: 'm-gap', field: 'content', offset: 7, text: 'g' });
      flushPending();
      expect(calls).toBe(2);
    } finally {
      off();
      useStore.getState().setMessages(sid, []);
      resetStreamBuffer(sid);
    }
  });
});