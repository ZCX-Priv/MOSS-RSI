// src/modules/agent/session-msg-seq.test.ts
// 会话级消息序号（msgSeq / nextMsgSeq）测试 —— messageId 基数单调性的关键行为：
//   1. 空会话：从 1 开始，逐次递增
//   2. 旧数据初始化：历史里最大 `#后缀`（旧 `<sess>#<turn>` 跨 run 重复格式）优先于消息数，
//      保证新 id 永远大于一切已存在的 id（跨 run 不撞 id）
//   3. msgSeq 随 session 持久化并可重载（进程重启后继续递增，不回撞）
//   4. 压缩/撤回使 messages.length 回落不影响 nextMsgSeq 继续递增

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, Environment } from '../../core/types';
import { SessionStore, type Session } from './session';

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => logger,
  setLevel: () => {},
  getLevel: () => 'info',
};

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'moss-msgseq-test-'));
});

afterEach(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows 偶发句柄延迟释放
  }
});

function makeStore(): SessionStore {
  return new SessionStore({ dataDir } as Environment, logger, { resolveSessionDir: () => 'test' });
}

/** 直接读磁盘 JSON（不经 SessionStore，排除内存缓存掩盖问题） */
function readPersisted(sid: string): { msgSeq?: number } {
  const tasksDir = join(dataDir, 'tasks');
  for (const entry of existsSync(tasksDir) ? readdirSync(tasksDir, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue;
    const p = join(tasksDir, entry.name, `${sid}.json`);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  throw new Error(`session file not found for ${sid}`);
}

describe('SessionStore.nextMsgSeq（messageId 基数单调性）', () => {
  it('空会话：从 1 开始逐次递增', () => {
    const store = makeStore();
    const session = store.getOrCreate('sess-seq-1');
    expect(store.nextMsgSeq(session)).toBe(1);
    expect(store.nextMsgSeq(session)).toBe(2);
    expect(store.nextMsgSeq(session)).toBe(3);
  });

  it('旧数据初始化：历史最大 #后缀 优先于消息数（旧格式留下的重复 id 不会被回撞）', () => {
    const store = makeStore();
    const sid = 'sess-seq-2';
    const session = store.getOrCreate(sid);
    // 模拟旧数据：3 条消息，但历史 run 的 messageId 后缀已到 12（跨 run 重复的旧格式）
    store.addUserMessage(session, 'q');
    store.addAssistantMessage(session, 'a1', undefined, undefined, `${sid}#12`);
    store.addAssistantMessage(session, 'a2', undefined, undefined, `${sid}#3`);
    // 基数 = max(消息数 3, 最大后缀 12) + 1 = 13 → 新 run turn 1 的 id = #14，绝不与历史相撞
    expect(store.nextMsgSeq(session)).toBe(13);
  });

  it('msgSeq 持久化并跨实例递增（进程重启后不回撞）', () => {
    const sid = 'sess-seq-3';
    const store = makeStore();
    const session = store.getOrCreate(sid);
    store.addUserMessage(session, 'q');
    store.nextMsgSeq(session); // → 2
    store.persistSession(session);
    expect(readPersisted(sid).msgSeq).toBe(2);

    // 新实例（重启）：继续递增
    const reloaded = makeStore().get(sid);
    expect(reloaded).not.toBeNull();
    expect(makeStore().nextMsgSeq(reloaded as Session)).toBe(3);
  });

  it('压缩/撤回导致 messages.length 回落不影响 nextMsgSeq 继续递增', () => {
    const store = makeStore();
    const sid = 'sess-seq-4';
    const session = store.getOrCreate(sid);
    // 20 条消息 + 一次 run 消耗 seq → 21
    for (let i = 0; i < 20; i++) store.addUserMessage(session, `q${i}`);
    expect(store.nextMsgSeq(session)).toBe(21);
    // 压缩物理折叠：中段 15 条被移除、插入 1 条摘要 → length 6（大幅回落）
    session.messages.splice(2, 15, { role: 'user', content: '摘要占位' });
    // 新 run 基数仍从 22 递增（不受 length 回落影响 → 不与已落盘的 #21+ 相撞）
    expect(store.nextMsgSeq(session)).toBe(22);
  });

  it('跨 run messageId 唯一性：逐轮取号不碰撞（旧 base+turn 公式必然碰撞）', () => {
    const store = makeStore();
    const sid = 'sess-seq-unique';
    const session = store.getOrCreate(sid);

    // 旧公式（每 run 只取一次基数，id = base + turn）的缺陷固化：run1 三个 turn、run2 两个 turn，
    // run2 的 id 会复用 run1 的 #2/#3 → 前端按 messageId 去重把新回复的流式分片全部丢弃
    // （「响应中」永挂、后端却正常跑的根因）。
    const legacyIds: string[] = [];
    const base1 = store.nextMsgSeq(session);
    for (let turn = 1; turn <= 3; turn++) legacyIds.push(`${sid}#${base1 + turn}`);
    const base2 = store.nextMsgSeq(session);
    for (let turn = 1; turn <= 2; turn++) legacyIds.push(`${sid}#${base2 + turn}`);
    expect(new Set(legacyIds).size).toBeLessThan(legacyIds.length);

    // 新公式（engine 逐 turn 取号，id = msgSeq）：run 内与跨 run 均严格单调唯一。
    const fixed: string[] = [];
    for (let turn = 1; turn <= 3; turn++) fixed.push(`${sid}#${store.nextMsgSeq(session)}`);
    for (let turn = 1; turn <= 2; turn++) fixed.push(`${sid}#${store.nextMsgSeq(session)}`);
    expect(new Set(fixed).size).toBe(fixed.length);
  });
});
