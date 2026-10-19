// src/modules/terminal/service.ts
// 持久终端管理器：原生 PTY（Bun.spawn({ terminal })）承载交互式终端；PTY 不可用时回退管道模式。
// - 人类（WS）与 agent（terminal 工具）共用同一批终端；
// - 每个终端维护输出环形缓冲，供订阅/重连复原与 agent read；
// - 输出经注入的 emitter 按会话路由到 WS 订阅者。

import { t } from '../../core/i18n';
import type { Logger } from '../../core/types';
import { resolveInterpreter, makeMarker, type InteractiveInterpreter } from './interpreter';
import { TerminalPersistence, type PersistedTerminal } from './persistence';
import { stripAnsi, cleanRunOutput } from './clean-output';
import {
  TERMINAL_LIMITS,
  type InterpreterKind,
  type TerminalCreateOptions,
  type TerminalInfo,
  type TerminalRunResult,
  type TerminalService,
} from './types';

/** Bun.spawn 返回的子进程最小结构 */
interface SubprocessLike {
  pid: number;
  exited: Promise<number>;
  kill: (signal?: string | number) => void;
  stdin: { write(data: string | Uint8Array): number | void } | null;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
}

/** Bun.Terminal 最小结构（Bun ≥ 1.3.14 Windows ConPTY / ≥ 1.3.5 POSIX） */
interface PtyLike {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface PtyCtor {
  new (opts: {
    cols: number;
    rows: number;
    data: (term: unknown, data: Uint8Array) => void;
    exit?: (term: unknown, code: number, signal: number | null) => void;
  }): PtyLike;
}

interface Waiter {
  marker: string;
  start: number;
  resolve: (r: { output: string; found: boolean; exitCode?: number }) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Runtime {
  info: TerminalInfo;
  proc: SubprocessLike | null;
  pty: PtyLike | null;
  interpreter: InteractiveInterpreter;
  decoder: TextDecoder;
  buffer: string;
  waiters: Set<Waiter>;
  closed: boolean;
}

/** 输出投递函数（按会话路由到 WS 订阅者） */
export type TerminalEmitter = (sessionId: string, message: Record<string, unknown>) => void;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** 转义正则元字符 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 标记与状态 token 之间可能插入的 ANSI CSI 序列（ConPTY 常见） */
const ANSI_CSI = '(?:\\u001b\\[[0-9;?]*[A-Za-z])*';
/** 状态 token：整数（bash $? / cmd %errorlevel% / PS 数值）或 True/False（PS $?） */
const SENTINEL_TOKEN = '(True|False|-?\\d+)(?!\\d)';

/** 状态 token → 退出码（解析不到返回 undefined） */
function tokenToExitCode(token: string): number | undefined {
  if (/^-?\d+$/.test(token)) return parseInt(token, 10);
  if (token === 'True') return 0;
  if (token === 'False') return 1;
  return undefined;
}

export class TerminalManager implements TerminalService {
  private readonly runtimes = new Map<string, Runtime>();
  /** 会话默认终端 id（terminal 工具缺省执行时复用；人类创建不受影响） */
  private readonly defaultIds = new Map<string, string>();
  private readonly emit: TerminalEmitter;
  private readonly logger: Logger;
  private readonly isWindows: boolean;
  /** 落盘存储（元数据 + 输出缓冲）：进程重启后 list/snapshot 仍可还原（离线只读） */
  private readonly storage: TerminalPersistence;

  constructor(deps: { emitter: TerminalEmitter; logger: Logger; isWindows: boolean; dataDir: string }) {
    this.emit = deps.emitter;
    this.logger = deps.logger;
    this.isWindows = deps.isWindows;
    this.storage = new TerminalPersistence(deps.dataDir);
    this.storage.loadAll();
  }

  async create(opts: TerminalCreateOptions): Promise<TerminalInfo> {
    const live = this.liveInfos(opts.sessionId);
    if (live.length >= TERMINAL_LIMITS.maxPerSession) {
      throw new Error(t('terminal.tooManyPerSession', { max: TERMINAL_LIMITS.maxPerSession }));
    }

    const interpreter = resolveInterpreter(this.isWindows, opts.interpreter);
    const cols = clamp(Math.floor(opts.cols ?? TERMINAL_LIMITS.defaultCols), 20, 500);
    const rows = clamp(Math.floor(opts.rows ?? TERMINAL_LIMITS.defaultRows), 5, 200);
    const cwd = opts.cwd && opts.cwd.trim() ? opts.cwd : process.cwd();
    const id = `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const index = live.length + 1;

    const ptyCtor = (Bun as unknown as { Terminal?: PtyCtor }).Terminal;
    const usePty = typeof ptyCtor === 'function';
    const creator = opts.creator ?? 'user';

    const info: TerminalInfo = {
      id,
      sessionId: opts.sessionId,
      title: opts.title?.trim() || `${creator === 'ai' ? '[AI] ' : ''}${interpreter.label} ${index}`,
      interpreterLabel: interpreter.label,
      interpreterKind: interpreter.kind,
      creator,
      cwd,
      running: true,
      exitCode: null,
      createdAt: Date.now(),
      pty: usePty,
    };

    const rt: Runtime = {
      info,
      proc: null,
      pty: null,
      interpreter,
      decoder: new TextDecoder('utf-8', { fatal: false }),
      buffer: '',
      waiters: new Set(),
      closed: false,
    };

    const env = this.buildEnv();
    try {
      if (usePty && ptyCtor) {
        const pty = new ptyCtor({
          cols,
          rows,
          data: (_term, data) => this.onData(rt, data),
          exit: (_term, code) => this.onExit(rt, code),
        });
        rt.pty = pty;
        rt.proc = this.spawn([interpreter.bin, ...interpreter.args], { cwd, env, terminal: pty });
      } else {
        const proc = this.spawn([interpreter.bin, ...interpreter.args], {
          cwd,
          env,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          windowsHide: true,
        });
        rt.proc = proc;
        this.pump(proc.stdout, rt);
        this.pump(proc.stderr, rt);
      }
    } catch (err) {
      throw new Error(
        t('terminal.spawnFailed', { message: err instanceof Error ? err.message : String(err) }),
      );
    }

    this.runtimes.set(id, rt);
    void rt.proc.exited.then((code) => this.onExit(rt, code)).catch(() => this.onExit(rt, -3));

    // 输出编码初始化（cmd/powershell 中文防乱码）
    if (interpreter.encodingInit) this.submit(rt, interpreter.encodingInit);

    this.logger.info(t('terminal.created'), {
      id,
      sessionId: opts.sessionId,
      interpreter: interpreter.bin,
      pty: usePty,
    });
    this.emit(opts.sessionId, {
      type: 'terminal.created',
      sessionId: opts.sessionId,
      payload: { terminal: rt.info },
    });
    this.persistNow(opts.sessionId);
    return rt.info;
  }

  /** 会话默认终端：存在且未关闭则复用；否则按 opts 创建并记为默认 */
  async ensureDefault(opts: TerminalCreateOptions): Promise<TerminalInfo> {
    const id = this.defaultIds.get(opts.sessionId);
    const rt = id ? this.runtimes.get(id) : undefined;
    if (rt && !rt.closed) return rt.info;
    const info = await this.create({ ...opts, creator: opts.creator ?? 'ai' });
    this.defaultIds.set(opts.sessionId, info.id);
    return info;
  }

  /** 重启默认终端：关闭旧默认（若有）后重新创建，并记为默认 */
  async restartDefault(opts: TerminalCreateOptions): Promise<TerminalInfo> {
    const prev = this.defaultIds.get(opts.sessionId);
    if (prev) {
      this.close(prev);
      this.defaultIds.delete(opts.sessionId);
    }
    const info = await this.create({ ...opts, creator: opts.creator ?? 'ai' });
    this.defaultIds.set(opts.sessionId, info.id);
    return info;
  }

  getDefaultId(sessionId: string): string | undefined {
    return this.defaultIds.get(sessionId);
  }

  /** 广播 terminal.focus（前端据此同步聚焦终端标签） */
  focus(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    this.emit(rt.info.sessionId, {
      type: 'terminal.focus',
      sessionId: rt.info.sessionId,
      payload: { terminalId: id, sessionId: rt.info.sessionId },
    });
  }

  write(id: string, data: string): boolean {
    const rt = this.runtimes.get(id);
    if (!rt || rt.closed) return false;
    if (rt.pty) {
      rt.pty.write(data);
      return true;
    }
    const stdin = rt.proc?.stdin;
    if (!stdin) return false;
    stdin.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const rt = this.runtimes.get(id);
    if (!rt || rt.closed || !rt.pty) return false;
    try {
      rt.pty.resize(clamp(Math.floor(cols), 20, 500), clamp(Math.floor(rows), 5, 200));
      return true;
    } catch {
      return false;
    }
  }

  close(id: string): boolean {
    const rt = this.runtimes.get(id);
    if (!rt) {
      // 离线历史项：仅清除落盘条目，并通知前端移除标签
      const persisted = this.storage.getById(id);
      if (!persisted) return false;
      const sid = persisted.info.sessionId;
      this.storage.save(sid, this.snapshotEntries(sid).filter((e) => e.info.id !== id));
      this.emit(sid, { type: 'terminal.closed', sessionId: sid, payload: { terminalId: id, sessionId: sid } });
      return true;
    }
    rt.closed = true;
    for (const w of Array.from(rt.waiters)) {
      clearTimeout(w.timer);
      rt.waiters.delete(w);
      w.resolve({ output: rt.buffer.slice(w.start), found: false });
    }
    try {
      rt.proc?.kill();
    } catch {
      /* 进程可能已退出 */
    }
    try {
      rt.pty?.close();
    } catch {
      /* 静默 */
    }
    this.runtimes.delete(id);
    // 同步清除落盘条目（关闭后刷新不应复活该标签）；同时并入其余在线终端的最新缓冲
    this.storage.save(
      rt.info.sessionId,
      this.snapshotEntries(rt.info.sessionId).filter((e) => e.info.id !== id),
    );
    // 若关闭的是会话默认终端，同步清掉默认登记（下次 ensureDefault 会重建）
    if (this.defaultIds.get(rt.info.sessionId) === id) {
      this.defaultIds.delete(rt.info.sessionId);
    }
    this.emit(rt.info.sessionId, {
      type: 'terminal.closed',
      sessionId: rt.info.sessionId,
      payload: { terminalId: id, sessionId: rt.info.sessionId },
    });
    return true;
  }

  get(id: string): TerminalInfo | undefined {
    return this.runtimes.get(id)?.info;
  }

  list(sessionId: string): TerminalInfo[] {
    const live = this.liveInfos(sessionId);
    const liveIds = new Set(live.map((t) => t.id));
    // 后端已不知道的旧终端（进程重启）：保留为离线只读历史项，标签与历史不丢
    const dead: TerminalInfo[] = this.storage
      .list(sessionId)
      .filter((e) => !liveIds.has(e.info.id))
      .map((e) => ({ ...e.info, running: false, exitCode: null, offline: true }));
    return [...live, ...dead].sort((a, b) => a.createdAt - b.createdAt);
  }

  snapshot(id: string): string | undefined {
    const live = this.runtimes.get(id)?.buffer;
    if (live !== undefined) return live;
    // 离线历史项：回放落盘缓冲（刷新/后端重启后仍能看到历史输出）
    return this.storage.getById(id)?.buffer;
  }

  async run(id: string, command: string, timeoutMs?: number): Promise<TerminalRunResult> {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error(t('terminal.notFound', { id }));
    if (!command || !command.trim()) throw new Error(t('terminal.commandRequired'));
    if (rt.closed) {
      return { output: stripAnsi(rt.buffer), info: rt.info, completed: false };
    }

    const timeout = clamp(Math.floor(timeoutMs ?? TERMINAL_LIMITS.defaultTimeoutMs), 1000, 600_000);
    const marker = makeMarker();
    const start = rt.buffer.length;

    const res = await new Promise<{ output: string; found: boolean; exitCode?: number }>((resolve) => {
      const waiter: Waiter = {
        marker,
        start,
        resolve: (r) => resolve(r),
        timer: setTimeout(() => {
          rt.waiters.delete(waiter);
          // 超时：向终端发送 Ctrl+C 中断当前命令（避免卡死命令长期占用默认终端）；管道回退下无信号语义，尽力而为
          try {
            this.write(id, '\u0003');
          } catch {
            /* 静默 */
          }
          resolve({ output: rt.buffer.slice(start), found: false });
        }, timeout),
      };
      rt.waiters.add(waiter);
      try {
        this.submit(rt, command);
        this.submit(rt, rt.interpreter.markerCommand(marker));
      } catch {
        // 提交失败（PTY/管道已关闭等中断场景）：立即以「未完成」收尾，避免空等到超时
        clearTimeout(waiter.timer);
        rt.waiters.delete(waiter);
        resolve({ output: rt.buffer.slice(start), found: false });
      }
    });

    // 清洗：剔除命令回显（跨硬换行复原）与内部完成标记/语法碎片/提示符噪声，
    // 只把本次命令的真实输出交给模型（不再混入 __MOSS_DONE 标记与回显）。
    const cleaned = cleanRunOutput(res.output, [command, rt.interpreter.encodingInit]);

    return {
      output: cleaned,
      info: rt.info,
      completed: res.found,
      ...(res.exitCode !== undefined ? { exitCode: res.exitCode } : {}),
    };
  }

  disposeSession(sessionId: string): void {
    for (const id of Array.from(this.runtimes.keys())) {
      const rt = this.runtimes.get(id);
      if (rt && rt.info.sessionId === sessionId) this.close(id);
    }
    this.defaultIds.delete(sessionId);
    // 会话已删除：清掉落盘的历史条目
    this.storage.remove(sessionId);
  }

  // ── 内部 ──

  /** 某会话的在线终端信息（顺序为运行时插入序） */
  private liveInfos(sessionId: string): TerminalInfo[] {
    const out: TerminalInfo[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.info.sessionId === sessionId) out.push(rt.info);
    }
    return out;
  }

  /** 组装落盘条目：在线终端（当前 info + buffer）覆盖同 id 的既有历史条目 */
  private snapshotEntries(sessionId: string): PersistedTerminal[] {
    const entries = new Map<string, PersistedTerminal>();
    for (const e of this.storage.list(sessionId)) entries.set(e.info.id, e);
    for (const rt of this.runtimes.values()) {
      if (rt.info.sessionId !== sessionId) continue;
      entries.set(rt.info.id, { info: rt.info, buffer: rt.buffer });
    }
    return Array.from(entries.values());
  }

  /** 立即落盘某会话（创建/退出/关闭等关键节点） */
  private persistNow(sessionId: string): void {
    this.storage.save(sessionId, this.snapshotEntries(sessionId));
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    env.PYTHONUTF8 = '1';
    env.PYTHONIOENCODING = 'utf-8';
    if (!this.isWindows) {
      env.LANG = env.LANG ?? 'zh_CN.UTF-8';
      env.LC_ALL = env.LC_ALL ?? 'zh_CN.UTF-8';
    }
    return env;
  }

  private spawn(cmd: string[], opts: Record<string, unknown>): SubprocessLike {
    const spawn = Bun.spawn as unknown as (c: string[], o: Record<string, unknown>) => SubprocessLike;
    return spawn(cmd, opts);
  }

  /** 提交一行命令（PTY 用 \r 触发回车；管道用 \n） */
  private submit(rt: Runtime, line: string): void {
    if (rt.closed) return;
    if (rt.pty) rt.pty.write(`${line}\r`);
    else rt.proc?.stdin?.write(`${line}\n`);
  }

  private pump(stream: ReadableStream<Uint8Array> | null, rt: Runtime): void {
    if (!stream) return;
    const reader = stream.getReader();
    const loop = async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) this.onData(rt, value);
        }
      } catch {
        /* 流读取失败：忽略（进程退出等） */
      }
    };
    void loop();
  }

  private onData(rt: Runtime, bytes: Uint8Array): void {
    const text = rt.decoder.decode(bytes, { stream: true });
    if (!text) return;
    this.append(rt, text);
    this.emit(rt.info.sessionId, {
      type: 'terminal.data',
      sessionId: rt.info.sessionId,
      payload: { terminalId: rt.info.id, sessionId: rt.info.sessionId, data: text },
    });
    this.settleWaiters(rt);
    // 高频输出：去抖落盘（刷新/后端重启后仍能看到历史输出）。
    // 传入「惰性构建器」：snapshotEntries 会复制整会话缓冲，必须延后到写盘时执行，
    // 否则每个输出分片都复制一次完整缓冲（O(分片×缓冲) 二次开销）。
    this.storage.scheduleSave(rt.info.sessionId, () => this.snapshotEntries(rt.info.sessionId));
  }

  private append(rt: Runtime, text: string): void {
    rt.buffer += text;
    const max = TERMINAL_LIMITS.bufferChars;
    if (rt.buffer.length > max) {
      const removed = rt.buffer.length - max;
      rt.buffer = rt.buffer.slice(removed);
      for (const w of rt.waiters) w.start = Math.max(0, w.start - removed);
    }
  }

  private settleWaiters(rt: Runtime): void {
    for (const w of Array.from(rt.waiters)) {
      const hit = this.findSentinel(rt.buffer, w.start, w.marker);
      if (!hit) continue;
      clearTimeout(w.timer);
      rt.waiters.delete(w);
      w.resolve({
        output: rt.buffer.slice(w.start, hit.index),
        found: true,
        exitCode: hit.exitCode,
      });
    }
  }

  /**
   * 在原始 PTY 输出流中定位「完成标记 + 退出状态」的真实输出行（取最后一个匹配）。
   *
   * 不能用「换行 + 标记」判定：ConPTY（Bun.Terminal/Windows）会在输出行前插入光标显示等
   * ANSI 序列（实测为 `\u001b[?25h`），标记并不紧跟 `\n` —— 旧实现 `indexOf('\n'+marker)`
   * 恒为 -1，每条命令都等到超时（本 bug 根因）。改为在标记之后匹配退出状态 token：真实输出
   * 形如 `<marker> 0`；而回显的命令行里标记后跟的是语法片段（`$(if…` / `%errorlevel%` / `%s`），
   * 不会被误判。取最后一个匹配（回显在前、输出在后）。
   */
  private findSentinel(
    buffer: string,
    from: number,
    marker: string,
  ): { index: number; exitCode?: number } | null {
    const re = new RegExp(escapeRegExp(marker) + ANSI_CSI + '[ \\t]*' + SENTINEL_TOKEN, 'g');
    re.lastIndex = from;
    let last: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(buffer)) !== null) {
      last = m;
      if (re.lastIndex === m.index) re.lastIndex++; // 零宽保险
    }
    if (!last) return null;
    return { index: last.index, exitCode: tokenToExitCode(last[1]) };
  }

  private onExit(rt: Runtime, code: number): void {
    if (rt.closed) return;
    rt.closed = true;
    rt.info = { ...rt.info, running: false, exitCode: code };
    for (const w of Array.from(rt.waiters)) {
      clearTimeout(w.timer);
      rt.waiters.delete(w);
      w.resolve({ output: rt.buffer.slice(w.start), found: false });
    }
    try {
      rt.pty?.close();
    } catch {
      /* 静默 */
    }
    this.emit(rt.info.sessionId, {
      type: 'terminal.exit',
      sessionId: rt.info.sessionId,
      payload: { terminalId: rt.info.id, sessionId: rt.info.sessionId, exitCode: code },
    });
    // 退出：同步落盘（含退出码），刷新/重启后历史与状态一致
    this.persistNow(rt.info.sessionId);
  }
}