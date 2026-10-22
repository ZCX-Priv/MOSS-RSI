// src/modules/filesys/terminal-watch.ts
// 终端命令前后快照检测：terminal 工具执行前后各做一次工作区 stat 清单（轻量，只 stat 不读内容），
// diff 出 created/modified/deleted 三分类，并对"读缓存持有执行前内容"的文件做回填备份，
// 使终端命令造成的文件变更（mv/rm/重定向等）纳入 file-history（可 undo / 可感知）。
//
// undo 三层降级（尽力而为，无法预知命令将改哪些文件，全量预备份不可行）：
//   ① modified/deleted 且缓存命中（peek 拿执行前 buffer）→ 备份执行前内容 → 可完整 undo
//   ② created → 记 operation='create' 条目（undo = 删除该文件）
//   ③ modified/deleted 未命中缓存 → 记无备份条目（undo 时提示不可恢复），事件照发

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isPathInside } from '../../utils/fs';
import type { FileCache } from './cache';
import type { Logger, ServiceRegistry } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { TerminalChangeReport, TerminalSnapshot, TerminalWatchConfig } from './types';

/**
 * 快照遍历的固定剪枝集（拷自 tools/shared/search-core 的 ALWAYS_SKIP_DIRS + DEFAULT_IGNORES）。
 * 刻意不解析完整 .gitignore：快照场景 stat 清单本就近似（mtime 精度），固定剪枝覆盖
 * node_modules/dist/build 等大头即可；完整 gitignore 剪枝留在 grep/glob 的 walkFiles。
 * 同时使 filesys 内核服务不依赖 bun-only API（Bun.Glob），纯 node 工具链可用。
 */
const SNAPSHOT_SKIP_DIRS = new Set([
  '.git', '.hg', '.svn',
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.cache',
  '.turbo', '.output', '.vercel', 'coverage', '__pycache__', '.venv', 'venv',
  '.moss', '.trash',
]);

/** 是否文件系统根（Windows 盘根 / POSIX '/'）——全盘扫描无意义且代价巨大，直接跳过 */
function isFileSystemRoot(p: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(p) || p === '/' || p === '\\';
}

/**
 * 轻量目录收集：固定剪枝 + 超时检查，把文件绝对路径及其 stat 写入 into。
 * @returns false = 被 deadline / maxFiles 截断。调用方必须按截断处理（begin 放弃、end 不 diff），
 *   绝不把半截清单当作完整快照——否则未扫到的文件会被成片误判为 deleted。
 * **异步（fs/promises）**：逐条 `await` 让出事件循环，扫描期间 PTY 输出仍可被读取——
 * 旧实现用同步 readdirSync/statSync，会在事件循环上阻塞数秒到数十秒（实测默认工作目录
 * C:\ 扫 1.3 万文件 >15s 仍未结束），导致命令「跑完却迟迟无结果 / 脚本超时」。
 */
async function collectRoot(
  root: string,
  maxFiles: number,
  deadline: number,
  into: Map<string, { mtimeMs: number; size: number }>,
): Promise<boolean> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    if (Date.now() > deadline) return false;
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限/竞态删除
    }
    for (const ent of entries) {
      if (Date.now() > deadline) return false;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SNAPSHOT_SKIP_DIRS.has(ent.name)) continue;
        stack.push(full);
      } else if (ent.isFile()) {
        if (into.size > maxFiles) return false;
        try {
          const s = await stat(full);
          into.set(full, { mtimeMs: s.mtimeMs, size: s.size });
        } catch {
          /* walk 与 stat 之间被删除：忽略 */
        }
      }
    }
  }
  return true;
}

/**
 * file-history 侧的统一变更追踪支持（最小结构类型，避免模块反向依赖 file-history 的类型）。
 * 与 FileHistoryService.track 同构：file-history 实现后自动生效；
 * 未实现（旧版本）时降级为仅检测+事件，不备份。
 */
export interface TerminalHistorySupport {
  /** 统一追踪入口：终端命令场景为事后回填（terminalBefore 来自读缓存） */
  track(req: {
    sessionId: string;
    absPath: string;
    toolName: 'terminal';
    toolCallId?: string;
    terminalKind: 'created' | 'modified' | 'deleted';
    terminalBefore: Buffer | null;
  }): Promise<{ commit(after?: { hashAfter?: string; bytesAfter?: number; diff?: string }): void }>;
}

export class TerminalWatcher {
  constructor(
    private readonly deps: {
      cache: FileCache;
      logger: Logger;
      services: ServiceRegistry;
      getConfig: () => TerminalWatchConfig;
    },
  ) {}

  /** 终端命令执行前快照：收集 roots 下全部文件的 stat 清单；禁用/根目录/超限返回 null */
  async begin(cwd: string, extraRoots: readonly string[]): Promise<TerminalSnapshot | null> {
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) return null;
    // 文件系统根（默认工作目录 C:\ 场景）无法做有意义的 diff，且全盘扫描代价巨大 → 直接跳过
    if (isFileSystemRoot(cwd)) return null;

    // 附加 roots 过滤：去掉文件系统根，以及与 cwd 互为祖先/自身的项（避免重复扫描同一棵大树）
    const roots: string[] = [cwd];
    for (const r of extraRoots) {
      if (isFileSystemRoot(r)) continue;
      if (r === cwd || isPathInside(cwd, r) || isPathInside(r, cwd)) continue;
      roots.push(r);
    }

    const entries = new Map<string, { mtimeMs: number; size: number }>();
    const startedAt = Date.now();
    // 旧配置可能没有 totalTimeoutMs：回退为两倍单阶段超时，避免 NaN deadline 导致永不超时
    const totalBudget =
      Number.isFinite(cfg.totalTimeoutMs) && cfg.totalTimeoutMs > 0
        ? cfg.totalTimeoutMs
        : cfg.timeoutMs * 2;
    // begin 最多用共享总预算的 60%（给 end 留出 diff 时间）；实测大工作区 3s×2 会让每条命令固定多等 6s
    const budget = Math.min(cfg.timeoutMs, Math.floor(totalBudget * 0.6));
    const deadline = startedAt + budget;
    const ok = await this.collectInto(roots, cfg.maxFiles, deadline, entries);
    if (!ok) {
      // 超时/超限：跳过本次检测（大仓库保护），不产生半截快照
      this.deps.logger.debug('filesys: terminal snapshot skipped, truncated or exceeds limit', {
        maxFiles: cfg.maxFiles,
        timeoutMs: cfg.timeoutMs,
        totalTimeoutMs: cfg.totalTimeoutMs,
      });
      return null;
    }
    // end 的可用预算 = totalTimeoutMs - 本次 begin 实际扫描耗时（命令执行时间不计入）
    return { roots, entries, elapsedMs: Date.now() - startedAt };
  }

  /** 终端命令执行后 diff + 缓存回填备份。返回变更报告（快照无法 diff 时返回 null） */
  async end(snap: TerminalSnapshot, sessionId: string, toolCallId: string): Promise<TerminalChangeReport> {
    const cfg = this.deps.getConfig();
    const report: TerminalChangeReport = {
      created: [],
      modified: [],
      deleted: [],
      undone: 0,
      skipped: false,
      truncated: false,
    };
    // end 的预算只扣减 begin 的扫描耗时；命令执行多久与快照预算无关
    const totalBudget =
      Number.isFinite(cfg.totalTimeoutMs) && cfg.totalTimeoutMs > 0
        ? cfg.totalTimeoutMs
        : cfg.timeoutMs * 2;
    const remaining = Math.max(0, totalBudget - snap.elapsedMs);
    const deadline = Date.now() + Math.min(cfg.timeoutMs, remaining);

    const after = new Map<string, { mtimeMs: number; size: number }>();
    const ok = await this.collectInto(snap.roots, cfg.maxFiles, deadline, after);
    if (!ok) {
      // 截断保护（超时/超限）：放弃本次 diff。半截 after 与完整 before diff 会把
      // 大量未扫描文件误判为 deleted（多轮命令执行时被放大为成片误报），
      // 对齐 begin 的"不产生半截快照"哲学——宁可不跟踪，不可错跟踪。
      report.truncated = true;
      this.deps.logger.debug('filesys: terminal snapshot truncated on end, diff skipped', {
        timeoutMs: cfg.timeoutMs,
        maxFiles: cfg.maxFiles,
        sessionId,
      });
      return report;
    }

    // diff 三分类
    for (const [path, meta] of after) {
      const before = snap.entries.get(path);
      if (!before) {
        report.created.push(path);
      } else if (before.mtimeMs !== meta.mtimeMs || before.size !== meta.size) {
        report.modified.push(path);
      }
    }
    for (const path of snap.entries.keys()) {
      if (!after.has(path)) report.deleted.push(path);
    }

    // 缓存回填备份（统一 tracker：track 备份 + commit 登记，顺序 await 防 JSONL 交错；
    // file-history 未实现 track 时整体降级为仅报告）
    const history = this.resolveHistory();
    if (history) {
      for (const path of report.created) {
        try {
          const tracker = await history.track({
            sessionId,
            absPath: path,
            toolName: 'terminal',
            terminalKind: 'created',
            terminalBefore: null,
            toolCallId,
          });
          tracker.commit();
          report.undone++;
        } catch {
          /* 单文件失败不阻断 */
        }
      }
      for (const path of report.modified) {
        const buf = this.deps.cache.peek(path)?.rawBuffer ?? null;
        try {
          const tracker = await history.track({
            sessionId,
            absPath: path,
            toolName: 'terminal',
            terminalKind: 'modified',
            terminalBefore: buf,
            toolCallId,
          });
          tracker.commit();
          if (buf) report.undone++;
        } catch {
          /* 单文件失败不阻断 */
        }
      }
      for (const path of report.deleted) {
        const buf = this.deps.cache.peek(path)?.rawBuffer ?? null;
        try {
          const tracker = await history.track({
            sessionId,
            absPath: path,
            toolName: 'terminal',
            terminalKind: 'deleted',
            terminalBefore: buf,
            toolCallId,
          });
          tracker.commit();
          if (buf) report.undone++;
        } catch {
          /* 单文件失败不阻断 */
        }
      }
    }

    return report;
  }

  /**
   * 收集 roots 下的 stat 清单。
   * @returns false = 任一 root 被超时/超限截断（begin 视为放弃，end 按 truncated 处理）。
   * 截断信号必须由遍历函数显式返回，不能依赖"最后有没有再产出一个文件"来判断——
   * 旧实现用 generator，超时时正常结束，调用方的 deadline 检查被跳过，半截清单被当作
   * 完整结果返回（成片 deleted 误报的根因）。
   */
  private async collectInto(
    roots: readonly string[],
    maxFiles: number,
    deadline: number,
    into: Map<string, { mtimeMs: number; size: number }>,
  ): Promise<boolean> {
    for (const root of roots) {
      try {
        if (!(await collectRoot(root, maxFiles, deadline, into))) return false;
      } catch (err) {
        // 遍历中途异常同样意味着该 root 未扫全，必须按截断处理
        this.deps.logger.debug('filesys: terminal snapshot walk root failed', {
          root,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    }
    return true;
  }

  private resolveHistory(): TerminalHistorySupport | null {
    try {
      const svc = this.deps.services.tryResolve<Partial<TerminalHistorySupport>>(ServiceNames.FILE_HISTORY);
      if (svc && typeof svc.track === 'function') {
        return svc as TerminalHistorySupport;
      }
    } catch {
      /* 服务未注册 */
    }
    return null;
  }
}