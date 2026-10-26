// src/modules/filesys/watcher.test.ts
// 实时文件监控测试：修改/删除生成记录与 diff、内部写入抑制、忽略规则。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, ServiceRegistry } from '../../core/types';
import { FileWatchService, shouldIgnoreWatchPath } from './watcher';

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

interface WatchCall {
  sessionId: string;
  absPath: string;
  operation: 'create' | 'edit' | 'delete';
  before: Buffer | null;
  after: Buffer | null;
  diff?: string;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'moss-watch-test-'));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows 句柄延迟释放，忽略
  }
});

function makeService(options?: { internalPaths?: Set<string> }): {
  service: FileWatchService;
  calls: WatchCall[];
} {
  const calls: WatchCall[] = [];
  const history = {
    recordWatchChange: (req: WatchCall) => {
      calls.push(req);
    },
    listTrackedPaths: () => [],
  };
  const services = {
    tryResolve: () => history,
  } as unknown as ServiceRegistry;
  const service = new FileWatchService({
    logger,
    services,
    emitChange: () => {},
    isRecentlyInternalWritten: (absPath) => options?.internalPaths?.has(absPath) ?? false,
  });
  return { service, calls };
}

describe('FileWatchService 实时变更捕获', () => {
  it('修改文件：记录 edit 条目并生成 before → after 的 diff', async () => {
    const file = join(root, 'a.txt');
    writeFileSync(file, 'old\n', 'utf8');

    const { service, calls } = makeService();
    await service.watch(root, 's1');
    writeFileSync(file, 'new\n', 'utf8');
    service.processPathNow(root, file);
    service.stopAll();

    expect(calls).toHaveLength(1);
    expect(calls[0].operation).toBe('edit');
    expect(calls[0].before?.toString('utf8')).toBe('old\n');
    expect(calls[0].after?.toString('utf8')).toBe('new\n');
    expect(calls[0].diff).toContain('-old');
    expect(calls[0].diff).toContain('+new');
  });

  it('新建文件：记录 create 条目并生成全量新增 diff', async () => {
    const { service, calls } = makeService();
    await service.watch(root, 's1');

    const file = join(root, 'new.txt');
    writeFileSync(file, 'hello\n', 'utf8');
    service.processPathNow(root, file);
    service.stopAll();

    expect(calls).toHaveLength(1);
    expect(calls[0].operation).toBe('create');
    expect(calls[0].before).toBeNull();
    expect(calls[0].diff).toContain('+hello');
  });

  it('删除文件：记录 delete 条目并生成全量删除 diff', async () => {
    const file = join(root, 'gone.txt');
    writeFileSync(file, 'bye\n', 'utf8');

    const { service, calls } = makeService();
    await service.watch(root, 's1');
    rmSync(file);
    service.processPathNow(root, file);
    service.stopAll();

    expect(calls).toHaveLength(1);
    expect(calls[0].operation).toBe('delete');
    expect(calls[0].before?.toString('utf8')).toBe('bye\n');
    expect(calls[0].diff).toContain('-bye');
  });

  it('工具自身写入：抑制窗口命中时不记录，但基线已更新', async () => {
    const file = join(root, 'tool.txt');
    writeFileSync(file, 'v1\n', 'utf8');
    const { service, calls } = makeService({ internalPaths: new Set([file]) });
    await service.watch(root, 's1');

    writeFileSync(file, 'v2\n', 'utf8');
    service.processPathNow(root, file);
    service.stopAll();

    expect(calls).toHaveLength(0);
  });

  it('忽略规则：产物目录忽略，项目内 .moss 与 .log 不忽略', () => {
    expect(shouldIgnoreWatchPath('node_modules/pkg/index.js')).toBe(true);
    expect(shouldIgnoreWatchPath('.git/config')).toBe(true);
    expect(shouldIgnoreWatchPath('dist/app.js')).toBe(true);
    expect(shouldIgnoreWatchPath('.moss/documents/calc/gen.js')).toBe(false);
    expect(shouldIgnoreWatchPath('logs/build.log')).toBe(false);
    expect(shouldIgnoreWatchPath('a.tmp')).toBe(true);
  });

  it('基线扫描不会把已有文件误报为新增', async () => {
    mkdirSync(join(root, 'sub'), { recursive: true });
    const file = join(root, 'sub', 'existing.txt');
    writeFileSync(file, 'existing\n', 'utf8');

    const { service, calls } = makeService();
    await service.watch(root, 's1');
    service.processPathNow(root, file);
    service.stopAll();

    expect(calls).toHaveLength(0);
  });
});
