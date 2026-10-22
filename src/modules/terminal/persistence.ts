// src/modules/terminal/persistence.ts
// 终端持久化：把「终端元数据 + 输出缓冲」落盘到 ~/.moss/terminals/<session>.json。
// 目的：终端本体在后端进程内存，进程重启即丢失；落盘后 terminal.list / terminal.snapshot
// 仍能还原标签与历史（还原项标记为 offline 只读）。
// - 高频输出走 scheduleSave（去抖）；创建/退出/关闭/删除会话走 save。
// - 全部写入为**异步 + 串行写链**：定时器里不做同步序列化/同步磁盘 IO，
//   避免大历史（数百 KB）每 3 秒阻塞事件循环（终端输出卡顿、命令返回慢的根因之一）。
// - 单会话最多保留 MAX_PERSISTED_PER_SESSION 条；单条缓冲截断到 MAX_PERSIST_CHARS。
// - 任何读写/解析失败均静默降级（不阻塞终端运行）。

import { readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFileAsync } from '../../utils/fs-atomic';
import { type TerminalInfo } from './types';

/** 单个持久化终端条目 */
export interface PersistedTerminal {
  info: TerminalInfo;
  /** 输出历史：**@xterm/addon-serialize 序列化串**（行导向、带 ANSI 颜色、可回放/可回滚）；
   *  serialize 依赖不可用时降级为原始流。 */
  buffer: string;
}

interface PersistedFile {
  sessionId: string;
  terminals: PersistedTerminal[];
}

/** 高频输出落盘间隔（ms）：固定周期而非「持续输出就永远不写」，避免长命令期间内存态无落盘 */
const SAVE_DEBOUNCE_MS = 3000;
/** 单会话最多保留的终端条目数（含离线历史项） */
const MAX_PERSISTED_PER_SESSION = 12;
/** 单条序列化历史字符上限（超限在"行边界"截尾——序列化串不可从中间硬截断，否则回放损坏） */
const MAX_PERSIST_CHARS = 400_000;

/**
 * 序列化历史超限截尾：序列化串是「行导向 + 光标定位」序列，**不能从中间硬切**（会破坏回放）。
 * 只在行边界（\r\n）截断并保留尾部；仅当整串超限时才丢最早的行（超大历史的降级）。
 */
function clipHistory(s: string): string {
  if (s.length <= MAX_PERSIST_CHARS) return s;
  const tail = s.slice(-MAX_PERSIST_CHARS);
  const nl = tail.indexOf('\r\n');
  return nl >= 0 ? tail.slice(nl + 2) : tail;
}

export class TerminalPersistence {
  /** 终端持久化目录：<dataDir>/terminals */
  private readonly dir: string;
  /** sessionId → (terminalId → 条目) */
  private readonly cache = new Map<string, Map<string, PersistedTerminal>>();
  /** 待写盘的去抖定时器（按会话） */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 每会话的写链：串行化写盘，避免并发 rename 互相覆盖 */
  private readonly writes = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'terminals');
  }

  /** 会话文件路径（sessionId 编码为文件名安全形式） */
  private fileOf(sessionId: string): string {
    return join(this.dir, `${encodeURIComponent(sessionId)}.json`);
  }

  /** 启动时全量载入（条目数量少；一次性读入便于按 terminalId 全局查找快照） */
  loadAll(): void {
    try {
      if (!existsSync(this.dir)) return;
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const raw = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as PersistedFile;
          if (!raw || typeof raw.sessionId !== 'string' || !Array.isArray(raw.terminals)) continue;
          const map = new Map<string, PersistedTerminal>();
          for (const t of raw.terminals) {
            if (t && t.info && typeof t.info.id === 'string') map.set(t.info.id, t);
          }
          this.cache.set(raw.sessionId, map);
        } catch {
          // 单文件损坏：忽略
        }
      }
    } catch {
      // 目录不可读：忽略
    }
  }

  /** 某会话的条目（快照，按插入序） */
  list(sessionId: string): PersistedTerminal[] {
    return Array.from(this.cache.get(sessionId)?.values() ?? []);
  }

  /** 按 terminalId 全局查找（snapshot 还原用） */
  getById(terminalId: string): PersistedTerminal | undefined {
    for (const map of this.cache.values()) {
      const hit = map.get(terminalId);
      if (hit) return hit;
    }
    return undefined;
  }

  /** 覆盖式写入某会话全部条目（截断缓冲 + 限条数）并异步落盘 */
  async save(sessionId: string, entries: PersistedTerminal[]): Promise<void> {
    const trimmed = this.trim(entries);
    this.cache.set(sessionId, new Map(trimmed.map((e) => [e.info.id, e])));
    await this.writeFile(sessionId, trimmed);
  }

  /**
   * 高频输出：去抖落盘。构建函数 `build` 只在去抖到期时执行一次，且允许异步
   * （调用方先等待 headless 解析完成再序列化）。
   *
   * build 必须是惰性的：调用方（TerminalManager.onData）会为**每个输出分片**调用本方法，
   * 若在此处就把 entries 构建好（复制整会话全部终端缓冲），输出量大时呈
   * O(分片数 × 缓冲长度) 的二次开销，是「长命令/脚本特别慢」的放大因素之一。
   */
  scheduleSave(
    sessionId: string,
    build: () => PersistedTerminal[] | Promise<PersistedTerminal[]>,
  ): void {
    // 已有定时器就不重置：输出持续不断时也必须按固定周期落盘（否则等于永不落盘）
    if (this.timers.has(sessionId)) return;
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        void (async () => {
          try {
            const trimmed = this.trim(await build());
            // 会话可能已在构建期间被删除：不再写回
            if (!this.cache.has(sessionId)) return;
            this.cache.set(sessionId, new Map(trimmed.map((e) => [e.info.id, e])));
            await this.writeFile(sessionId, trimmed);
          } catch {
            // 单次落盘失败不影响终端运行；下一次定时器会重试
          }
        })();
      }, SAVE_DEBOUNCE_MS),
    );
  }

  /** 等待写盘完成（进程退出/会话删除前尽力 flush，避免丢最后一次写入） */
  async flush(sessionId?: string): Promise<void> {
    if (sessionId) {
      await (this.writes.get(sessionId) ?? Promise.resolve());
      return;
    }
    await Promise.allSettled(Array.from(this.writes.values()));
  }

  /** 删除某会话的持久化（文件 + 缓存 + 待写定时器） */
  remove(sessionId: string): void {
    const t = this.timers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(sessionId);
    }
    this.cache.delete(sessionId);
    try {
      rmSync(this.fileOf(sessionId), { force: true });
    } catch {
      // 静默
    }
  }

  // ── 内部 ──

  /** 限条数（保留最新）+ 超限历史「行边界截尾」 */
  private trim(entries: PersistedTerminal[]): PersistedTerminal[] {
    return entries.slice(-MAX_PERSISTED_PER_SESSION).map((e) => ({
      info: e.info,
      buffer: clipHistory(e.buffer),
    }));
  }

  /** 异步写文件（按会话串行；同一会话的新写会排在旧写之后） */
  private writeFile(sessionId: string, entries: PersistedTerminal[]): Promise<void> {
    const prev = this.writes.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        // 排队期间会话被删除 → 放弃写
        if (!this.cache.has(sessionId)) return;
        try {
          await mkdir(this.dir, { recursive: true });
          const body: PersistedFile = { sessionId, terminals: entries };
          await atomicWriteFileAsync(this.fileOf(sessionId), JSON.stringify(body));
        } catch {
          // 落盘失败不致命（内存缓存仍然可用）
        }
      })
      .finally(() => {
        if (this.writes.get(sessionId) === next) this.writes.delete(sessionId);
      });
    this.writes.set(sessionId, next);
    return next;
  }
}
