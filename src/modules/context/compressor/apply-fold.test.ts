// src/modules/context/compressor/apply-fold.test.ts
// 折叠落地：归档 → 摘要消息 → 物理删除 → 记录层级 → 蒸馏水位重算。

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from '../../../core/types';
import type { ContextMessage, ContextSessionLike } from '../types';
import { applyFold } from './index';
import { closeContextDb, readCompaction } from '../store/context-store';
import { COMPACTION_SUMMARY_MSG_NAME } from '../compiler/view-builder';

const root = mkdtempSync(join(tmpdir(), 'moss-apply-fold-'));
const env = { dataDir: root, configDir: join(root, 'config'), logsDir: join(root, 'logs') } as unknown as Environment;

function mkSession(messages: ContextMessage[]): ContextSessionLike {
  return {
    id: 's-fold',
    messages,
    memoryState: { excludeFromRecall: [], currentRecalled: [], lastDistilledIndex: 3 },
    updatedAt: new Date().toISOString(),
  };
}

describe('applyFold', () => {
  afterAll(() => {
    closeContextDb(env);
    rmSync(root, { recursive: true, force: true });
  });

  test('归档原文、插入摘要、物理删除、记录层级与 refs', () => {
    const envMsg: ContextMessage = { role: 'user', name: 'env-context', content: '[环境]', ref: 'm00001' };
    const u1: ContextMessage = { role: 'user', content: '第一个问题', ref: 'm00002' };
    const a1: ContextMessage = { role: 'assistant', content: '第一个回答', ref: 'm00003' };
    const latest: ContextMessage = { role: 'user', content: '最新请求', ref: 'm00004' };
    const session = mkSession([envMsg, u1, a1, latest]);

    const record = applyFold({
      env,
      session,
      region: [u1, a1],
      summary: '用户问了第一个问题，助手回答了。',
      summaryModel: 'model',
      trigger: 'model',
    });

    expect(record.tier).toBe(1);
    expect(record.refs).toEqual(['m00002', 'm00003']);
    expect(record.blockId).toBeTruthy();
    expect(session.messages).toHaveLength(3);
    expect(session.messages[0]).toBe(envMsg);
    expect(session.messages[1].name).toBe(COMPACTION_SUMMARY_MSG_NAME);
    expect(session.messages[1].content).toContain('第一个问题');
    expect(session.messages[2]).toBe(latest);
    // 水位 3（env/u1/a1 已蒸馏；latest 未蒸馏）→ 折叠后 latest 在新数组下标 2
    expect(session.memoryState?.lastDistilledIndex).toBe(2);

    const archived = readCompaction(env, 's-fold', record.blockId!);
    expect(archived.meta?.tier).toBe(1);
    expect(archived.messages.map(m => m.content)).toEqual(['第一个问题', '第一个回答']);
  });

  test('压缩旧摘要时层级提升（T1→T2）', () => {
    const envMsg: ContextMessage = { role: 'user', name: 'env-context', content: '[环境]', ref: 'm00011' };
    const summary: ContextMessage = {
      role: 'user',
      name: COMPACTION_SUMMARY_MSG_NAME,
      content: '<compaction-summary>旧摘要</compaction-summary>',
      ref: 'm00012',
      metadata: { tier: 1 },
    };
    const tail: ContextMessage = { role: 'user', content: '最新请求', ref: 'm00013' };
    const session = mkSession([envMsg, summary, tail]);

    const record = applyFold({
      env,
      session,
      region: [summary],
      summary: '蒸馏后的摘要',
      summaryModel: 'model',
      trigger: 'model',
    });
    expect(record.tier).toBe(2);
    expect(session.messages.find(m => m.name === COMPACTION_SUMMARY_MSG_NAME)?.metadata?.tier).toBe(2);
  });
});
