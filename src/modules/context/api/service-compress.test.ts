// src/modules/context/api/service-compress.test.ts
// 模型主导压缩：按 ref 校验区间、全有或全无、归档后可解压。

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Environment, Logger } from '../../../core/types';
import type { ContextMessage, ContextSessionLike } from '../types';
import type { ConfigService } from '../../../core/types';
import { ContextEngineServiceImpl } from './service';
import { closeContextDb } from '../store/context-store';

const root = mkdtempSync(join(tmpdir(), 'moss-service-compress-'));
const env = { dataDir: root, configDir: join(root, 'config'), logsDir: join(root, 'logs') } as unknown as Environment;

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => logger,
  setLevel: () => {},
  getLevel: () => 'debug',
};

const config = {
  getAppConfig: () => ({}),
  getApiConfig: () => ({ providers: [] }),
} as unknown as ConfigService;

const services = { tryResolve: () => null } as unknown as ConstructorParameters<typeof ContextEngineServiceImpl>[0]['services'];

function mkService(session: ContextSessionLike): ContextEngineServiceImpl {
  const service = new ContextEngineServiceImpl({ env, config, services, logger });
  const map = new Map([[session.id, session]]);
  service.bindSessionStore({
    get: id => map.get(id) ?? null,
    persist: () => {},
  });
  return service;
}

function mkSession(): ContextSessionLike {
  const long = '甲'.repeat(6000);
  const messages: ContextMessage[] = [
    { role: 'user', name: 'env-context', content: '[环境]', ref: 'm00001' },
    { role: 'user', content: `第一个问题 ${long}`, ref: 'm00002' },
    { role: 'assistant', content: `第一个回答 ${long}`, ref: 'm00003' },
    { role: 'user', content: '最新请求：继续', ref: 'm00004' },
  ];
  return { id: 's-compress', messages, updatedAt: new Date().toISOString() };
}

describe('ContextEngineServiceImpl.compressRanges', () => {
  afterAll(() => {
    closeContextDb(env);
    rmSync(root, { recursive: true, force: true });
  });

  test('合法区间：折叠、归档、层级记录', async () => {
    const session = mkSession();
    const service = mkService(session);
    const result = await service.compressRanges(session.id, [
      {
        startRef: 'm00002',
        endRef: 'm00003',
        summary:
          '第一个问题与回答的摘要：保留完整路径、关键结论、错误原文与未完成目标，' +
          '并记录用户最新确认的约束和下一步行动，供后续继续执行任务时直接使用。',
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.foldedRanges).toBe(1);
    expect(session.messages).toHaveLength(3);
    const record = session.compactions?.[0];
    expect(record?.trigger).toBe('model');
    expect(record?.refs).toEqual(['m00002', 'm00003']);
    const decompressed = service.decompressCompaction(session.id, record!.blockId!);
    expect(decompressed.ok).toBe(true);
    expect(decompressed.messages).toHaveLength(2);
  });

  test('包含最新用户请求：整批拒绝，不折叠任何区间', async () => {
    const session = mkSession();
    const service = mkService(session);
    const result = await service.compressRanges(session.id, [
      { startRef: 'm00002', endRef: 'm00004', summary: '试图折叠最新请求的摘要。' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors?.join('\n')).toContain('最新');
    expect(session.messages).toHaveLength(4);
  });

  test('摘要过短：整批拒绝', async () => {
    const session = mkSession();
    const service = mkService(session);
    const result = await service.compressRanges(session.id, [
      { startRef: 'm00002', endRef: 'm00003', summary: '短' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors?.join('\n')).toContain('摘要过短');
    expect(session.messages).toHaveLength(4);
  });
});
