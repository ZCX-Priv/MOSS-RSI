// src/modules/file-history/tracker.test.ts
// 统一追踪协议单元测试：track/commit 六类 toolName 分发、收据字段、
// 降级开关（enabled / transcriptEnabled）、copy 正规登记（UUID entryId）、
// terminal 事后回填备份、变更失败不 commit。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, Environment } from '../../core/types';
import { FileHistoryServiceImpl } from './service';
import { readEntries } from './transcript';
import { DEFAULT_FILE_HISTORY_CONFIG, type FileHistoryConfig } from './types';

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

const SESSION = 's1';

let dataDir: string;
let env: Environment;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'moss-tracker-test-'));
  env = { dataDir } as Environment;
});

afterEach(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows 偶发句柄延迟释放，清理失败不影响断言
  }
});

function makeService(overrides: Partial<FileHistoryConfig> = {}): FileHistoryServiceImpl {
  return new FileHistoryServiceImpl(env, logger, { ...DEFAULT_FILE_HISTORY_CONFIG, ...overrides });
}

describe('track/commit 统一协议', () => {
  it('write 已存在文件：overwrite 收据 + 内容哈希备份 + commit 登记完整条目', async () => {
    const svc = makeService();
    const file = join(dataDir, 'f.txt');
    writeFileSync(file, 'v1', 'utf8');

    const tracker = await svc.track({ sessionId: SESSION, absPath: file, toolCallId: 'c1', toolName: 'write' });
    expect(tracker.receipt.backedUp).toBe(true);
    expect(tracker.receipt.operation).toBe('overwrite');
    expect(tracker.receipt.hash).toHaveLength(64);
    expect(tracker.receipt.backupPath).toContain('.bak');
    expect(existsSync(tracker.receipt.backupPath!)).toBe(true);

    writeFileSync(file, 'v2', 'utf8');
    tracker.commit({ hashAfter: 'after-hash', bytesAfter: 2, diff: 'd' });

    const entries = svc.listHistory(SESSION);
    expect(entries).toHaveLength(1);
    expect(entries[0].operation).toBe('overwrite');
    expect(entries[0].toolName).toBe('write');
    expect(entries[0].toolCallId).toBe('c1');
    expect(entries[0].hashBefore).toBe(tracker.receipt.hash);
    expect(entries[0].hashAfter).toBe('after-hash');
    expect(entries[0].bytesAfter).toBe(2);
    expect(entries[0].diff).toBe('d');
  });

  it('write 新文件：create 收据（无备份）+ commit 登记 create 条目', async () => {
    const svc = makeService();
    const file = join(dataDir, 'new.txt');

    const tracker = await svc.track({ sessionId: SESSION, absPath: file, toolName: 'write' });
    expect(tracker.receipt.backedUp).toBe(false);
    expect(tracker.receipt.backupPath).toBeNull();
    expect(tracker.receipt.operation).toBe('create');

    writeFileSync(file, 'v1', 'utf8');
    tracker.commit({ bytesAfter: 2 });

    const entries = svc.listHistory(SESSION);
    expect(entries).toHaveLength(1);
    expect(entries[0].operation).toBe('create');
  });

  it('目录：tar.gz 归档备份收据', async () => {
    const svc = makeService();
    const dir = join(dataDir, 'proj');
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.txt'), 'a', 'utf8');

    const tracker = await svc.track({ sessionId: SESSION, absPath: dir, toolName: 'delete' });
    expect(tracker.receipt.backedUp).toBe(true);
    expect(tracker.receipt.isDirectory).toBe(true);
    expect(tracker.receipt.backupPath).toMatch(/\.tar\.gz$/);
    expect(existsSync(tracker.receipt.backupPath!)).toBe(true);
    expect(tracker.receipt.operation).toBe('delete');
  });

  it('move：无备份收据 + commit 登记反向 rename 条目（destPath）', async () => {
    const svc = makeService();
    const src = join(dataDir, 'src.txt');
    const dest = join(dataDir, 'dest.txt');

    const tracker = await svc.track({
      sessionId: SESSION,
      absPath: src,
      toolName: 'move',
      toolCallId: 'c9',
      destPath: dest,
      bytesBefore: 10,
      isDirectory: false,
    });
    expect(tracker.receipt.operation).toBe('move');
    expect(tracker.receipt.backedUp).toBe(false);
    expect(tracker.receipt.entryId).toMatch(/^[0-9a-f-]{36}$/);

    tracker.commit();

    const entries = svc.listHistory(SESSION);
    expect(entries).toHaveLength(1);
    expect(entries[0].operation).toBe('move');
    expect(entries[0].toolName).toBe('move');
    expect(entries[0].destPath).toBe(dest);
    expect(entries[0].bytesBefore).toBe(10);
  });

  it('copy：create 收据 + commit 正规登记（entryId 为 UUID，非手工伪造时间戳）', async () => {
    const svc = makeService();
    const dest = join(dataDir, 'copy.txt');

    const tracker = await svc.track({
      sessionId: SESSION,
      absPath: dest,
      toolName: 'copy',
      toolCallId: 'c2',
      isDirectory: false,
    });
    expect(tracker.receipt.operation).toBe('create');
    expect(tracker.receipt.backedUp).toBe(false);

    tracker.commit({ bytesAfter: 42 });

    const entries = svc.listHistory(SESSION);
    expect(entries).toHaveLength(1);
    expect(entries[0].toolName).toBe('copy');
    expect(entries[0].operation).toBe('create');
    expect(entries[0].bytesAfter).toBe(42);
    // 旧实现手工伪造 `${Date.now()}-copy-xxx`；统一后应为正规 UUID
    expect(entries[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('terminal 事后回填：beforeBuffer 备份 + commit 登记 edit 条目（toolName=terminal）', async () => {
    const svc = makeService();
    const file = join(dataDir, 'sh.txt');

    const tracker = await svc.track({
      sessionId: SESSION,
      absPath: file,
      toolName: 'terminal',
      toolCallId: 'c3',
      terminalKind: 'modified',
      terminalBefore: Buffer.from('before-content', 'utf8'),
    });
    expect(tracker.receipt.backedUp).toBe(true);
    expect(tracker.receipt.backupPath).toContain('.bak');
    expect(existsSync(tracker.receipt.backupPath!)).toBe(true);

    tracker.commit();

    const entries = svc.listHistory(SESSION);
    expect(entries).toHaveLength(1);
    expect(entries[0].toolName).toBe('terminal');
    expect(entries[0].operation).toBe('edit');
    expect(entries[0].hashBefore).toBe(tracker.receipt.hash);
  });

  it('terminal created：无备份收据 + create 条目', async () => {
    const svc = makeService();
    const tracker = await svc.track({
      sessionId: SESSION,
      absPath: join(dataDir, 'x.txt'),
      toolName: 'terminal',
      terminalKind: 'created',
      terminalBefore: null,
    });
    expect(tracker.receipt.backedUp).toBe(false);
    tracker.commit();
    expect(svc.listHistory(SESSION)[0].operation).toBe('create');
  });

  it('enabled=false：no-op tracker（空收据，commit 无条目）', async () => {
    const svc = makeService({ enabled: false });
    const file = join(dataDir, 'f.txt');
    writeFileSync(file, 'v1', 'utf8');

    const tracker = await svc.track({ sessionId: SESSION, absPath: file, toolName: 'write' });
    expect(tracker.receipt.entryId).toBe('');
    expect(tracker.receipt.backedUp).toBe(false);

    tracker.commit({ bytesAfter: 1 });
    expect(svc.listHistory(SESSION)).toHaveLength(0);
    // 备份目录不产生任何文件
    const backupDir = join(dataDir, 'file-history', 'backups');
    expect(existsSync(backupDir)).toBe(false);
  });

  it('transcriptEnabled=false：备份照做、commit 不写条目', async () => {
    const svc = makeService({ transcriptEnabled: false });
    const file = join(dataDir, 'f.txt');
    writeFileSync(file, 'v1', 'utf8');

    const tracker = await svc.track({ sessionId: SESSION, absPath: file, toolName: 'write' });
    expect(tracker.receipt.backedUp).toBe(true);
    expect(existsSync(tracker.receipt.backupPath!)).toBe(true);

    tracker.commit({ bytesAfter: 1 });
    expect(svc.listHistory(SESSION)).toHaveLength(0);
  });

  it('变更失败不 commit：无条目（孤儿备份由 retention 回收，无害）', async () => {
    const svc = makeService();
    const file = join(dataDir, 'f.txt');
    writeFileSync(file, 'v1', 'utf8');

    const tracker = await svc.track({ sessionId: SESSION, absPath: file, toolName: 'write' });
    // 模拟变更失败：不调用 commit
    expect(svc.listHistory(SESSION)).toHaveLength(0);
    expect(readdirSync(join(dataDir, 'file-history', 'backups')).length).toBe(1); // 备份已落盘（孤儿）
  });

  it('同一文件同内容重复 track：内容寻址去重（backedUp 第二次为 false）', async () => {
    const svc = makeService();
    const file = join(dataDir, 'f.txt');
    writeFileSync(file, 'same', 'utf8');

    const t1 = await svc.track({ sessionId: SESSION, absPath: file, toolName: 'write' });
    expect(t1.receipt.backedUp).toBe(true);
    const t2 = await svc.track({ sessionId: SESSION, absPath: file, toolName: 'write' });
    expect(t2.receipt.backedUp).toBe(false); // 同内容已备份
    expect(t2.receipt.backupPath).toBe(t1.receipt.backupPath);
    expect(t2.receipt.hash).toBe(t1.receipt.hash);
  });
});
