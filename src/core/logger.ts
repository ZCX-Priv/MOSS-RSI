// src/core/logger.ts
// 分级日志服务：控制台 + 文件输出，支持 scope 前缀。
// 文件写入：appendFileSync 同步追加（永不覆盖、进程退出不丢数据），
// 支持按天滚动、单文件大小上限滚动、过期自动清理、查询过滤。
//
// 历史教训：此前用 Bun.write(Bun.file(path, { create: true }), line) 写日志，
// Bun.write 是覆盖写入（截断后写），导致每次写日志清空整个文件，
// 日志文件最终只剩 0~1 条残缺记录。切勿回退到该写法。

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Environment,
  LogFileInfo,
  Logger,
  LogLevel,
  LogQueryOptions,
  LogQueryResult,
  LogService,
} from './types';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',   // 灰
  info: '\x1b[36m',    // 青
  warn: '\x1b[33m',    // 黄
  error: '\x1b[31m',   // 红
  fatal: '\x1b[35m',   // 紫
};
const RESET = '\x1b[0m';

interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
  context?: Record<string, unknown>;
}

/** 日志行解析：`<ts> <LEVEL padEnd5> [<scope>] <message> [context-json]` */
const LOG_LINE_RE = /^(\S+)\s+(DEBUG|INFO|WARN|ERROR|FATAL)\s*\[([^\]]*)\]\s?(.*)$/;
/** 合法日志文件名：moss-YYYY-MM-DD.log 或 moss-YYYY-MM-DD-N.log */
const LOG_FILE_RE = /^moss-\d{4}-\d{2}-\d{2}(?:-\d+)?\.log$/;

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 14;

// 日志落盘策略：内存聚合 + 50ms 防抖批量异步写。
// 原实现每行 appendFileSync（open/write/close），在 Windows 低配机 + 杀毒软件下
// 单行可达 80~130ms，启动阶段 40+ 行日志就是数秒的同步阻塞。
const FLUSH_DELAY_MS = 50;
/** 单批写入硬上限：超过立即 flush，防内存无界增长 */
const FLUSH_MAX_BYTES = 256 * 1024;

/** 本地日期 YYYY-MM-DD（文件名与行内时间戳统一本地时区，字典序可排序） */
function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 本地时间戳 YYYY-MM-DDTHH:mm:ss.SSS */
function localTimestamp(d: Date = new Date()): string {
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${localDate(d)}T${h}:${mi}:${s}.${ms}`;
}

// ============================================================================
// FileLogWriter：同步追加 + 滚动 + 清理 + 查询
// ============================================================================

export interface LogPolicy {
  /** 单文件大小上限（字节） */
  maxFileBytes: number;
  /** 过期保留天数 */
  retentionDays: number;
}

export class FileLogWriter {
  private readonly logsDir: string;
  private policy: LogPolicy;
  private currentDate = '';
  private currentSeq = 0;
  private currentFile = '';
  private currentSize = 0;
  private failureReported = false;
  /** 待写日志行（内存聚合） */
  private pending = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** 异步写串行链：保证同一文件的行序不被打乱 */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(logsDir: string, policy: Partial<LogPolicy> = {}) {
    this.logsDir = logsDir;
    this.policy = {
      maxFileBytes: policy.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      retentionDays: policy.retentionDays ?? DEFAULT_RETENTION_DAYS,
    };
    try {
      // 目录通常已存在：避免每次启动无条件 mkdirSync 的系统调用
      if (!existsSync(this.logsDir)) mkdirSync(this.logsDir, { recursive: true });
    } catch (err) {
      this.reportFailure('mkdir', err);
    }
    this.currentDate = localDate();
    this.openFile();
  }

  /** 运行期更新策略（config 热更新） */
  setPolicy(policy: Partial<LogPolicy>): void {
    if (policy.maxFileBytes !== undefined && policy.maxFileBytes > 0) {
      this.policy.maxFileBytes = policy.maxFileBytes;
    }
    if (policy.retentionDays !== undefined && policy.retentionDays > 0) {
      this.policy.retentionDays = policy.retentionDays;
    }
  }

  getRetentionDays(): number {
    return this.policy.retentionDays;
  }

  /** 追加一行日志（内存聚合，50ms 防抖批量异步落盘；不再逐行同步 open/write/close） */
  append(line: string): void {
    this.pending += line;
    if (Buffer.byteLength(this.pending, 'utf8') >= FLUSH_MAX_BYTES) {
      this.flushAsync();
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushAsync();
      }, FLUSH_DELAY_MS);
    }
  }

  /** 异步批量刷盘：单条串行链保证日志行序 */
  flushAsync(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const chunk = this.pending;
    this.pending = '';
    if (!chunk) return;
    this.writeChain = this.writeChain
      .then(() => this.writeChunk(chunk))
      .catch((err) => {
        this.reportFailure('append', err);
      });
  }

  private async writeChunk(chunk: string): Promise<void> {
    const bytes = Buffer.byteLength(chunk, 'utf8');
    const today = localDate();
    if (today !== this.currentDate) {
      // 跨天：切换新文件；过期日志清理延后到空闲，避免阻塞写盘
      this.currentDate = today;
      this.openFile();
      setTimeout(() => {
        try {
          this.cleanup(this.policy.retentionDays);
        } catch {
          // 清理失败不影响写日志
        }
      }, 0);
    } else if (this.currentSize + bytes > this.policy.maxFileBytes) {
      // 超限：滚动到下一序号文件
      this.currentSeq += 1;
      this.openFile();
    }
    await appendFile(this.currentFile, chunk, 'utf8');
    this.currentSize += bytes;
  }

  /** 等待已排队日志全部落盘（优雅停机用） */
  async flush(): Promise<void> {
    this.flushAsync();
    await this.writeChain;
  }

  /** 退出路径同步刷盘（进程即将结束，不能 await） */
  flushSync(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const chunk = this.pending;
    this.pending = '';
    if (!chunk) return;
    try {
      const bytes = Buffer.byteLength(chunk, 'utf8');
      const today = localDate();
      if (today !== this.currentDate) {
        this.currentDate = today;
        this.openFile();
      } else if (this.currentSize + bytes > this.policy.maxFileBytes) {
        this.currentSeq += 1;
        this.openFile();
      }
      appendFileSync(this.currentFile, chunk, 'utf8');
      this.currentSize += bytes;
    } catch (err) {
      this.reportFailure('append', err);
    }
  }

  /** 删除超过保留期的日志文件，返回删除数 */
  cleanup(retentionDays: number): number {
    try {
      const names = readdirSync(this.logsDir);
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      let removed = 0;
      for (const name of names) {
        if (!LOG_FILE_RE.test(name)) continue;
        const full = join(this.logsDir, name);
        try {
          const st = statSync(full);
          if (st.mtimeMs < cutoff) {
            unlinkSync(full);
            removed += 1;
          }
        } catch {
          // 单文件失败跳过
        }
      }
      return removed;
    } catch {
      return 0;
    }
  }

  cleanupNow(): number {
    return this.cleanup(this.policy.retentionDays);
  }

  /** 列出全部日志文件（mtime 降序 = 最新优先） */
  getLogFiles(): LogFileInfo[] {
    try {
      const names = readdirSync(this.logsDir).filter((n) => LOG_FILE_RE.test(n));
      const files: LogFileInfo[] = [];
      for (const name of names) {
        try {
          const st = statSync(join(this.logsDir, name));
          files.push({ name, size: st.size, mtime: st.mtimeMs });
        } catch {
          // 跳过不可 stat 的文件
        }
      }
      files.sort((a, b) => b.mtime - a.mtime);
      return files;
    } catch {
      return [];
    }
  }

  /** 读取并过滤日志行（最新优先）。文件名经白名单校验防路径穿越。 */
  readLogs(opts: LogQueryOptions): LogQueryResult {
    const file = opts.file ?? this.pickDefaultFile();
    if (!file || !LOG_FILE_RE.test(file)) return { lines: [], total: 0 };
    const full = join(this.logsDir, file);
    if (!existsSync(full)) return { lines: [], total: 0 };

    let text: string;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      return { lines: [], total: 0 };
    }

    let lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    // 文件内正序 → 反转为最新优先
    lines.reverse();

    if (opts.minLevel) {
      const minOrder = LEVEL_ORDER[opts.minLevel] ?? 0;
      lines = lines.filter((l) => {
        const m = LOG_LINE_RE.exec(l);
        if (!m) return false; // 无法解析级别的行在级别过滤时排除
        const level = m[2].toLowerCase() as LogLevel;
        return (LEVEL_ORDER[level] ?? 0) >= minOrder;
      });
    }
    if (opts.search) {
      const q = opts.search.toLowerCase();
      lines = lines.filter((l) => l.toLowerCase().includes(q));
    }

    const total = lines.length;
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);
    return { lines: lines.slice(offset, offset + limit), total };
  }

  private pickDefaultFile(): string | null {
    const files = this.getLogFiles();
    return files.length > 0 ? files[0].name : null;
  }

  /** 打开（或切换）当前写入文件：序号=当天已有最大序号，大小 statSync 实际校准 */
  private openFile(): void {
    this.currentSeq = this.scanMaxSeq(this.currentDate);
    this.currentFile = join(this.logsDir, this.fileName(this.currentDate, this.currentSeq));
    try {
      const st = statSync(this.currentFile);
      this.currentSize = st.size;
    } catch {
      this.currentSize = 0;
    }
  }

  private scanMaxSeq(date: string): number {
    let max = 0;
    try {
      for (const name of readdirSync(this.logsDir)) {
        const m = /^moss-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.log$/.exec(name);
        if (m && m[1] === date) {
          const seq = m[2] ? parseInt(m[2], 10) : 0;
          if (seq > max) max = seq;
        }
      }
    } catch {
      // 目录读取失败按 0 处理
    }
    return max;
  }

  private fileName(date: string, seq: number): string {
    return seq > 0 ? `moss-${date}-${seq}.log` : `moss-${date}.log`;
  }

  /** 写入失败一次性 stderr 告警（绝不调 logger 自身，防死循环） */
  private reportFailure(op: string, err: unknown): void {
    if (this.failureReported) return;
    this.failureReported = true;
    const msg = err instanceof Error ? err.message : String(err);
    try {
      process.stderr.write(`[logger] file ${op} failed: ${msg} (further errors suppressed)\n`);
    } catch {
      // 连 stderr 都失败则彻底静默
    }
  }
}

// ============================================================================
// ConsoleSink：控制台输出降载
// ============================================================================

/**
 * 控制台输出策略：
 * - 启动阶段（kernel 显式 startBuffering）先缓存 info/debug，ready 后一次性输出，
 *   避免 Windows 控制台逐行同步输出拖慢启动；
 * - 非 TTY（后台守护进程 stdio=ignore）默认丢弃 info/debug，只保留 warn/error；
 * - MOSS_STARTUP_QUIET=1 时只输出 warn/error/fatal。
 */
export class ConsoleSink {
  private buffered = false;
  private buffer: string[] = [];
  private readonly nonTty: boolean;
  private readonly quiet: boolean;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.nonTty = !process.stdout.isTTY;
    this.quiet = process.env.MOSS_STARTUP_QUIET === '1';
  }

  startBuffering(): void {
    if (this.buffered) return;
    this.buffered = true;
    // 兜底：即便 kernel 未走到 ready 也不会永久吞掉启动日志
    this.safetyTimer = setTimeout(() => this.flush(), 2000);
  }

  flush(): void {
    if (this.safetyTimer !== null) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
    if (!this.buffered && this.buffer.length === 0) return;
    this.buffered = false;
    if (this.buffer.length === 0) return;
    const lines = this.buffer;
    this.buffer = [];
    try {
      process.stdout.write(lines.join('\n') + '\n');
    } catch {
      // 控制台不可用（无 stdout）时静默
    }
  }

  write(line: string, level: LogLevel): void {
    const important = level === 'warn' || level === 'error' || level === 'fatal';
    if (this.quiet && !important) return;
    if (this.buffered) {
      this.buffer.push(line);
      return;
    }
    if (this.nonTty && !important) return;
    if (level === 'error' || level === 'fatal') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

// ============================================================================
// LoggerImpl
// ============================================================================

class LoggerImpl implements Logger {
  private level: LogLevel;
  private readonly scope: string;
  private readonly env: Environment;
  private readonly fileWriter: FileLogWriter;
  private readonly colorize: boolean;
  private readonly consoleSink: ConsoleSink;

  constructor(
    env: Environment,
    scope: string,
    level: LogLevel,
    fileWriter: FileLogWriter,
    colorize: boolean,
    consoleSink: ConsoleSink,
  ) {
    this.env = env;
    this.scope = scope;
    this.level = level;
    this.fileWriter = fileWriter;
    this.colorize = colorize;
    this.consoleSink = consoleSink;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  child(scope: string): Logger {
    // 子 scope 用 '/' 分层
    return new LoggerImpl(
      this.env,
      this.scope ? `${this.scope}/${scope}` : scope,
      this.level,
      this.fileWriter,
      this.colorize,
      this.consoleSink,
    );
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;
    const entry: LogEntry = {
      ts: localTimestamp(),
      level,
      scope: this.scope,
      message,
      context,
    };
    this.writeConsole(entry);
    this.writeToFile(entry);
  }

  private writeConsole(entry: LogEntry): void {
    const color = this.colorize ? LEVEL_COLORS[entry.level] : '';
    const reset = this.colorize ? RESET : '';
    const scopeStr = entry.scope ? `[${entry.scope}]` : '';
    const ctxStr = entry.context ? ' ' + JSON.stringify(entry.context) : '';
    const line = `${color}${entry.ts}${reset} ${color}${entry.level.toUpperCase().padEnd(5)}${reset} ${scopeStr} ${entry.message}${ctxStr}`;
    this.consoleSink.write(line, entry.level);
  }

  private writeToFile(entry: LogEntry): void {
    const line =
      `${entry.ts} ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.message}` +
      (entry.context ? ' ' + JSON.stringify(entry.context) : '') +
      '\n';
    this.fileWriter.append(line);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context);
  }
  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }
  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context);
  }
  error(message: string, context?: Record<string, unknown>): void {
    this.write('error', message, context);
  }
  fatal(message: string, context?: Record<string, unknown>): void {
    this.write('fatal', message, context);
  }
}

// ============================================================================
// LogService：暴露给 server 路由的查询/清理/级别能力
// ============================================================================

class LogServiceImpl implements LogService {
  private readonly writer: FileLogWriter;
  private readonly logger: Logger;

  constructor(writer: FileLogWriter, logger: Logger) {
    this.writer = writer;
    this.logger = logger;
  }

  getLogFiles(): LogFileInfo[] {
    return this.writer.getLogFiles();
  }

  readLogs(opts: LogQueryOptions): LogQueryResult {
    return this.writer.readLogs(opts);
  }

  cleanupNow(): number {
    return this.writer.cleanupNow();
  }

  setLevel(level: LogLevel): void {
    this.logger.setLevel(level);
  }

  getLevel(): LogLevel {
    return this.logger.getLevel();
  }
}

// ============================================================================
// 工厂
// ============================================================================

export interface RootLogger {
  logger: Logger;
  /** 供 kernel 注册为 kernel.logger 服务 */
  service: LogService;
  /** 供 kernel 应用 config.logs 策略（保留天数 / 大小上限） */
  writer: FileLogWriter;
  /** 控制台输出缓冲（启动阶段缓存、ready 后一次性输出） */
  console: ConsoleSink;
}

/** 进程退出兜底：确保已产生的日志不丢（只注册一次） */
let exitFlushRegisteredWriter: FileLogWriter | null = null;

/**
 * 创建根日志器：控制台彩色输出 + 内存聚合异步追加文件（按天/大小滚动）。
 */
export function createRootLogger(
  env: Environment,
  initialLevel: LogLevel = 'info',
): RootLogger {
  const writer = new FileLogWriter(env.logsDir);
  const colorize = env.isWindows ? process.stdout.isTTY ?? false : true;
  const consoleSink = new ConsoleSink();
  const logger = new LoggerImpl(env, '', initialLevel, writer, colorize, consoleSink);
  if (exitFlushRegisteredWriter !== writer) {
    exitFlushRegisteredWriter = writer;
    process.on('exit', () => {
      try {
        writer.flushSync();
      } catch {
        // 退出路径不再抛错
      }
    });
  }
  return { logger, service: new LogServiceImpl(writer, logger), writer, console: consoleSink };
}
