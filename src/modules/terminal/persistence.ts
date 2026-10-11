// src/modules/terminal/persistence.ts
// 终端持久化：把「终端元数据 + 输出缓冲」落盘到 ~/.moss/terminals/<session>.json。
// 目的：终端本体在后端进程内存，进程重启即丢失；落盘后 terminal.list / terminal.snapshot
// 仍能还原标签与历史（还原项标记为 offline 只读）。
// - 高频输出走 scheduleSave（去抖）；创建/退出/关闭/删除会话走 save（同步）。
// - 单会话最多保留 MAX_PERSISTED_PER_SESSION 条；单条缓冲截断到 TERMINAL_LIMITS.bufferChars。
// - 任何读写/解析失败均静默降级（不阻塞终端运行）。

import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../../utils/fs-atomic';
import { TERMINAL_LIMITS, type TerminalInfo } from './types';

/** 单个持久化终端条目 */
export interface PersistedTerminal {
  info: TerminalInfo;
  buffer: string;
}

interface PersistedFile {
  sessionId: string;
  terminals: PersistedTerminal[];
}

/** 高频输出去抖落盘间隔（ms） */
const SAVE_DEBOUNCE_MS = 1500;
/** 单会话最多保留的终端条目数（含离线历史项） */
const MAX_PERSISTED_PER_SESSION = 12;

export class TerminalPersistence {
  /** 终端持久化目录：<dataDir>/terminals */
  private readonly dir: string;
  /** sessionId → (terminalId → 条目) */
  private readonly cache = new Map<string, Map<string, PersistedTerminal>>();
  /** 待写盘的去抖定时器（按会话） */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

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

  /** 覆盖式写入某会话全部条目（截断缓冲 + 限条数）并同步落盘 */
  save(sessionId: string, entries: PersistedTerminal[]): void {
    const trimmed = this.trim(entries);
    this.cache.set(sessionId, new Map(trimmed.map((e) => [e.info.id, e])));
    this.writeFile(sessionId, trimmed);
  }

  /** 高频输出：先去抖更新缓存，再延迟落盘（最多丢 SAVE_DEBOUNCE_MS 内的尾部输出） */
  scheduleSave(sessionId: string, entries: PersistedTerminal[]): void {
    const trimmed = this.trim(entries);
    this.cache.set(sessionId, new Map(trimmed.map((e) => [e.info.id, e])));
    const prev = this.timers.get(sessionId);
    if (prev) clearTimeout(prev);
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        this.writeFile(sessionId, Array.from(this.cache.get(sessionId)?.values() ?? []));
      }, SAVE_DEBOUNCE_MS),
    );
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

  /** 限条数（保留最新）+ 截断单条缓冲 */
  private trim(entries: PersistedTerminal[]): PersistedTerminal[] {
    const max = TERMINAL_LIMITS.bufferChars;
    return entries.slice(-MAX_PERSISTED_PER_SESSION).map((e) => ({
      info: e.info,
      buffer: e.buffer.length > max ? e.buffer.slice(-max) : e.buffer,
    }));
  }

  private writeFile(sessionId: string, entries: PersistedTerminal[]): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const body: PersistedFile = { sessionId, terminals: entries };
      atomicWriteFile(this.fileOf(sessionId), JSON.stringify(body), { fsync: false });
    } catch {
      // 落盘失败不致命（内存缓存仍然可用）
    }
  }
}