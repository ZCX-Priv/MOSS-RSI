// src/modules/filesys/types.ts
// filesys 虚拟文件系统：统一所有模块对文件系统的操作（读缓存/roots/原子写/事件/存储 IO）。
// 职责边界：filesys = IO + 缓存 + 哈希 + 事件；file-history = 备份 + transcript（工具层编排）。

import type { FileContentKind } from '../../utils/fs';

// ============================================================================
// 配置（config.filesys）
// ============================================================================

/** 终端命令前后快照检测配置 */
export interface TerminalWatchConfig {
  /** 是否启用终端命令执行前后工作区变更检测 */
  enabled: boolean;
  /** 快照最大文件数（超出跳过本次检测，防止大仓库性能问题） */
  maxFiles: number;
  /** diff 阶段超时（毫秒），超时返回已检出部分 */
  timeoutMs: number;
}

/** filesys 服务配置（config.filesys） */
export interface FilesysConfig {
  /** 额外授权根目录（绝对路径；cwd 始终是隐含 root，空数组 = 行为与旧版一致） */
  roots: string[];
  /** 缓存总字节上限 */
  cacheMaxBytes: number;
  /** 缓存条目数上限 */
  cacheMaxEntries: number;
  /** 单文件超过此字节数不缓存内容（仅缓存派生值），防大文件挤爆预算 */
  cacheMaxFileBytes: number;
  /** 终端快照检测配置 */
  terminalWatch: TerminalWatchConfig;
}

export const DEFAULT_FILESYS_CONFIG: FilesysConfig = {
  roots: [],
  cacheMaxBytes: 64 * 1024 * 1024,
  cacheMaxEntries: 2048,
  cacheMaxFileBytes: 4 * 1024 * 1024,
  terminalWatch: { enabled: true, maxFiles: 20_000, timeoutMs: 3000 },
};

// ============================================================================
// 读写结果
// ============================================================================

/** readFile 结果：一次磁盘 I/O 派生全部数据（缓存命中则零 I/O） */
export interface ReadFileResult {
  absPath: string;
  /** 磁盘原始字节（含 BOM） */
  rawBuffer: Buffer;
  /** sha256(rawBuffer) —— 全项目统一哈希规范：一律对原始字节计算 */
  sha256: string;
  /** 内容分类（utf8 / legacy-text / binary） */
  kind: FileContentKind;
  size: number;
  mtimeMs: number;
  /** 诊断：本次读取是否命中缓存 */
  fromCache: boolean;
}

export interface WriteFileOptions {
  /** 乐观锁：与磁盘当前 sha256(rawBuffer) 比对，不等拒绝写入 */
  expectHash?: string;
  /** 目标目录不存在时递归创建（默认 true） */
  createDirs?: boolean;
  /** 是否 fsync 刷盘（默认 true） */
  fsync?: boolean;
  /** 是否保留原文件 BOM（默认 true，与 write 工具流式路径行为一致） */
  preserveBom?: boolean;
  /** 变更来源（'write'|'edit'|'move'|'copy'|'internal'…），事件溯源必传 */
  source: string;
  sessionId?: string;
  toolCallId?: string;
}

export type WriteFileResult =
  | {
      ok: true;
      absPath: string;
      /** 写入后磁盘内容哈希（含被保留的 BOM） */
      sha256: string;
      bytes: number;
      mtimeMs: number;
    }
  | {
      ok: false;
      /** 'hash-mismatch' | 'io-error' */
      reason: 'hash-mismatch' | 'io-error';
      /** hash-mismatch 时磁盘当前哈希（提示重新 read） */
      currentHash?: string;
      message: string;
    };

// ============================================================================
// 变更事件
// ============================================================================

export type FileChangeKind = 'created' | 'edited' | 'deleted' | 'moved' | 'terminal-changed';

export interface TerminalChangeReport {
  /** 终端命令执行后新增的文件 */
  created: string[];
  /** 修改的文件 */
  modified: string[];
  /** 删除的文件 */
  deleted: string[];
  /** 成功用缓存回填备份、可完整 undo 的条目数 */
  undone: number;
  /** 文件数超限，本次检测被跳过 */
  skipped: boolean;
  /** diff 超时，返回已检出部分 */
  truncated: boolean;
}

export interface FileChangeEvent {
  kind: FileChangeKind;
  absPath: string;
  /** moved 时的目标路径 */
  destPath?: string;
  /** 变更来源（工具名 / 'terminal' / 'internal'） */
  source: string;
  sessionId?: string;
  toolCallId?: string;
  /** kind='terminal-changed' 时携带变更报告 */
  report?: TerminalChangeReport;
}

// ============================================================================
// 终端命令快照
// ============================================================================

export interface TerminalSnapshot {
  /** 参与快照的根目录 */
  roots: string[];
  /** 执行前 stat 清单（path → mtime/size） */
  entries: Map<string, { mtimeMs: number; size: number }>;
}

// ============================================================================
// 服务接口
// ============================================================================

/**
 * 统一文件系统服务（由 filesys 模块注册，ServiceNames.FILESYS）。
 * 所有 builtin 文件工具（read/edit/write/grep/glob/delete/move/copy）与内部存储统一经此操作磁盘。
 */
export interface FilesysService {
  /**
   * roots 解析：相对路径基于 cwd；绝对路径必须落在 cwd 或任一授权 root 内，越界返回 null。
   * （extraRoots 为空时行为与旧版 resolveWithinCwd 完全一致）
   */
  resolve(rawPath: string, cwd: string): string | null;

  /**
   * 读取文件：缓存命中（mtime/size 双字段校验）零磁盘 I/O；未命中一次读盘派生
   * rawBuffer/sha256/kind 全部数据。文件不存在或 stat 失败返回 null。
   */
  readFile(absPath: string): ReadFileResult | null;

  /**
   * 写入文件：BOM 保留 + 原子写（tmp+fsync+rename）+ 乐观锁 + 缓存更新 + 变更事件。
   * 成功后缓存持有新内容（写后紧跟的 read/edit expectHash 免读盘）。
   */
  writeFile(absPath: string, data: string | Buffer, opts: WriteFileOptions): WriteFileResult;

  /** 取文件哈希（缓存优先；缓存未命中读盘计算并缓存派生值）。不存在返回 null。 */
  hashFile(absPath: string): { sha256: string; size: number; mtimeMs: number } | null;

  /**
   * 登记"绕过 writeFile 的外部写入"（如 write 工具的大文件流式路径）：
   * 用调用方提供的磁盘真实哈希更新缓存派生值（不缓存 buffer）并发出变更事件。
   */
  recordExternalWrite(
    absPath: string,
    meta: { sha256: string; bytes: number; kind?: 'utf8' | 'legacy-text' | 'binary' },
    opts: { source: string; sessionId?: string; toolCallId?: string; existed: boolean },
  ): void;

  /** 变更事件订阅（engine 转 WS 推送用），返回取消订阅函数 */
  onFileChange(handler: (e: FileChangeEvent) => void): () => void;

  /** 发出变更事件（供 delete/move 等不经过 writeFile 的操作使用） */
  emitChange(event: FileChangeEvent): void;

  /** 当前生效的授权 roots（含归一化：绝对路径 + 必须存在） */
  listRoots(): string[];

  /** 终端命令执行前快照（禁用或超限返回 null）。 */
  beginTerminalSnapshot(cwd: string): Promise<TerminalSnapshot | null>;

  /** 终端命令执行后 diff + 缓存回填备份 + 发 terminal-changed 事件 */
  endTerminalSnapshot(snap: TerminalSnapshot, sessionId: string, toolCallId: string): Promise<TerminalChangeReport | null>;

  /** 缓存诊断信息 */
  cacheStats(): { entries: number; bytes: number };
}