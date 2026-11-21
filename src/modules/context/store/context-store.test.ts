// src/modules/context/store/context-store.test.ts
// 上下文归档：折叠原文写入 SQLite 后可检索、可按 ref/块取回。

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from '../../../core/types';
import type { ContextMessage } from '../types';
import {
  archiveCompaction,
  closeContextDb,
  findArchivedByRef,
  getExternalized,
  listCompactions,
  readCompaction,
  recordExternalized,
  searchArchive,
} from './context-store';

const root = mkdtempSync(join(tmpdir(), 'moss-context-store-'));
const env = {
  dataDir: root,
  configDir: join(root, 'config'),
  logsDir: join(root, 'logs'),
} as unknown as Environment;

const messages: ContextMessage[] = [
  { role: 'user', content: '请修复登录超时问题，错误是 ETIMEDOUT', ref: 'm00001' },
  {
    role: 'assistant',
    content: '定位到 src/auth/login.ts:42 的 fetch 没有超时',
    ref: 'm00002',
    toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"src/auth/login.ts"}' }],
  },
  { role: 'tool', content: 'export async function login() { ... }', toolCallId: 'c1', ref: 'm00003' },
];

describe('context-store', () => {
  afterAll(() => {
    closeContextDb(env);
    rmSync(root, { recursive: true, force: true });
  });

  test('归档后可列出、按块读取、按 ref 读取', () => {
    archiveCompaction(env, {
      id: 'block-1',
      sessionId: 's1',
      tier: 1,
      refs: ['m00001', 'm00002', 'm00003'],
      summary: '修复登录超时：定位到 login.ts:42，未完成验证。',
      beforeTokens: 1000,
      afterTokens: 100,
      trigger: 'auto',
      messages,
    });

    const list = listCompactions(env, 's1');
    expect(list).toHaveLength(1);
    expect(list[0].tier).toBe(1);
    expect(list[0].refs).toEqual(['m00001', 'm00002', 'm00003']);

    const read = readCompaction(env, 's1', 'block-1');
    expect(read.meta?.id).toBe('block-1');
    expect(read.messages).toHaveLength(3);
    expect(read.messages[1].toolCalls?.[0].name).toBe('read');

    const byRef = findArchivedByRef(env, ['s1'], 'm00003');
    expect(byRef?.message.content).toContain('export async function login');
  });

  test('关键词检索命中归档；工具消息可按开关过滤', () => {
    const hits = searchArchive(env, ['s1'], 'ETIMEDOUT', 10, false);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].ref).toBe('m00001');

    const toolHits = searchArchive(env, ['s1'], 'export async function', 10, true);
    expect(toolHits.some(h => h.role === 'tool')).toBe(true);
    const noToolHits = searchArchive(env, ['s1'], 'export async function', 10, false);
    expect(noToolHits.some(h => h.role === 'tool')).toBe(false);
  });

  test('外置记录可写可读', () => {
    recordExternalized(env, {
      ref: 'm00099',
      sessionId: 's1',
      path: join(root, 'm00099.txt'),
      tokens: 12000,
      createdAt: new Date().toISOString(),
    });
    const rec = getExternalized(env, 's1', 'm00099');
    expect(rec?.tokens).toBe(12000);
  });
});
