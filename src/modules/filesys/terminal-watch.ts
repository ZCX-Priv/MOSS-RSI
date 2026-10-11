// src/modules/filesys/terminal-watch.ts
// 终端命令前后快照检测：terminal 工具执行前后各做一次工作区 stat 清单（轻量，只 stat 不读内容），
// diff 出 created/modified/deleted 三分类，并对"读缓存持有执行前内容"的文件做回填备份，
// 使终端命令造成的文件变更（mv/rm/重定向等）纳入 file-history（可 undo / 可感知）。
//
// undo 三层降级（尽力而为，无法预知命令将改哪些文件，全量预备份不可行）：
//   ① modified/deleted 且缓存命中（peek 拿执行前 buffer）→ 备份执行前内容 → 可完整 undo
//   ② created → 记 operation='create' 条目（undo = 删除该文件）
//   ③ modified/deleted 未命中缓存 → 记无备份条目（undo 时提示不可恢复），事件照发

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

/** 轻量目录遍历：固定剪枝 + 超时检查，产出文件绝对路径（条目上限由调用方统计判断） */
function* walkSnapshotFiles(root: string, _maxFiles: number, deadline: number): Generator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限/竞态删除
    }
    for (const ent of entries) {
      if (Date.now() > deadline) return;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SNAPSHOT_SKIP_DIRS.has(ent.name)) continue;
        stack.push(full);
      } else if (ent.isFile()) {
        yield full;
      }
    }
  }
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

  /** 终端命令执行前快照：收集 roots 下全部文件的 stat 清单；禁用或文件数超限返回 null */
  async begin(cwd: string, extraRoots: readonly string[]): Promise<TerminalSnapshot | null> {
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) return null;

    const entries = new Map<string, { mtimeMs: number; size: number }>();
    const ok = this.collectInto([cwd, ...extraRoots], cfg.maxFiles, Number.POSITIVE_INFINITY, entries);
    if (!ok) {
      // 超限：跳过本次检测（大仓库保护），不产生半截快照
      this.deps.logger.warn('filesys: terminal snapshot skipped, file count exceeds limit', {
        maxFiles: cfg.maxFiles,
      });
      return null;
    }
    return { roots: [cwd, ...extraRoots], entries };
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
    const deadline = Date.now() + cfg.timeoutMs;

    const after = new Map<string, { mtimeMs: number; size: number }>();
    const ok = this.collectInto(snap.roots, cfg.maxFiles, deadline, after);
    if (!ok) {
      // 截断保护（超时/超限）：放弃本次 diff。半截 after 与完整 before diff 会把
      // 大量未扫描文件误判为 deleted（多轮命令执行时被放大为成片误报），
      // 对齐 begin 的"不产生半截快照"哲学——宁可不跟踪，不可错跟踪。
      report.truncated = true;
      this.deps.logger.warn('filesys: terminal snapshot truncated on end, diff skipped', {
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
   * walk + stat 收集清单。
   * @returns false = 超时/超限被截断（begin 视为放弃，end 按 truncated 处理）。
   * 超时判定必须在调用方循环内做：walkSnapshotFiles 超时直接 return（generator 正常
   * 结束），否则半截清单被当作完整结果返回（历史缺陷：截断被静默吞掉）。
   */
  private collectInto(
    roots: readonly string[],
    maxFiles: number,
    deadline: number,
    into: Map<string, { mtimeMs: number; size: number }>,
  ): boolean {
    for (const root of roots) {
      try {
        for (const abs of walkSnapshotFiles(root, maxFiles, deadline)) {
          if (into.size > maxFiles) return false;
          if (Date.now() > deadline) return false;
          try {
            const s = statSync(abs);
            into.set(abs, { mtimeMs: s.mtimeMs, size: s.size });
          } catch {
            /* walk 与 stat 之间被删除：忽略 */
          }
        }
      } catch (err) {
        this.deps.logger.debug('filesys: terminal snapshot walk root failed', {
          root,
          error: err instanceof Error ? err.message : String(err),
        });
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