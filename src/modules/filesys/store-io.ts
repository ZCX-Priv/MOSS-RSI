// src/modules/filesys/store-io.ts
// 内部存储统一读写：session / task / config / todo / ledger 等模块自有 JSON 持久化的
// 唯一入口（修复旧版三种写入策略并存：atomicWriteFile / 手写 tmp+rename / 裸 writeFileSync）。
// 纯函数模块（无服务状态），依赖 utils 层原子写。

import { readFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFile } from '../../utils/fs-atomic';
import { markInternalWrite } from '../../utils/internal-writes';
import type { Logger } from '../../core/types';

/**
 * sessionId 路径清洗：剔除字母数字-_ 以外字符（防 `../` 路径穿越）。
 * 旧版 transcript/todo 已各自清洗，session store 未清洗（安全隐患），统一到此后三处共用。
 */
export function safeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * 读取 JSON 存储：
 * - 文件不存在 → 返回 fallback（首次运行，正常路径）
 * - 解析失败（损坏）→ 把坏文件改名 `<path>.corrupt-<ts>` 留档后返回 fallback
 *   （旧版 todo/task 静默吞损坏；此版留档便于用户排查，与"损坏返回默认"行为兼容）
 */
export function readJsonStore<T>(path: string, fallback: T, logger?: Logger): T {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const corruptPath = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, corruptPath);
      logger?.warn('filesys: corrupted store backed up, falling back to defaults', {
        path,
        corruptPath,
      });
    } catch {
      logger?.warn('filesys: corrupted store detected but backup rename failed', { path });
    }
    return fallback;
  }
}

/**
 * 写入 JSON 存储：mkdir + 原子写（tmp + fsync + rename）。
 * 所有内部存储（sessions/tasks/ledger/todo…）统一经此持久化。
 */
export function writeJsonStore(path: string, data: unknown, opts?: { fsync?: boolean }): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, JSON.stringify(data, null, 2), { fsync: opts?.fsync ?? true });
  markInternalWrite(path);
}
