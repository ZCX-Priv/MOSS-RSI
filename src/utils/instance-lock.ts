// src/utils/instance-lock.ts
// 数据目录级单实例锁：同一 dataDir 同时只允许一个内核实例运行。
//
// 为什么不用 PID 文件做单例判定：
//   - cmdStart 的 PID 检查与 kernel.start 后写 PID 之间存在数秒窗口（TOCTOU）；
//   - Windows 上 tasklist 查询可能返回空，被误判为「僵尸」后放行第二个实例；
//   - 多个实例共享同一 dataDir 时，各自的 SessionStore 会互相覆盖会话文件。
// 因此这里用 O_EXCL 原子创建锁文件，作为唯一的单例依据；PID 文件继续供 status/stop 使用。

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { inspectPid, type PidInfo, type PidInspection } from './pid';

/** 锁文件内容（向前兼容：version 不为 1 时按未知格式处理） */
export interface InstanceLockInfo extends PidInfo {
  version: 1;
}

export class InstanceLockError extends Error {
  constructor(
    message: string,
    public readonly owner?: InstanceLockInfo,
  ) {
    super(message);
    this.name = 'InstanceLockError';
  }
}

export interface InstanceLockHandle {
  readonly path: string;
  /** 内核监听端口就绪后回写，供第二个实例做健康探测 */
  updatePort(port: number): void;
  /** 仅当锁内容仍属于本进程时删除，避免误删接管者的锁 */
  release(): void;
}

export interface AcquireInstanceLockOptions {
  lockPath: string;
  /** 等待旧实例退出的最长时间（dev --watch 重启需要给旧进程收尾窗口） */
  waitMs?: number;
  /** 健康探测超时（默认 800ms，与 port-guard 对齐） */
  probeTimeoutMs?: number;
  /** 测试注入：默认使用真实 inspectPid */
  inspect?: (info: InstanceLockInfo) => PidInspection;
  /** 测试注入：默认使用真实 /api/health 探测 */
  probeHealth?: (port: number, timeoutMs: number) => Promise<boolean>;
}

const RETRY_INTERVAL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * PID 是否被占用（不依赖 tasklist）。
 * Windows 上 tasklist 可能因权限/语言环境返回空，但 process.kill(pid, 0) 仍能区分
 * 「进程不存在（ESRCH）」与「存在但无权限（EPERM）」。
 */
function isPidOccupied(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读取锁文件；不存在/损坏返回 null（损坏按僵尸处理） */
function readLockInfo(lockPath: string): InstanceLockInfo | null {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<InstanceLockInfo>;
    if (parsed && typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return {
        version: 1,
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : new Date(0).toISOString(),
        ...(typeof parsed.imageName === 'string' ? { imageName: parsed.imageName } : {}),
        ...(typeof parsed.execPath === 'string' ? { execPath: parsed.execPath } : {}),
        ...(typeof parsed.port === 'number' ? { port: parsed.port } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 该端口是否是活的 MOSS（与 port-guard 同一判据） */
async function probeMossHealth(port: number, timeoutMs: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { services?: unknown };
    return Array.isArray(data.services) && data.services.includes('server.instance');
  } catch {
    return false;
  }
}

/** 原子创建锁；EEXIST 返回 false */
function tryCreate(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      const info: InstanceLockInfo = {
        version: 1,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        imageName: process.execPath.split(/[\\/]/).pop() || undefined,
        execPath: process.execPath,
      };
      writeSync(fd, JSON.stringify(info, null, 2), null, 'utf8');
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** 把僵尸锁改名归档（不用 unlink：避免与另一个接管者竞态） */
function quarantineLock(lockPath: string): void {
  try {
    if (existsSync(lockPath)) renameSync(lockPath, `${lockPath}.stale-${Date.now()}`);
  } catch {
    // 另一个进程已删除/改名：忽略，直接重试原子创建
  }
}

/**
 * 获取数据目录单实例锁。
 * @throws InstanceLockError 已有活着的 MOSS 实例占用该 dataDir
 */
export async function acquireInstanceLock(opts: AcquireInstanceLockOptions): Promise<InstanceLockHandle> {
  const { lockPath, waitMs = 0, probeTimeoutMs = 800 } = opts;
  const inspect = opts.inspect ?? inspectPid;
  const probeHealth = opts.probeHealth ?? probeMossHealth;
  mkdirSync(dirname(lockPath), { recursive: true });

  const deadline = Date.now() + Math.max(0, waitMs);

  for (;;) {
    if (tryCreate(lockPath)) {
      return {
        path: lockPath,
        updatePort(port: number): void {
          try {
            const current = readLockInfo(lockPath);
            if (!current || current.pid !== process.pid) return;
            writeFileSync(lockPath, JSON.stringify({ ...current, port }, null, 2), 'utf8');
          } catch {
            // 端口回写失败不影响运行（只影响第二个实例的探测精度）
          }
        },
        release(): void {
          try {
            const current = readLockInfo(lockPath);
            // 只删自己的锁；若已被接管则绝不动别人的文件
            if (current && current.pid === process.pid) unlinkSync(lockPath);
          } catch {
            // 已删除/权限不足：静默
          }
        },
      };
    }

    const owner = readLockInfo(lockPath);

    // 锁内容损坏 / PID 不存在 / 跨重启 → 僵尸，接管
    if (!owner) {
      quarantineLock(lockPath);
      continue;
    }

    const inspection = inspect(owner);
    if (inspection.isMoss) {
      // 活着的实例：等待窗口内重试，否则明确拒绝
      if (Date.now() < deadline) {
        await sleep(RETRY_INTERVAL_MS);
        continue;
      }
      throw new InstanceLockError(
        `another MOSS instance is running (pid ${owner.pid}${owner.port ? `, port ${owner.port}` : ''})`,
        owner,
      );
    }

    // PID 存在但查不到映像名（Windows tasklist 在权限/语言环境下可能返回空）：
    // 用锁里的端口做一次健康探测，避免把真实例误判为僵尸。
    if (inspection.reason === 'not-running' && isPidOccupied(owner.pid) && owner.port) {
      if (await probeHealth(owner.port, probeTimeoutMs)) {
        if (Date.now() < deadline) {
          await sleep(RETRY_INTERVAL_MS);
          continue;
        }
        throw new InstanceLockError(
          `another MOSS instance is healthy on port ${owner.port} (pid ${owner.pid})`,
          owner,
        );
      }
    }

    // 其余情况（not-running / image-mismatch / stale-across-boot / 探测失败）→ 接管
    quarantineLock(lockPath);
  }
}
