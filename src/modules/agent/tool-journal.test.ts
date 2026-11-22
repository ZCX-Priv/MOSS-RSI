// src/modules/agent/tool-journal.test.ts
// 工具结果恢复日志：同步追加、坏行容错、崩溃恢复优先级、摘要场景保留原文。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, Environment } from '../../core/types';
import { SessionStore, type Session } from './session';
import {
  appendToolResultJournal,
  readToolResultJournal,
  toolJournalPath,
} from './tool-result-journal';

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
  dataDir = mkdtempSync(join(tmpdir(), 'moss-journal-test-'));
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

function sessionPath(id: string): string {
  return join(sessionDir, `${id}.json`);
}

/** 写一个「assistant 带 3 个 toolCalls、但没有任何 tool 结果」的会话文件（模拟崩溃现场） */
function writeBrokenSession(id: string): void {
  const now = new Date().toISOString();
  writeFileSync(
    sessionPath(id),
    JSON.stringify({
      id,
      messages: [
        { role: 'user', content: 'do work', timestamp: now },
        {
          role: 'assistant',
          content: '',
          timestamp: now,
          toolCalls: [
            { id: 't1', name: 'read', arguments: '{}' },
            { id: 't2', name: 'read', arguments: '{}' },
            { id: 't3', name: 'read', arguments: '{}' },
          ],
        },
      ],
      createdAt: now,
      updatedAt: now,
      totalTokens: 0,
      contextFiles: [],
    }),
    'utf8',
  );
}

function journalFor(id: string) {
  return readFileSync(toolJournalPath(sessionPath(id)), 'utf8');
}

describe('tool-result-journal', () => {
  it('append → read：同 toolCallId 后写覆盖，坏行跳过', () => {
    const file = join(sessionDir, 'j.tools.ndjson');
    appendToolResultJournal(file, {
      v: 1,
      toolCallId: 'a',
      content: 'first',
      ts: new Date().toISOString(),
    });
    appendToolResultJournal(file, {
      v: 1,
      toolCallId: 'a',
      content: 'second',
      ts: new Date().toISOString(),
    });
    writeFileSync(file, `${readFileSync(file, 'utf8')}{broken\n`, 'utf8');

    const { records, badLines } = readToolResultJournal(file);
    expect(records.get('a')?.content).toBe('second');
    expect(badLines).toBe(1);
  });

  it('addToolMessage 同步写 journal；摘要场景保留原文', () => {
    const store = makeStore();
    const session = store.getOrCreate('s1');
    session.messages.push({
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      toolCalls: [{ id: 't1', name: 'run_code', arguments: '{}' }],
    });

    store.addToolMessage(session, 't1', '[工具结果摘要] brief', 'run_code', {
      originalContent: 'FULL ORIGINAL RESULT',
    });

    const { records } = readToolResultJournal(toolJournalPath(sessionPath('s1')));
    expect(records.get('t1')?.content).toBe('FULL ORIGINAL RESULT');
    store.dispose();
  });

  it('加载会话时优先用 journal 恢复真实结果，剩余缺失才写 heal 占位', () => {
    writeBrokenSession('s1');
    const journalFile = toolJournalPath(sessionPath('s1'));
    appendToolResultJournal(journalFile, {
      v: 1,
      toolCallId: 't1',
      name: 'read',
      content: 'REAL RESULT 1',
      ts: new Date().toISOString(),
    });
    appendToolResultJournal(journalFile, {
      v: 1,
      toolCallId: 't2',
      name: 'read',
      content: 'REAL RESULT 2',
      isError: false,
      ts: new Date().toISOString(),
    });

    const store = makeStore();
    const session = store.get('s1') as Session;
    const toolMessages = session.messages.filter(m => m.role === 'tool');

    const t1 = toolMessages.find(m => m.toolCallId === 't1');
    const t2 = toolMessages.find(m => m.toolCallId === 't2');
    const t3 = toolMessages.find(m => m.toolCallId === 't3');

    expect(t1?.content).toBe('REAL RESULT 1');
    expect(t1?.metadata?.recoveredFromJournal).toBe(true);
    expect(t2?.content).toBe('REAL RESULT 2');
    expect(t3?.isError).toBe(true);
    expect(t3?.metadata?.healed).toBe(true);
    // 三条结果都紧跟 assistant（顺序 t1,t2,t3）
    expect(toolMessages.map(m => m.toolCallId)).toEqual(['t1', 't2', 't3']);
    store.dispose();
  });

  it('persistSession 成功后清空 journal', () => {
    const store = makeStore();
    const session = store.getOrCreate('s1');
    session.messages.push({
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      toolCalls: [{ id: 't1', name: 'read', arguments: '{}' }],
    });
    store.addToolMessage(session, 't1', 'result', 'read');
    expect(journalFor('s1')).toContain('t1');

    store.persistSession(session);
    expect(journalFor('s1')).toBe('');
    store.dispose();
  });
});
