// src/modules/file-history/types.ts
// 三层文件历史架构类型定义。
// Layer 1: Track Edit（改前备份，同步阻塞）
// Layer 2: Snapshot（每轮 LLM 响应后异步快照）
// Layer 3: JSONL Transcript（append-only 持久化，支持 undo）

/** 文件变更操作类型（move=移动/重命名，undo 为反向 rename；terminal-change=终端命令检测到的无备份变更；'shell-change' 为旧值兼容读取） */
export type FileOperation = 'create' | 'overwrite' | 'edit' | 'delete' | 'move' | 'terminal-change' | 'shell-change';

/** 触发变更的工具名（rollback = 消息撤回联动回滚的 redo 备份条目；terminal = 终端命令快照检测；watch = 实时文件监控捕获的外部变更；'shell' 为旧值兼容读取） */
export type HistoryToolName = 'write' | 'edit' | 'delete' | 'rollback' | 'move' | 'copy' | 'terminal' | 'shell' | 'watch';

/**
 * 文件历史条目（JSONL 中每行一个）。
 * 每次文件变更经 track()/commit() 写入一条。
 */
export interface FileHistoryEntry {
  /** 条目唯一 ID（UUID） */
  id: string;
  /** 所属会话 ID */
  sessionId: string;
  /** 文件绝对路径 */
  absPath: string;
  /** 触发变更的工具调用 ID */
  toolCallId: string;
  /** 触发变更的工具名 */
  toolName: HistoryToolName;
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 变更操作类型 */
  operation: FileOperation;
  /** 变更前内容 sha256（新文件为 null） */
  hashBefore: string | null;
  /** 变更后内容 sha256（删除为 null） */
  hashAfter: string | null;
  /** 备份文件路径（新文件为 null） */
  backupPath: string | null;
  /** 变更前文件大小（字节，新文件为 0） */
  bytesBefore: number;
  /** 变更后文件大小（字节，删除为 0） */
  bytesAfter: number;
  /** unified diff 文本：overwrite/edit 为前后内容差异；create/delete 为全量新增/删除快照（可选） */
  diff?: string;
  /** 是否为目录操作（新增：true 时 backupPath 指向 .tar.gz，restoreEntry 走 extractArchive） */
  isDirectory?: boolean;
  /** move 操作的目标路径（operation='move' 时 undo = destPath → absPath 反向 rename） */
  destPath?: string;
  /** 消息撤回回滚标记（标记制：不物理删除条目；redo 恢复后清除，可无限次撤回/恢复循环） */
  rolledBackAt?: string;
  /** 仅 R 条目（toolName='rollback'）：指向被回滚的原始条目 id，redoRollback 成功后据此精确清除标记 */
  rollbackOf?: string;
}

/** 统一追踪请求：所有变更类型（write/edit/delete/move/copy/terminal）单一入口 */
export interface TrackRequest {
  /** 会话 ID */
  sessionId: string;
  /** 变更主路径（move = 源路径；copy = 副本目标路径；其余 = 变更文件路径） */
  absPath: string;
  /** 触发变更的工具名 */
  toolName: HistoryToolName;
  /** 触发变更的工具调用 ID */
  toolCallId?: string;
  /** move 的目标路径 */
  destPath?: string;
  /** 变更前字节数（move/copy 可选提供） */
  bytesBefore?: number;
  /** 是否目录操作（move/copy 可选提供） */
  isDirectory?: boolean;
  /** 终端快照检测分类（仅 toolName='terminal' 事后回填场景） */
  terminalKind?: 'created' | 'modified' | 'deleted';
  /** 终端命令执行前内容（读缓存命中时；null 表示不可得，undo 降级为提示不可恢复） */
  terminalBefore?: Buffer | null;
}

/** track() 返回的收据（原 TrackEditResult 泛化）：备份结果 + 条目登记要素 */
export interface TrackReceipt {
  /** 是否实际备份了（文件不存在、move/copy、禁用时为 false） */
  backedUp: boolean;
  /** 备份路径（~/.moss/file-history/backups/<hash>.bak 文件 或 ~/.moss/file-history/backups/<entryId>.tar.gz 目录） */
  backupPath: string | null;
  /** 原内容 sha256（新文件为空字符串；目录归档为空字符串） */
  hash: string;
  /** 原文件大小（字节，新文件为 0；目录为归档后 tar.gz 字节数） */
  bytesBefore: number;
  /** 历史条目 ID（用于 restore） */
  entryId: string;
  /** 变更操作类型 */
  operation: FileOperation;
  /** 是否为目录操作（true 时 backupPath 指向 .tar.gz，restoreEntry 走 extractArchive） */
  isDirectory?: boolean;
  /** 触发变更的工具调用 ID */
  toolCallId?: string;
  /** 触发变更的工具名 */
  toolName?: HistoryToolName;
}

/** commit() 的变更后状态描述 */
export interface TrackCompletion {
  /** 变更后内容 sha256（删除为空/缺省） */
  hashAfter?: string;
  /** 变更后字节数 */
  bytesAfter?: number;
  /** unified diff 文本（仅 overwrite/edit） */
  diff?: string;
}

/**
 * 统一变更追踪器：一个变更一个 tracker。
 * 协议：变更前 fh.track(req) → 执行变更 → tracker.commit(after)；
 * 变更失败时不调 commit 即丢弃（孤儿备份由 retention 回收）。
 * 终端命令场景为事后回填：track 携带 terminalBefore，commit 空参数登记。
 */
export interface ChangeTracker {
  /** 只读收据（工具返回 metadata 的 entryId/backedUp/backupPath 来源） */
  readonly receipt: TrackReceipt;
  /** 变更完成后登记历史条目（写 transcript）；transcriptEnabled=false 时 no-op */
  commit(after?: TrackCompletion): void;
}

/** undo 返回结果 */
export interface UndoResult {
  /** 已恢复的文件路径列表 */
  restored: string[];
  /** 剩余可撤销的历史条目数 */
  remaining: number;
  /** 撤销失败的条目（含错误信息） */
  failed: Array<{ entryId: string; absPath: string; error: string }>;
}

/** 净差异无法生成的原因 */
export type NetDiffReason =
  | 'before-unavailable'
  | 'after-unavailable'
  | 'binary'
  | 'too-large'
  | 'directory'
  | 'moved';

/**
 * 按文件聚合的净差异（「文件变更」面板主视图数据源）。
 * 表示「会话第一条变更前 → 当前磁盘状态」的最终差异，同一文件多次修改只产生一条。
 */
export interface NetFileChange {
  /** 文件绝对路径 */
  absPath: string;
  /** 净结果主导操作：create=会话内新建且仍存在；delete=最终不存在；edit=既有文件被改；move=路径变化 */
  operation: 'create' | 'edit' | 'delete' | 'move';
  /** unified diff（无法生成时缺省） */
  diff?: string;
  /** 新增行数 */
  added: number;
  /** 删除行数 */
  removed: number;
  /** 会话初始内容字节数（create 为 0） */
  bytesBefore: number;
  /** 当前内容字节数（delete 为 0） */
  bytesAfter: number;
  /** 无法生成净 diff 时的原因（二进制/超大/备份缺失等） */
  reason?: NetDiffReason;
  /** 该文件最后一条变更时间（ms；排序用） */
  lastTs: number;
  /** 该文件全部生效条目数（历史入口显示 N 次） */
  entryCount: number;
}

/**
 * 实时文件监控（FileWatchService）登记一次变更的请求。
 * before 非空时由 file-history 自动写入内容寻址备份，供净差异/undo 使用。
 */
export interface WatchChangeRequest {
  /** 会话 ID */
  sessionId: string;
  /** 文件绝对路径 */
  absPath: string;
  /** 变更类型 */
  operation: 'create' | 'edit' | 'delete';
  /** 变更前内容（create/无基线时为 null） */
  before: Buffer | null;
  /** 变更后内容（delete 时为 null） */
  after: Buffer | null;
  /** 已计算好的 unified diff（可选；调用方按体积限制决定是否生成） */
  diff?: string;
  /** 关联的工具调用 ID（可选） */
  toolCallId?: string;
}

/** 文件历史服务配置（config.fileHistory） */
export interface FileHistoryConfig {
  /** 全局开关，false 时所有工具的 trackHistory 行为被忽略 */
  enabled: boolean;
  /** 单文件最多保留 N 个备份（超出 LRU 清理） */
  maxBackupsPerFile: number;
  /** 是否写 JSONL transcript（false 时仅内存，重启丢失 undo 能力） */
  transcriptEnabled: boolean;
  /** 备份文件保留天数（启动时清理过期） */
  backupRetentionDays: number;
}

export const DEFAULT_FILE_HISTORY_CONFIG: FileHistoryConfig = {
  enabled: true,
  maxBackupsPerFile: 10,
  transcriptEnabled: true,
  backupRetentionDays: 30,
};
