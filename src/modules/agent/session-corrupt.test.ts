// src/modules/agent/session-corrupt.test.ts
// 损坏会话隔离：原文件必须被改名保留，绝不能出现「空会话覆盖历史」。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
let sessionDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'moss-corrupt-test-'));
  sessionDir = join(dataDir, 'tasks', 'test');
  mkdirSync(sessionDir, { recursive: true });
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

function quarantineFiles(id: string): string[] {
  return readdirSync(sessionDir).filter(name => name.startsWith(`${id}.json.corrupt-`));
}

describe('损坏会话隔离', () => {
  it('非法 JSON：隔离原文件并返回空会话', () => {
    writeFileSync(join(sessionDir, 's1.json'), '{ not valid json', 'utf8');

    const store = makeStore();
    const session = store.getOrCreate('s1') as Session;

    expect(session.messages).toEqual([]);
    expect(quarantineFiles('s1').length).toBe(1);
    expect(existsSync(join(sessionDir, 's1.json'))).toBe(false);
    store.dispose();
  });

  it('内容 id 与文件名不一致：视为损坏并隔离', () => {
    writeFileSync(
      join(sessionDir, 's1.json'),
      JSON.stringify({
        id: 'other-session',
        messages: [{ role: 'user', content: 'secret', timestamp: new Date().toISOString() }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totalTokens: 0,
        contextFiles: [],
      }),
      'utf8',
    );

    const store = makeStore();
    const session = store.getOrCreate('s1') as Session;

    expect(session.messages).toEqual([]);
    expect(quarantineFiles('s1').length).toBe(1);
    expect(existsSync(join(sessionDir, 's1.json'))).toBe(false);
    store.dispose();
  });

  it('正常会话不受影响', () => {
    const now = new Date().toISOString();
    writeFileSync(
      join(sessionDir, 's1.json'),
      JSON.stringify({
        id: 's1',
        messages: [{ role: 'user', content: 'hello', timestamp: now }],
        createdAt: now,
        updatedAt: now,
        totalTokens: 0,
        contextFiles: [],
      }),
      'utf8',
    );

    const store = makeStore();
    const session = store.getOrCreate('s1') as Session;

    expect(session.messages.length).toBe(1);
    expect(session.messages[0].content).toBe('hello');
    expect(quarantineFiles('s1').length).toBe(0);
    expect(existsSync(join(sessionDir, 's1.json'))).toBe(true);
    store.dispose();
  });
});
