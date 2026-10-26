// src/modules/file-history/net-changes.test.ts
// 净差异聚合测试：create/edit/delete 组合、备份缺失、二进制、create+delete 抵消。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, Environment } from '../../core/types';
import { FileHistoryServiceImpl } from './service';
import { appendEntry } from './transcript';
import { DEFAULT_FILE_HISTORY_CONFIG } from './types';
import { computeAddedFileDiff, computeLineDiff } from './diff';

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
let env: Environment;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'moss-net-test-'));
  env = { dataDir } as Environment;
});

afterEach(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows 句柄延迟释放，忽略
  }
});

function makeService(): FileHistoryServiceImpl {
  return new FileHistoryServiceImpl(env, logger, { ...DEFAULT_FILE_HISTORY_CONFIG });
}

function transcriptPath(sessionId: string): string {
  return join(dataDir, 'file-history', 'transcripts', `${sessionId}.jsonl`);
}

describe('listNetChanges 净差异聚合', () => {
  it('create → 多次 edit：净差异为「空 → 最终内容」的全量新增', () => {
    const session = 'net-create';
    const svc = makeService();
    const file = join(dataDir, 'a.txt');

    writeFileSync(file, 'a\n', 'utf8');
    svc.recordWatchChange({
      sessionId: session, absPath: file, operation: 'create',
      before: null, after: Buffer.from('a\n'), diff: computeAddedFileDiff('a\n'),
    });

    writeFileSync(file, 'a\nb\n', 'utf8');
    svc.recordWatchChange({
      sessionId: session, absPath: file, operation: 'edit',
      before: Buffer.from('a\n'), after: Buffer.from('a\nb\n'),
      diff: computeLineDiff('a\n', 'a\nb\n'),
    });

    writeFileSync(file, 'a\nb\nc\n', 'utf8');
    svc.recordWatchChange({
      sessionId: session, absPath: file, operation: 'edit',
      before: Buffer.from('a\nb\n'), after: Buffer.from('a\nb\nc\n'),
      diff: computeLineDiff('a\nb\n', 'a\nb\nc\n'),
    });

    const changes = svc.listNetChanges(session);
    expect(changes).toHaveLength(1);
    expect(changes[0].operation).toBe('create');
    expect(changes[0].entryCount).toBe(3);
    expect(changes[0].added).toBe(3);
    expect(changes[0].removed).toBe(0);
    expect(changes[0].diff).toContain('+a');
    expect(changes[0].diff).toContain('+c');
  });

  it('edit → edit：净差异为「最初备份 → 当前内容」', () => {
    const session = 'net-edit';
    const svc = makeService();
    const file = join(dataDir, 'b.txt');

    writeFileSync(file, 'v2\n', 'utf8');
    svc.recordWatchChange({
      sessionId: session, absPath: file, operation: 'edit',
      before: Buffer.from('v1\n'), after: Buffer.from('v2\n'),
      diff: computeLineDiff('v1\n', 'v2\n'),
    });

    writeFileSync(file, 'v3\n', 'utf8');
    svc.recordWatchChange({
      sessionId: session, absPath: file, operation: 'edit',
      before: Buffer.from('v2\n'), after: Buffer.from('v3\n'),
      diff: computeLineDiff('v2\n', 'v3\n'),
    });

    const changes = svc.listNetChanges(session);
    expect(changes).toHaveLength(1);
    expect(changes[0].operation).toBe('edit');
    expect(changes[0].diff).toContain('-v1');
    expect(changes[0].diff).toContain('+v3');
  });

  it('create → delete：净结果抵消，不返回该文件', () => {
    const session = 'net-cancel';
    const svc = makeService();
    const file = join(dataDir, 'temp.txt');

    writeFileSync(file, 'x\n', 'utf8');
    svc.recordWatchChange({
      sessionId: session, absPath: file, operation: 'create',
      before: null, after: Buffer.from('x\n'), diff: computeAddedFileDiff('x\n'),
    });
    rmSync(file);
    svc.recordWatchChange({
      sessionId: session, absPath: file, operation: 'delete',
      before: Buffer.from('x\n'), after: null, diff: undefined,
    });

    expect(svc.listNetChanges(session)).toEqual([]);
  });

  it('备份缺失：返回 before-unavailable 原因', () => {
    const session = 'net-nobackup';
    const svc = makeService();
    const file = join(dataDir, 'c.txt');
    writeFileSync(file, 'current\n', 'utf8');

    appendEntry(transcriptPath(session), {
      id: 'e1',
      sessionId: session,
      absPath: file,
      toolCallId: '',
      toolName: 'watch',
      timestamp: new Date().toISOString(),
      operation: 'overwrite',
      hashBefore: null,
      hashAfter: null,
      backupPath: null,
      bytesBefore: 0,
      bytesAfter: 8,
    });

    const changes = svc.listNetChanges(session);
    expect(changes).toHaveLength(1);
    expect(changes[0].reason).toBe('before-unavailable');
  });

  it('二进制文件：返回 binary 原因，不生成 diff', () => {
    const session = 'net-binary';
    const svc = makeService();
    const file = join(dataDir, 'bin.dat');
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    writeFileSync(file, binary);

    svc.recordWatchChange({
      sessionId: session, absPath: file, operation: 'create',
      before: null, after: binary, diff: undefined,
    });

    const changes = svc.listNetChanges(session);
    expect(changes).toHaveLength(1);
    expect(changes[0].reason).toBe('binary');
    expect(changes[0].diff).toBeUndefined();
  });
});
