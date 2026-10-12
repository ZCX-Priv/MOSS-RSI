// webui/src/store/merge-history.test.ts
// mergeHistory 归并新语义单测（消息身份对齐后「流式草稿 ↔ 服务端正式副本」的关键行为）：
// - catchup 同 id 原位 patch：槽位稳定（不删旧插新）、streaming 收尾、内容以服务端为准
// - catchup 未确认草稿：dropStreaming 移除 / 非 dropStreaming 保留
// - catchup 幂等：同一批消息重复合并不重复、不膨胀
// - tail 权威替换：同 id patch 后不重复保留，interrupted 提示消息保留
// 运行：bun test webui/src/store/merge-history.test.ts

import { describe, it, expect, beforeEach } from 'bun:test';
import { useStore } from './index';
import type { TaskMessage } from '../types/api';

let seq = 0;
function newSession(): string {
  seq += 1;
  return `test-merge-${seq}`;
}

function userMsg(id: string, content: string): TaskMessage {
  return { id, role: 'user', content, timestamp: new Date().toISOString() };
}

/** 流式草稿（id = 服务端 messageId，内容为半截） */
function draft(id: string, content: string): TaskMessage {
  return {
    id,
    serverMessageId: id,
    role: 'assistant',
    content,
    streaming: true,
    thinkingStreaming: false,
    timestamp: new Date().toISOString(),
  };
}

/** 服务端正式副本（历史路径 adapt 而来：id = messageId + serverMessageId 同源） */
function formal(id: string, content: string, toolCalls?: TaskMessage['toolCalls']): TaskMessage {
  return {
    id,
    serverMessageId: id,
    role: 'assistant',
    content,
    ...(toolCalls ? { toolCalls } : {}),
    timestamp: new Date().toISOString(),
  };
}

beforeEach(() => {
  // 不重置全局 store（单例不可重建），每个用例使用独立 sessionId 隔离
});

describe('mergeHistory catchup（尾部补齐）', () => {
  it('同 id 草稿被原位 patch：位置不变、内容以服务端为准、streaming 收尾', () => {
    const sid = newSession();
    const st = useStore.getState();
    const d = draft('sess#1', '流式半截内容');
    st.setMessages(sid, [userMsg('u1', '问题'), d]);
    const before = useStore.getState().messagesBySession[sid]!;
    expect(before).toHaveLength(2);

    const server = formal('sess#1', '服务端完整正式内容');
    st.mergeHistory(sid, [server], 'catchup', {
      total: 2,
      oldestIndex: 0,
      newestIndex: 1,
      hasMoreBefore: false,
    });

    const after = useStore.getState().messagesBySession[sid]!;
    // 槽位稳定：不删旧插新，仍是一条 user + 一条 assistant
    expect(after).toHaveLength(2);
    expect(after[0].id).toBe('u1');
    expect(after[1].id).toBe('sess#1');
    // 内容以服务端为准 + 流式态收尾
    expect(after[1].content).toBe('服务端完整正式内容');
    expect(after[1].streaming).toBe(false);
    expect(after[1].thinkingStreaming).toBe(false);
  });

  it('同 id patch + 未确认新消息混合：patch 命中，未知 id 按序追加，不重复', () => {
    const sid = newSession();
    const st = useStore.getState();
    st.setMessages(sid, [userMsg('u1', 'q'), draft('sess#1', '半截')]);

    const server = [
      formal('sess#1', '完整'),
      userMsg('u2', '追问'),
      formal('sess#2', '第二轮'),
    ];
    st.mergeHistory(sid, server, 'catchup', {
      total: 4,
      oldestIndex: 0,
      newestIndex: 3,
      hasMoreBefore: false,
    });

    const after = useStore.getState().messagesBySession[sid]!;
    expect(after.map((m) => m.id)).toEqual(['u1', 'sess#1', 'u2', 'sess#2']);
    expect(after[1].content).toBe('完整');
    expect(after[1].streaming).toBe(false);
  });

  it('dropStreaming=true：服务端未确认的本地草稿被移除（防残留 spinner）', () => {
    const sid = newSession();
    const st = useStore.getState();
    // 两条本地草稿：sess#1 有服务端副本（patch 命中），sess#9 没有（未确认）
    st.setMessages(sid, [userMsg('u1', 'q'), draft('sess#1', 'a'), draft('sess#9', 'z')]);

    st.mergeHistory(sid, [formal('sess#1', 'a 完整')], 'catchup', {
      total: 2,
      oldestIndex: 0,
      newestIndex: 1,
      hasMoreBefore: false,
    }, { dropStreaming: true });

    const after = useStore.getState().messagesBySession[sid]!;
    expect(after.map((m) => m.id)).toEqual(['u1', 'sess#1']);
    expect(after[1].streaming).toBe(false);
  });

  it('dropStreaming + dropStreamingIds：只丢快照内的旧草稿，保留拉取期间新一轮产生的流式消息', () => {
    const sid = newSession();
    const st = useStore.getState();
    // sess#1 = 刚结束那一轮留下的草稿（在快照内 → 可丢）；sess#2 = 拉取期间新一轮已开始流式（不在快照内 → 必留）
    st.setMessages(sid, [userMsg('u1', 'q'), draft('sess#1', 'a'), draft('sess#2', 'b')]);

    st.mergeHistory(sid, [], 'catchup', {
      total: 2,
      oldestIndex: 0,
      newestIndex: 1,
      hasMoreBefore: false,
    }, { dropStreaming: true, dropStreamingIds: ['sess#1'] });

    const after = useStore.getState().messagesBySession[sid]!;
    expect(after.map((m) => m.id)).toEqual(['u1', 'sess#2']);
    expect(after[1].streaming).toBe(true);
  });

  it('dropStreaming=false（重连对齐）：未确认草稿保留', () => {
    const sid = newSession();
    const st = useStore.getState();
    st.setMessages(sid, [userMsg('u1', 'q'), draft('sess#9', '流式中')]);

    st.mergeHistory(sid, [], 'catchup', {
      total: 2,
      oldestIndex: 0,
      newestIndex: 1,
      hasMoreBefore: false,
    }, { dropStreaming: false });

    const after = useStore.getState().messagesBySession[sid]!;
    expect(after.map((m) => m.id)).toEqual(['u1', 'sess#9']);
    expect(after[1].streaming).toBe(true);
  });

  it('幂等：同一批服务端消息重复 catchup 不重复、不膨胀', () => {
    const sid = newSession();
    const st = useStore.getState();
    st.setMessages(sid, [userMsg('u1', 'q'), draft('sess#1', '半截')]);
    const server = [userMsg('u2', '追问'), formal('sess#1', '完整'), formal('sess#2', 'r2')];

    for (let i = 0; i < 3; i++) {
      st.mergeHistory(sid, server, 'catchup', {
        total: 4,
        oldestIndex: 0,
        newestIndex: 3,
        hasMoreBefore: false,
      });
    }

    const after = useStore.getState().messagesBySession[sid]!;
    expect(after.map((m) => m.id)).toEqual(['u1', 'sess#1', 'u2', 'sess#2']);
  });
});

describe('mergeHistory tail（权威替换）', () => {
  it('空服务端结果保留本地乐观 user 消息（新任务首屏竞态：fetch 先于持久化到达）', () => {
    const sid = newSession();
    const st = useStore.getState();
    // 发送后本地乐观写入的 user 消息（clientMessageId 身份）
    const optimistic: TaskMessage = {
      id: 'msg_opt_1',
      clientMessageId: 'msg_opt_1',
      role: 'user',
      content: '刚发出的问题',
      timestamp: new Date().toISOString(),
    };
    st.setMessages(sid, [optimistic]);

    // 首屏 fetch 返回空（后端尚未持久化 task.stream 的 user 消息）
    st.mergeHistory(sid, [], 'tail', {
      total: 0,
      oldestIndex: 0,
      newestIndex: -1,
      hasMoreBefore: false,
    });

    const after = useStore.getState().messagesBySession[sid]!;
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe('msg_opt_1');
    expect(after[0].content).toBe('刚发出的问题');
  });

  it('服务端含同 clientMessageId 副本时不重复保留乐观消息', () => {
    const sid = newSession();
    const st = useStore.getState();
    const optimistic: TaskMessage = {
      id: 'msg_opt_1',
      clientMessageId: 'msg_opt_1',
      role: 'user',
      content: '问题',
      timestamp: new Date().toISOString(),
    };
    st.setMessages(sid, [optimistic]);

    // 服务端已持久化（同 clientMessageId → adapt 后同 id）
    st.mergeHistory(sid, [userMsg('msg_opt_1', '问题')], 'tail', {
      total: 1,
      oldestIndex: 0,
      newestIndex: 0,
      hasMoreBefore: false,
    });

    const after = useStore.getState().messagesBySession[sid]!;
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe('msg_opt_1');
  });

  it('保留压缩卡片消息（compaction 卡不随末页重载消失）', () => {
    const sid = newSession();
    const st = useStore.getState();
    const card: TaskMessage = {
      id: 'compaction_rc1',
      role: 'assistant',
      content: '压缩摘要',
      timestamp: new Date().toISOString(),
      compaction: {
        id: 'rc1',
        at: new Date().toISOString(),
        trigger: 'auto',
        beforeTokens: 100,
        afterTokens: 50,
        compactedCount: 3,
        summary: '压缩摘要',
        summaryModel: 'test-model',
        durationMs: 10,
      },
    };
    st.setMessages(sid, [card]);

    st.mergeHistory(sid, [userMsg('u1', 'q'), formal('h1', 'a')], 'tail', {
      total: 2,
      oldestIndex: 0,
      newestIndex: 1,
      hasMoreBefore: false,
    });

    const after = useStore.getState().messagesBySession[sid]!;
    expect(after.some((m) => m.id === 'compaction_rc1')).toBe(true);
    expect(after.some((m) => m.id === 'h1')).toBe(true);
  });

  it('同 id 正式消息 patch 草稿后不重复保留，无 id 冲突的正常替换', () => {
    const sid = newSession();
    const st = useStore.getState();
    st.setMessages(sid, [userMsg('u1', 'q'), draft('sess#1', '半截')]);

    // tail：服务端给末页（含与本地草稿同 id 的正式副本）
    st.mergeHistory(sid, [userMsg('u1', 'q'), formal('sess#1', '完整')], 'tail', {
      total: 2,
      oldestIndex: 0,
      newestIndex: 1,
      hasMoreBefore: false,
    });

    const after = useStore.getState().messagesBySession[sid]!;
    expect(after.map((m) => m.id)).toEqual(['u1', 'sess#1']);
    expect(after[1].content).toBe('完整');
    // tail 采用服务端序列：历史消息无 streaming 字段（undefined，falsy）→ 渲染端视为非流式
    expect(!after[1].streaming).toBe(true);
  });

  it('保留 interrupted 提示消息（不在历史里但信息真实）', () => {
    const sid = newSession();
    const st = useStore.getState();
    const interrupted: TaskMessage = {
      ...draft('sess#0', '上次中断的内容'),
      streaming: false,
      interrupted: true,
    };
    st.setMessages(sid, [interrupted]);

    st.mergeHistory(sid, [userMsg('u1', 'q'), formal('h12', '新历史')], 'tail', {
      total: 2,
      oldestIndex: 0,
      newestIndex: 1,
      hasMoreBefore: false,
    });

    const after = useStore.getState().messagesBySession[sid]!;
    expect(after.some((m) => m.interrupted === true && m.id === 'sess#0')).toBe(true);
    expect(after.some((m) => m.id === 'h12')).toBe(true);
  });
});

describe('mergeHistory prepend（上滑加载更早）', () => {
  it('更早一页插到头部，已有消息保持原序', () => {
    const sid = newSession();
    const st = useStore.getState();
    st.setMessages(sid, [userMsg('u1', 'q'), draft('sess#1', 'a')]);

    st.mergeHistory(sid, [userMsg('u0', '更早的问题')], 'prepend', {
      total: 3,
      oldestIndex: 0,
      newestIndex: 2,
      hasMoreBefore: false,
    });

    const after = useStore.getState().messagesBySession[sid]!;
    expect(after.map((m) => m.id)).toEqual(['u0', 'u1', 'sess#1']);
    // 已有草稿不受影响
    expect(after[2].streaming).toBe(true);
  });
});

describe('mergeHistory id 冲突防御（旧格式脏数据兜底）', () => {
  it('同 id 但角色不同（旧 #<turn> 跨 run 撞 id 的典型形态）：不在旧槽位替换，改 dup 后缀追加', () => {
    const sid = newSession();
    const st = useStore.getState();
    // 第一条 assistant 消息（历史遗留，messageId = sess#1）
    st.setMessages(sid, [userMsg('u1', '第一问'), formal('sess#1', '第一条回复的原始内容')]);

    // MCP/新一轮 run 产生的 user 消息也带了 sess#1（旧格式撞 id）
    st.mergeHistory(sid, [userMsg('sess#1', '新消息')], 'catchup', {
      total: 3,
      oldestIndex: 0,
      newestIndex: 2,
      hasMoreBefore: false,
    });

    const after = useStore.getState().messagesBySession[sid]!;
    // 旧消息原样保留（内容未被新消息替换）
    const oldMsg = after.find((m) => m.id === 'sess#1' && m.role === 'assistant');
    expect(oldMsg?.content).toBe('第一条回复的原始内容');
    // 新消息以 dup 后缀 id 追加（key 唯一，不丢）
    const dupMsg = after.find((m) => m.id.startsWith('sess#1#dup'));
    expect(dupMsg?.role).toBe('user');
    expect(dupMsg?.content).toBe('新消息');
    expect(after).toHaveLength(3);
  });

  it('同 id 同角色但时间戳大幅倒退（新消息内容更旧 = 撞 id）：dup 后缀追加，旧消息不被覆盖', () => {
    const sid = newSession();
    const st = useStore.getState();
    const now = new Date();
    const oldTs = new Date(now.getTime() - 3_600_000).toISOString(); // 1 小时前
    st.setMessages(sid, [
      { ...formal('sess#5', '较早 run 的正式内容'), timestamp: new Date().toISOString() },
    ]);

    // 旧数据里 timestamp 更早的同 id 消息到来（时间戳倒退 > 60s）
    st.mergeHistory(sid, [{ ...formal('sess#5', '更早 run 的内容'), timestamp: oldTs }], 'catchup', {
      total: 2,
      oldestIndex: 0,
      newestIndex: 1,
      hasMoreBefore: false,
    });

    const after = useStore.getState().messagesBySession[sid]!;
    const kept = after.find((m) => m.id === 'sess#5');
    expect(kept?.content).toBe('较早 run 的正式内容');
    const dup = after.find((m) => m.id.startsWith('sess#5#dup'));
    expect(dup?.content).toBe('更早 run 的内容');
    expect(after).toHaveLength(2);
  });

  it('正常流式草稿 patch（时间戳接近、角色相同）不受防御误伤', () => {
    const sid = newSession();
    const st = useStore.getState();
    st.setMessages(sid, [userMsg('u1', 'q'), draft('sess#9', '半截')]);

    // 服务端正式副本 timestamp 晚于草稿（turn 结束落盘）→ 正常 patch
    st.mergeHistory(sid, [{ ...formal('sess#9', '完整内容'), timestamp: new Date(Date.now() + 1000).toISOString() }], 'catchup', {
      total: 2,
      oldestIndex: 0,
      newestIndex: 1,
      hasMoreBefore: false,
    });

    const after = useStore.getState().messagesBySession[sid]!;
    expect(after.map((m) => m.id)).toEqual(['u1', 'sess#9']);
    expect(after[1].content).toBe('完整内容');
  });
});

describe('顺序归一（按时间升序；根治「到达顺序」造成的整段倒序）', () => {
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  const at = (ms: number) => new Date(ms).toISOString();
  function msg(id: string, ts: number, role: 'user' | 'assistant' = 'assistant'): TaskMessage {
    return { id, role, content: id, timestamp: at(ts) };
  }

  it('catchup：base 已是较新消息、rest 为较早历史 → 结果仍按时间升序（不再「新在前」）', () => {
    const sid = newSession();
    const st = useStore.getState();
    // 模拟：最新的流式草稿先到（base = [最新]）
    st.setMessages(sid, [msg('draft-new', t0 + 3000)]);
    // 随后才拉回较早历史（rest = 较早两段）
    st.mergeHistory(sid, [msg('h1', t0), msg('h2', t0 + 1000)], 'catchup', {
      total: 3,
      oldestIndex: 0,
      newestIndex: 2,
      hasMoreBefore: false,
    });
    const after = useStore.getState().messagesBySession[sid]!;
    expect(after.map((m) => m.id)).toEqual(['h1', 'h2', 'draft-new']);
  });

  it('addMessage：先入较新、再入较早 → 顺序按时间升序', () => {
    const sid = newSession();
    const st = useStore.getState();
    st.addMessage(sid, msg('newer', t0 + 2000));
    st.addMessage(sid, msg('older', t0 + 1000));
    const after = useStore.getState().messagesBySession[sid]!;
    expect(after.map((m) => m.id)).toEqual(['older', 'newer']);
  });

  it('tail：较早的 localOnly（interrupted）按时间归位，不再被追加到末尾', () => {
    const sid = newSession();
    const st = useStore.getState();
    st.setMessages(sid, [
      { ...msg('stale', t0 + 1000), interrupted: true },
      msg('live', t0 + 5000),
    ]);
    // 服务端末页含两条正式消息（其中 h2 晚于 stale）
    st.mergeHistory(sid, [msg('h1', t0), msg('h2', t0 + 2000)], 'tail', {
      total: 3,
      oldestIndex: 0,
      newestIndex: 2,
      hasMoreBefore: false,
    });
    const after = useStore.getState().messagesBySession[sid]!;
    expect(after.map((m) => m.id)).toEqual(['h1', 'stale', 'h2']);
  });

  it('非法/缺失 timestamp 不抛错、顺序稳定（非法视为最早）', () => {
    const sid = newSession();
    const st = useStore.getState();
    st.setMessages(sid, [
      { id: 'x', role: 'user', content: 'x', timestamp: 'not-a-date' },
      { id: 'y', role: 'user', content: 'y', timestamp: at(t0) },
    ]);
    st.mergeHistory(sid, [], 'catchup', {
      total: 2,
      oldestIndex: 0,
      newestIndex: 1,
      hasMoreBefore: false,
    });
    const after = useStore.getState().messagesBySession[sid]!;
    expect(after.map((m) => m.id)).toEqual(['x', 'y']);
  });
});
