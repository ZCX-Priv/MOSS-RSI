// src/utils/instance-lock.test.ts
// 单实例锁：原子性、僵尸接管、归属校验、等待窗口。

import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  acquireInstanceLock,
  InstanceLockError,
  type InstanceLockInfo,
} from './instance-lock';
import type { PidInspection } from './pid';

const dirs: string[] = [];

function tempLockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'moss-lock-'));
  dirs.push(dir);
  return join(dir, 'moss.lock');
}

function lockInfo(lockPath: string): InstanceLockInfo {
  return JSON.parse(readFileSync(lockPath, 'utf8')) as InstanceLockInfo;
}

function staleLockFiles(lockPath: string): string[] {
  return readdirSync(dirname(lockPath)).filter(name => name.includes('.stale-'));
}

const asAlive = (info: InstanceLockInfo): PidInspection => ({
  pid: info.pid,
  alive: true,
  isMoss: true,
  imageName: 'bun.exe',
  reason: 'ok',
});

const asNotRunning = (info: InstanceLockInfo): PidInspection => ({
  pid: info.pid,
  alive: false,
  isMoss: false,
  imageName: null,
  reason: 'not-running',
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('acquireInstanceLock', () => {
  it('同一 dataDir 只允许一个实例', async () => {
    const lockPath = tempLockPath();
    const first = await acquireInstanceLock({ lockPath, inspect: asAlive });
    expect(lockInfo(lockPath).pid).toBe(process.pid);

    await expect(acquireInstanceLock({ lockPath, inspect: asAlive })).rejects.toBeInstanceOf(
      InstanceLockError,
    );

    first.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('僵尸锁被归档后接管', async () => {
    const lockPath = tempLockPath();
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        pid: 999999,
        startedAt: new Date().toISOString(),
        port: 19999,
      }),
      'utf8',
    );

    const lock = await acquireInstanceLock({
      lockPath,
      inspect: asNotRunning,
      probeHealth: async () => false,
    });
    expect(lockInfo(lockPath).pid).toBe(process.pid);
    expect(staleLockFiles(lockPath).length).toBe(1);

    lock.release();
  });

  it('损坏的锁内容按僵尸处理', async () => {
    const lockPath = tempLockPath();
    writeFileSync(lockPath, '{ not valid json', 'utf8');

    const lock = await acquireInstanceLock({ lockPath, inspect: asAlive });
    expect(lockInfo(lockPath).pid).toBe(process.pid);
    expect(staleLockFiles(lockPath).length).toBe(1);

    lock.release();
  });

  it('release 只删除属于自己的锁', async () => {
    const lockPath = tempLockPath();
    const lock = await acquireInstanceLock({ lockPath, inspect: asAlive });

    // 模拟锁被另一个实例接管
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        pid: process.pid + 1,
        startedAt: new Date().toISOString(),
      }),
      'utf8',
    );

    lock.release();
    expect(existsSync(lockPath)).toBe(true);
  });

  it('waitMs 等待旧实例释放后成功获取', async () => {
    const lockPath = tempLockPath();
    const first = await acquireInstanceLock({ lockPath, inspect: asAlive });
    setTimeout(() => first.release(), 150);

    const second = await acquireInstanceLock({ lockPath, inspect: asAlive, waitMs: 2000 });
    expect(lockInfo(lockPath).pid).toBe(process.pid);
    second.release();
  });

  it('updatePort 回写端口供第二个实例探测', async () => {
    const lockPath = tempLockPath();
    const lock = await acquireInstanceLock({ lockPath, inspect: asAlive });
    lock.updatePort(17766);
    expect(lockInfo(lockPath).port).toBe(17766);
    lock.release();
  });
});
