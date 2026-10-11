// src/modules/file-history/service.ts
// FileHistoryService 实现：组装 backup / ledger / transcript / atomic-write / diff。
// 三层架构：
//   Layer 1 (Track)：track() 统一变更追踪入口（tracker 对象模式，改前备份）
//   Layer 2 (Snapshot)：createSnapshot 每轮快照（当前 no-op，预留）
//   Layer 3 (Transcript)：tracker.commit() 写 JSONL，undo 读 JSONL 恢复

import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { existsSync, unlinkSync, statSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import type { Logger, Environment } from '../../core/types';
import type { FileHistoryService } from '../contracts';
import type {
  FileHistoryEntry,
  TrackRequest,
  TrackReceipt,
  TrackCompletion,
  ChangeTracker,
  UndoResult,
  FileHistoryConfig,
  FileOperation,
} from './types';
import { backupByHash, backupBufferByHash, readBackup } from './backup';
import { ReadLedger } from './ledger';
import {
  appendEntry,
  readEntries,
  removeEntryById,
  removeEntriesByIds,
  peekActiveEntries,
  markEntriesRolledBack,
  clearRolledBackMarks,
  isActiveEntry,
} from './transcript';
import { atomicWriteFile } from '../../utils/fs-atomic';
import { archiveDirectory, extractArchive } from './archive';
import { cleanupExpiredTrash, TRASH_RETENTION_DAYS } from './trash';

/** tracker 闭包携带的登记状态：收据 + move 目标路径 */
interface TrackerState {
  sessionId: string;
  absPath: string;
  receipt: TrackReceipt;
  /** move 的目标路径（operation='move' 时 commit 登录用） */
  destPath?: string;
}

export class FileHistoryServiceImpl implements FileHistoryService {
  private readonly ledger: ReadLedger;
  private readonly backupDir: string;
  private readonly transcriptDir: string;
  private readonly trashDir: string;

  constructor(
    private readonly env: Environment,
    private readonly logger: Logger,
    private readonly config: FileHistoryConfig,
  ) {
    // 统一布局根目录：~/.moss/file-history/（backups / transcripts / trash / ledger 四个子目录）
    const rootDir = join(env.dataDir, 'file-history');
    this.backupDir = join(rootDir, 'backups');
    this.transcriptDir = join(rootDir, 'transcripts');
    this.trashDir = join(rootDir, 'trash');
    // ledger 持久化：~/.moss/file-history/ledger/<sessionId>.json（重启后 read-before-overwrite 仍有效）
    this.ledger = new ReadLedger(join(rootDir, 'ledger'), logger);
  }

  /** 全局开关：config.fileHistory.enabled 为 false 时所有行为降级为 no-op */
  private get enabled(): boolean {
    return this.config.enabled;
  }

  /** 获取某会话的 transcript 文件路径 */
  private transcriptPath(sessionId: string): string {
    // 防路径注入：sessionId 只允许字母数字-_（UUID 天然符合）
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    return join(this.transcriptDir, `${safe}.jsonl`);
  }

  /**
   * 统一变更追踪入口（tracker 对象模式）：按 toolName 分发。
   * write/edit/delete → 改前备份；move/copy → 无备份收据；terminal → 事后回填备份。
   * enabled=false 时返回 no-op tracker（收据空值，commit 无操作）。
   */
  async track(req: TrackRequest): Promise<ChangeTracker> {
    const callerInfo = {
      ...(req.toolCallId ? { toolCallId: req.toolCallId } : {}),
      toolName: req.toolName,
    };

    if (!this.enabled) {
      // 全局禁用：no-op tracker，不备份不记录
      return this.makeTracker({
        sessionId: req.sessionId,
        absPath: req.absPath,
        receipt: {
          backedUp: false,
          backupPath: null,
          hash: '',
          bytesBefore: 0,
          entryId: '',
          operation: 'create',
          ...callerInfo,
        },
      });
    }

    switch (req.toolName) {
      case 'move':
        // move：内容不变无需备份；commit 登记反向 rename 条目
        return this.makeTracker({
          sessionId: req.sessionId,
          absPath: req.absPath,
          receipt: {
            backedUp: false,
            backupPath: null,
            hash: '',
            bytesBefore: req.bytesBefore ?? 0,
            entryId: randomUUID(),
            operation: 'move',
            ...(req.isDirectory ? { isDirectory: true } : {}),
            ...callerInfo,
          },
          destPath: req.destPath,
        });

      case 'copy':
        // copy：副本目标在复制前不存在 → create 收据（undo = 删除副本），无备份
        return this.makeTracker({
          sessionId: req.sessionId,
          absPath: req.absPath,
          receipt: {
            backedUp: false,
            backupPath: null,
            hash: '',
            bytesBefore: 0,
            entryId: randomUUID(),
            operation: 'create',
            ...(req.isDirectory ? { isDirectory: true } : {}),
            ...callerInfo,
          },
        });

      case 'terminal':
      case 'shell': // 旧值兼容读取
        // terminal：事后回填（执行前内容来自 filesys 读缓存）
        return this.makeTracker(await this.prepareTerminalReceipt(req));

      default:
        // write / edit / delete：改前备份（同步阻塞，必须在变更前完成）
        return this.makeTracker(await this.prepareEditReceipt(req));
    }
  }

  /** write/edit/delete 的改前备份收据：不存在→create；目录→tar.gz 归档；文件→内容哈希备份 */
  private async prepareEditReceipt(req: TrackRequest): Promise<TrackerState> {
    const { sessionId, absPath } = req;
    const entryId = randomUUID();
    const callerInfo = {
      ...(req.toolCallId ? { toolCallId: req.toolCallId } : {}),
      toolName: req.toolName,
    };
    const operation: FileOperation =
      req.toolName === 'delete' ? 'delete' : req.toolName === 'edit' ? 'edit' : 'overwrite';

    // 文件/目录不存在 → create 操作，无需备份
    if (!existsSync(absPath)) {
      return {
        sessionId,
        absPath,
        receipt: { backedUp: false, backupPath: null, hash: '', bytesBefore: 0, entryId, operation: 'create', ...callerInfo },
      };
    }

    const stat = statSync(absPath);

    // 目录 → tar.gz 整体归档备份（支持 undo 解包恢复）
    if (stat.isDirectory()) {
      const archivePath = join(this.backupDir, `${entryId}.tar.gz`);
      try {
        const result = await archiveDirectory(absPath, archivePath);
        this.logger.debug('file-history: track directory archived', {
          sessionId,
          absPath,
          operation,
          archivePath: result.archivePath,
          bytes: result.bytes,
        });
        return {
          sessionId,
          absPath,
          receipt: {
            backedUp: true,
            backupPath: result.archivePath,
            hash: '', // 目录归档无内容哈希
            bytesBefore: result.bytes,
            entryId,
            operation,
            isDirectory: true,
            ...callerInfo,
          },
        };
      } catch (err) {
        this.logger.warn('file-history: directory archive failed', {
          absPath,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          sessionId,
          absPath,
          receipt: { backedUp: false, backupPath: null, hash: '', bytesBefore: 0, entryId, operation, isDirectory: true, ...callerInfo },
        };
      }
    }

    // 文件 → 按内容哈希备份（同内容去重）
    let backup;
    try {
      backup = backupByHash(absPath, this.backupDir);
    } catch (err) {
      // 备份失败：记录错误但不阻断工具执行（文件变更仍可进行，但 undo 不可用）
      this.logger.warn('file-history: backup failed', {
        absPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        sessionId,
        absPath,
        receipt: { backedUp: false, backupPath: null, hash: '', bytesBefore: stat.size, entryId, operation, ...callerInfo },
      };
    }

    this.logger.debug('file-history: track', {
      sessionId,
      absPath,
      operation,
      hash: backup.hash,
      bytes: backup.bytes,
      backedUp: backup.created,
    });

    return {
      sessionId,
      absPath,
      receipt: {
        backedUp: backup.created,
        backupPath: backup.backupPath,
        hash: backup.hash,
        bytesBefore: backup.bytes,
        entryId,
        operation,
        ...callerInfo,
      },
    };
  }

  /** terminal 事后回填收据：kind 映射 operation；terminalBefore 非空时按哈希备份（可完整 undo） */
  private async prepareTerminalReceipt(req: TrackRequest): Promise<TrackerState> {
    const { sessionId, absPath } = req;
    const kind = req.terminalKind ?? 'modified';
    const entryId = randomUUID();
    const callerInfo = {
      ...(req.toolCallId ? { toolCallId: req.toolCallId } : {}),
      toolName: 'terminal' as const,
    };
    const operation: FileOperation =
      kind === 'created' ? 'create' : kind === 'deleted' ? 'delete' : 'edit';

    let backupPath: string | null = null;
    let hash = '';
    let bytesBefore = 0;

    if (kind !== 'created' && req.terminalBefore) {
      try {
        const backup = backupBufferByHash(req.terminalBefore, this.backupDir);
        backupPath = backup.backupPath;
        hash = backup.hash;
        bytesBefore = backup.bytes;
      } catch (err) {
        this.logger.warn('file-history: terminal backup failed', {
          absPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      sessionId,
      absPath,
      receipt: { backedUp: backupPath !== null, backupPath, hash, bytesBefore, entryId, operation, ...callerInfo },
    };
  }

  /** 组装 tracker：receipt 冻结为只读快照，commit 闭包携带登记状态 */
  private makeTracker(state: TrackerState): ChangeTracker {
    const frozenReceipt: TrackReceipt = Object.freeze({ ...state.receipt });
    return {
      receipt: frozenReceipt,
      commit: (after?: TrackCompletion): void => this.commitEntry(state, after ?? {}),
    };
  }

  /**
   * commit 实现：按收据 operation 写 transcript。
   * move 登记反向 rename 条目；其余登记通用条目（hashBefore 来自收据、hashAfter 来自 after）。
   * transcriptEnabled=false 时 no-op；登记失败记 warn 不抛出。
   */
  private commitEntry(state: TrackerState, after: TrackCompletion): void {
    if (!this.enabled) return;
    const { sessionId, absPath, receipt } = state;
    if (!receipt.entryId) return; // track 被禁用（no-op tracker）
    if (!this.config.transcriptEnabled) return;

    const timestamp = new Date().toISOString();
    const entry: FileHistoryEntry =
      receipt.operation === 'move'
        ? {
            // move 条目：absPath=源路径、destPath=目标路径；undo = destPath → absPath 反向 rename
            id: receipt.entryId,
            sessionId,
            absPath,
            toolCallId: receipt.toolCallId ?? '',
            toolName: 'move',
            timestamp,
            operation: 'move',
            hashBefore: null,
            hashAfter: null,
            backupPath: null,
            bytesBefore: receipt.bytesBefore,
            bytesAfter: receipt.bytesBefore,
            ...(state.destPath ? { destPath: state.destPath } : {}),
            ...(receipt.isDirectory ? { isDirectory: true } : {}),
          }
        : {
            id: receipt.entryId,
            sessionId,
            absPath,
            toolCallId: receipt.toolCallId ?? '',
            toolName: receipt.toolName
              ?? (receipt.operation === 'delete' ? 'delete' : receipt.operation === 'edit' ? 'edit' : 'write'),
            timestamp,
            operation: receipt.operation,
            hashBefore: receipt.hash || null,
            hashAfter: after.hashAfter || null,
            backupPath: receipt.backupPath,
            bytesBefore: receipt.bytesBefore,
            bytesAfter: after.bytesAfter ?? 0,
            ...(after.diff ? { diff: after.diff } : {}),
            ...(receipt.isDirectory ? { isDirectory: true } : {}),
          };

    try {
      appendEntry(this.transcriptPath(sessionId), entry);
    } catch (err) {
      this.logger.warn('file-history: commit failed', {
        sessionId,
        absPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  isRead(sessionId: string, absPath: string): boolean {
    return this.ledger.isRead(sessionId, absPath);
  }

  markRead(sessionId: string, absPath: string, sha: string): void {
    this.ledger.markRead(sessionId, absPath, sha);
  }

  async createSnapshot(_sessionId: string): Promise<void> {
    // Layer 2：当前实现为 no-op。
    // 预留扩展点：未来可在此为会话所有追踪文件创建完整快照。
    // 当前 undo 基于 transcript + 备份已足够，无需全量快照。
  }

  async undo(sessionId: string, steps = 1): Promise<UndoResult> {
    if (!this.enabled) {
      return { restored: [], remaining: 0, failed: [] };
    }

    const path = this.transcriptPath(sessionId);
    // peek 活跃条目（跳过 R 条目与已回滚条目），不物理移除
    let pending: FileHistoryEntry[];
    try {
      pending = peekActiveEntries(path, steps);
    } catch (err) {
      this.logger.error('file-history: undo read transcript failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { restored: [], remaining: 0, failed: [] };
    }

    if (pending.length === 0) {
      return { restored: [], remaining: this.countActive(path), failed: [] };
    }

    const restored: string[] = [];
    const failed: Array<{ entryId: string; absPath: string; error: string }> = [];

    // 逆序处理（pending 已是倒序：最近在前）。
    // 先恢复成功再移除条目：恢复失败的条目保留在 transcript，可重试（历史永不丢失）。
    for (const entry of pending) {
      try {
        await this.restoreEntry(entry);
        removeEntryById(path, entry.id);
        restored.push(entry.absPath);
        this.logger.info('file-history: undo restored', {
          sessionId,
          absPath: entry.absPath,
          operation: entry.operation,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failed.push({ entryId: entry.id, absPath: entry.absPath, error: errMsg });
        this.logger.warn('file-history: undo failed for entry (entry kept for retry)', {
          sessionId,
          absPath: entry.absPath,
          error: errMsg,
        });
      }
    }

    return { restored, remaining: this.countActive(path), failed };
  }

  /** 活跃条目计数（非 R 且未回滚；remaining 语义 = 仍可撤销的条目数） */
  private countActive(path: string): number {
    try {
      return readEntries(path).filter(isActiveEntry).length;
    } catch {
      return 0;
    }
  }

  listHistory(sessionId: string): FileHistoryEntry[] {
    return readEntries(this.transcriptPath(sessionId));
  }

  async rollbackRange(
    sessionId: string,
    fromTs: string,
    toTs: string,
  ): Promise<{ rollbackIds: string[]; failed: Array<{ absPath: string; error: string }> }> {
    if (!this.enabled) return { rollbackIds: [], failed: [] };
    const path = this.transcriptPath(sessionId);
    const fromMs = Date.parse(fromTs);
    const toMs = Date.parse(toTs);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
      return { rollbackIds: [], failed: [] };
    }
    // 区间内的活跃原始条目（排除 R 条目与已回滚条目——已回滚的不重复回滚，
    // 嵌套撤回时内层窗口的条目天然跳过）
    const targets = readEntries(path).filter(e => {
      if (!isActiveEntry(e)) return false;
      const ts = Date.parse(e.timestamp);
      return !Number.isNaN(ts) && ts >= fromMs && ts <= toMs;
    });

    const rollbackIds: string[] = [];
    const failed: Array<{ absPath: string; error: string }> = [];
    if (targets.length === 0) return { rollbackIds, failed };

    // Phase 1：全量 redo 备份（不动文件、不动 transcript；备份文件落盘 + 内存收集）。
    // 维持"动任何文件前完成全部备份"的既有设计，避免中途失败导致备份缺失。
    const backups = new Map<string, FileHistoryEntry | null>();
    for (const entry of targets) {
      try {
        backups.set(entry.id, await this.createRollbackBackup(sessionId, entry));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failed.push({ absPath: entry.absPath, error: `redo backup failed: ${errMsg}` });
        backups.set(entry.id, null); // 备份失败 → 该条目不进入 Phase 2
      }
    }

    // Phase 2：逆序恢复（最近的最先恢复）。
    // 标记制：成功才登记 R 条目（含 rollbackOf 反向引用）+ 打 rolledBackAt 标记；
    // 失败不打标记（条目保留可重试），原始条目永不物理删除。
    const markedAt = new Date().toISOString();
    const succeededIds = new Set<string>();
    for (let i = targets.length - 1; i >= 0; i--) {
      const entry = targets[i];
      const rbEntry = backups.get(entry.id);
      if (!rbEntry) continue; // Phase 1 备份失败（null）或缺失，跳过
      try {
        await this.restoreEntry(entry);
        const rEntry: FileHistoryEntry = { ...rbEntry, rollbackOf: entry.id };
        appendEntry(path, rEntry);
        rollbackIds.push(rEntry.id);
        succeededIds.add(entry.id);
        this.logger.info('file-history: rollbackRange restored', {
          sessionId,
          absPath: entry.absPath,
          operation: entry.operation,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failed.push({ absPath: entry.absPath, error: errMsg });
        this.logger.warn('file-history: rollbackRange failed for entry (kept for retry)', {
          sessionId,
          absPath: entry.absPath,
          error: errMsg,
        });
      }
    }

    // 批量打 rolledBackAt 标记（一次原子重写，避免 N 次全文件重写）
    if (succeededIds.size > 0) {
      markEntriesRolledBack(path, succeededIds, markedAt);
    }

    return { rollbackIds, failed };
  }

  async redoRollback(
    sessionId: string,
    rollbackIds: string[],
  ): Promise<{ failed: Array<{ absPath: string; error: string }> }> {
    if (!this.enabled) return { failed: [] };
    const path = this.transcriptPath(sessionId);
    if (rollbackIds.length === 0) return { failed: [] };
    const idSet = new Set(rollbackIds);
    const entries = readEntries(path).filter(e => idSet.has(e.id));
    const failed: Array<{ absPath: string; error: string }> = [];

    // 逆序恢复（与回滚顺序相反的逆序 = 回到回滚前状态）。
    // 按 rollbackOf 精确配对：成功的 R 移除 + 对应原始条目清除标记（条目复活，支持再次撤回）；
    // 失败的 R 保留在 transcript（可重试，数据不丢）。
    const redoOkIds = new Set<string>();
    const unmarkIds = new Set<string>();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      try {
        await this.restoreEntry(entry);
        redoOkIds.add(entry.id);
        if (entry.rollbackOf) unmarkIds.add(entry.rollbackOf);
        this.logger.info('file-history: redoRollback restored', {
          sessionId,
          absPath: entry.absPath,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failed.push({ absPath: entry.absPath, error: errMsg });
      }
    }

    if (redoOkIds.size > 0) {
      removeEntriesByIds(path, redoOkIds);
    }
    if (unmarkIds.size > 0) {
      clearRolledBackMarks(path, unmarkIds);
    }
    return { failed };
  }

  /**
   * 为将被回滚的 entry 创建 redo 备份条目（记录回滚前该路径的当前状态）。
   * rollbackOf 反向引用由调用方（rollbackRange Phase 2）在登记时附加。
   * redo = 对该备份条目执行 restoreEntry：
   * - 当前路径存在（文件/目录）→ operation='overwrite' + 当前内容/归档备份 → redo 写回当前状态
   * - 当前路径不存在 → operation='create' → redo 删除该路径
   */
  private async createRollbackBackup(
    sessionId: string,
    original: FileHistoryEntry,
  ): Promise<FileHistoryEntry | null> {
    const now = new Date().toISOString();
    // move 条目的 redo 备份：undo（dest→source）后 redo 需再移回（source→dest）。
    // 生成 {absPath: dest, destPath: source} 的 move entry，restoreEntry 会把 destPath 移到 absPath。
    if (original.operation === 'move' && original.destPath) {
      return {
        id: randomUUID(),
        sessionId,
        absPath: original.destPath,
        toolCallId: original.toolCallId,
        toolName: 'rollback',
        timestamp: now,
        operation: 'move',
        hashBefore: null,
        hashAfter: null,
        backupPath: null,
        bytesBefore: original.bytesBefore,
        bytesAfter: original.bytesAfter,
        destPath: original.absPath,
      };
    }
    if (existsSync(original.absPath)) {
      const stat = statSync(original.absPath);
      if (stat.isDirectory()) {
        const entryId = randomUUID();
        const archivePath = join(this.backupDir, `${entryId}.tar.gz`);
        const result = await archiveDirectory(original.absPath, archivePath);
        return {
          id: entryId,
          sessionId,
          absPath: original.absPath,
          toolCallId: original.toolCallId,
          toolName: 'rollback',
          timestamp: now,
          operation: 'overwrite',
          hashBefore: null,
          hashAfter: null,
          backupPath: result.archivePath,
          bytesBefore: result.bytes,
          bytesAfter: result.bytes,
          isDirectory: true,
        };
      }
      const backup = backupByHash(original.absPath, this.backupDir);
      return {
        id: randomUUID(),
        sessionId,
        absPath: original.absPath,
        toolCallId: original.toolCallId,
        toolName: 'rollback',
        timestamp: now,
        operation: 'overwrite',
        hashBefore: null,
        hashAfter: null,
        backupPath: backup.backupPath,
        bytesBefore: backup.bytes,
        bytesAfter: backup.bytes,
      };
    }
    // 当前路径不存在：redo = 删除该路径
    return {
      id: randomUUID(),
      sessionId,
      absPath: original.absPath,
      toolCallId: original.toolCallId,
      toolName: 'rollback',
      timestamp: now,
      operation: 'create',
      hashBefore: null,
      hashAfter: null,
      backupPath: null,
      bytesBefore: 0,
      bytesAfter: 0,
    };
  }

  async restore(sessionId: string, entryId: string): Promise<UndoResult> {
    if (!this.enabled) {
      return { restored: [], remaining: 0, failed: [] };
    }

    const path = this.transcriptPath(sessionId);
    let entry: FileHistoryEntry | undefined;
    try {
      entry = readEntries(path).find(e => e.id === entryId);
    } catch (err) {
      this.logger.error('file-history: restore read transcript failed', {
        sessionId,
        entryId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { restored: [], remaining: 0, failed: [] };
    }

    if (!entry) {
      return { restored: [], remaining: this.countActive(path), failed: [] };
    }

    // 已回滚条目与 R 条目不可单条恢复（防状态错乱：应走消息恢复 redoRollback）
    if (entry.toolName === 'rollback') {
      return {
        restored: [],
        remaining: this.countActive(path),
        failed: [{
          entryId,
          absPath: entry.absPath,
          error: 'rollback entry cannot be restored individually; use message redo instead',
        }],
      };
    }
    if (entry.rolledBackAt) {
      return {
        restored: [],
        remaining: this.countActive(path),
        failed: [{
          entryId,
          absPath: entry.absPath,
          error: 'entry already rolled back by message truncate; restore the message first',
        }],
      };
    }

    // 先恢复成功再移除条目（失败时条目保留可重试）
    try {
      await this.restoreEntry(entry);
      removeEntryById(path, entryId);
      return { restored: [entry.absPath], remaining: this.countActive(path), failed: [] };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        restored: [],
        remaining: this.countActive(path),
        failed: [{ entryId: entry.id, absPath: entry.absPath, error: errMsg }],
      };
    }
  }

  clearSession(sessionId: string): void {
    this.ledger.clearSession(sessionId);
  }

  /**
   * 恢复单个历史条目（内部方法）。
   * - create：删除文件/目录（撤销创建）
   * - overwrite/edit/delete 文件：从备份原子写回原内容
   * - delete 目录：从 tar.gz 归档解包到原路径父目录
   */
  private async restoreEntry(entry: FileHistoryEntry): Promise<void> {
    if (entry.operation === 'move') {
      // 撤销移动：destPath → absPath 反向 rename（内容未变，无需备份）
      if (!entry.destPath) {
        throw new Error('move entry missing destPath');
      }
      if (!existsSync(entry.destPath)) {
        throw new Error(`moved destination missing: ${entry.destPath}`);
      }
      // source 位被占用时先移除（覆盖语义）
      if (existsSync(entry.absPath)) {
        const stat = statSync(entry.absPath);
        if (stat.isDirectory()) {
          rmSync(entry.absPath, { recursive: true, force: true });
        } else {
          unlinkSync(entry.absPath);
        }
      }
      mkdirSync(dirname(entry.absPath), { recursive: true });
      renameSync(entry.destPath, entry.absPath);
      return;
    }

    if (entry.operation === 'create') {
      // 撤销创建：删除文件或目录
      if (existsSync(entry.absPath)) {
        const stat = statSync(entry.absPath);
        if (stat.isDirectory()) {
          rmSync(entry.absPath, { recursive: true, force: true });
        } else {
          unlinkSync(entry.absPath);
        }
      }
      return;
    }

    // overwrite/edit/delete：从备份恢复
    if (!entry.backupPath) {
      throw new Error('no backup available for this entry');
    }

    if (!existsSync(entry.backupPath)) {
      throw new Error(`backup file not found: ${entry.backupPath}`);
    }

    // 目录归档 → tar.gz 解包恢复
    if (entry.isDirectory || entry.backupPath.endsWith('.tar.gz')) {
      const parentDir = dirname(entry.absPath);
      // 若原路径已被占用，先移除（覆盖语义）
      if (existsSync(entry.absPath)) {
        const stat = statSync(entry.absPath);
        if (stat.isDirectory()) {
          rmSync(entry.absPath, { recursive: true, force: true });
        } else {
          unlinkSync(entry.absPath);
        }
      }
      await extractArchive(entry.backupPath, parentDir);
      return;
    }

    // 文件 → 从 .bak 哈希备份恢复
    const content = readBackup(entry.backupPath);
    // 原子写回原路径（不保留 BOM，因为备份的是原始完整内容）
    atomicWriteFile(entry.absPath, content, {
      fsync: true,
      preserveMode: true,
      preserveBom: false, // 备份内容已含 BOM（如有），不重复添加
      mode: 0o644,
    });
  }

  /**
   * 启动时清理过期备份（>backupRetentionDays 天）。
   * 简单实现：遍历 backups 目录，stat mtime 超期则删除。
   */
  cleanupExpiredBackups(): void {
    if (!this.enabled || this.config.backupRetentionDays <= 0) return;
    if (!existsSync(this.backupDir)) return;

    const cutoff = Date.now() - this.config.backupRetentionDays * 24 * 60 * 60 * 1000;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs');
    let cleaned = 0;
    try {
      const entries = fs.readdirSync(this.backupDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const full = join(this.backupDir, ent.name);
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(full);
            cleaned++;
          }
        } catch {
          // 跳过单个文件失败
        }
      }
    } catch {
      // 目录读取失败，跳过
    }
    if (cleaned > 0) {
      this.logger.info('file-history: cleaned expired backups', { count: cleaned });
    }

    // 同时清理过期 trash 项（保留 TRASH_RETENTION_DAYS 天）
    try {
      const trashedRemoved = cleanupExpiredTrash(this.trashDir, TRASH_RETENTION_DAYS);
      if (trashedRemoved > 0) {
        this.logger.info('file-history: cleaned expired trash entries', { count: trashedRemoved });
      }
    } catch (err) {
      this.logger.warn('file-history: trash cleanup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 暴露 trashDir 路径，供 delete 工具调用 moveToTrash */
  getTrashDir(): string {
    return this.trashDir;
  }
}
