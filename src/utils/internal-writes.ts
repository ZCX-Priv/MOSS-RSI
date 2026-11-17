// src/utils/internal-writes.ts
// 进程内“最近内部写盘”登记：供任务目录 fs.watch 过滤自身写入，避免热同步自触发循环。
// 纯函数模块（无业务依赖），core / modules / utils 均可引用。

import { resolve } from 'node:path';

/** 默认抑制窗口：覆盖原子写 rename 事件延迟（Windows 下偶发拆成多个事件） */
const DEFAULT_WINDOW_MS = 3000;
/** 最多保留的路径数：超过后清理过期项，避免长期运行无限增长 */
const MAX_ENTRIES = 500;

const recentWrites = new Map<string, number>();

/** 路径归一化：绝对路径；Windows 下大小写不敏感 */
function normalize(filePath: string): string {
  const abs = resolve(filePath);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** 登记一次内部写入（原子写完成后调用） */
export function markInternalWrite(filePath: string): void {
  const now = Date.now();
  recentWrites.set(normalize(filePath), now);
  if (recentWrites.size <= MAX_ENTRIES) return;
  for (const [key, at] of recentWrites) {
    if (now - at > DEFAULT_WINDOW_MS) recentWrites.delete(key);
  }
}

/** 该路径是否在抑制窗口内被本进程写过 */
export function isRecentInternalWrite(filePath: string, windowMs = DEFAULT_WINDOW_MS): boolean {
  const at = recentWrites.get(normalize(filePath));
  return at !== undefined && Date.now() - at <= windowMs;
}
