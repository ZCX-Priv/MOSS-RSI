// src/modules/agent/session-pin.test.ts
// 运行中会话身份保护：钉住（pin）后不得被 LRU/watcher/重载替换；
// adopt 归位后工具结果必须写在 run 的权威对象上。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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
  dataDir = mkdtempSync(join(tmpdir(), 'moss-pin-test-'));
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

/** 直接写一个最小会话文件（模拟磁盘上的其他会话） */
function writeSessionFile(id: string, content: string): void {
  const dir = join(dataDir, 'tasks', 'test');
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      messages: [{ role: 'user', content, timestamp: now }],
      createdAt: now,
      updatedAt: now,
      totalTokens: 0,
      contextFiles: [],
    }),
    'utf8',
  );
}

/** 构造一条带 toolCalls 的 assistant 消息 */
function assistantWithToolCall(id: string): Session['messages'][number] {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name: 'read', arguments: '{}' }],
    timestamp: new Date().toISOString(),
  };
}

describe('SessionStore 运行中会话身份保护', () => {
  it('钉住后全量加载不会把运行中会话换成重载对象', async () => {
    const store = makeStore();
    const running = store.getOrCreate('running');
    running.messages.push({ role: 'user', content: 'hello', timestamp: new Date().toISOString() });
    store.persistSession(running);
    store.pin('running', running);

    for (let i = 0; i < 12; i++) writeSessionFile(`other-${i}`, `o${i}`);
    await store.whenIndexed();
    store.list();

    expect(store.get('running')).toBe(running);
    expect(store.peek('running')).toBe(running);
  });

  it('钉住期间 invalidate 不丢弃对象；unpin 后才允许重载', () => {
    const store = makeStore();
    const running = store.getOrCreate('s1');
    running.messages.push({ role: 'user', content: 'x', timestamp: new Date().toISOString() });
    store.persistSession(running);
    store.pin('s1', running);

    store.invalidate('s1');
    expect(store.get('s1')).toBe(running);

    store.unpin('s1');
    store.invalidate('s1');
    const reloaded = store.get('s1');
    expect(reloaded).not.toBe(running);
  });

  it('adopt 归位后工具结果写在 run 的权威对象上', () => {
    const store = makeStore();
    const original = store.getOrCreate('s2');
    original.messages.push(assistantWithToolCall('t1'));
    store.persistSession(original);

    // 模拟运行中被外部失效并重载出第二个对象
    store.invalidate('s2');
    const clone = store.get('s2')!;
    expect(clone).not.toBe(original);

    // 归位后 get 必须返回 run 的对象
    store.adopt('s2', original);
    expect(store.get('s2')).toBe(original);

    // 工具结果只落在权威对象上：clone 里 t1 是 loadFromDisk 自愈补的错误结果，
    // 不应被 run 的真实结果覆盖。
    store.addToolMessage(original, 't1', 'ok', 'read');
    const originalResult = original.messages.find((m) => m.role === 'tool' && m.toolCallId === 't1');
    const cloneResult = clone.messages.find((m) => m.role === 'tool' && m.toolCallId === 't1');
    expect(originalResult?.content).toBe('ok');
    expect(cloneResult?.content).not.toBe('ok');
  });
});
