// src/modules/terminal/service.ts
// 持久终端管理器：原生 PTY（Bun.spawn({ terminal })）承载交互式终端；PTY 不可用时回退管道模式。
// - 人类（WS）与 agent（terminal 工具）共用同一批终端；
// - 每个终端维护输出环形缓冲，供订阅/重连复原与 agent read；
// - 输出经注入的 emitter 按会话路由到 WS 订阅者。

import { t } from '../../core/i18n';
import type { Logger } from '../../core/types';
import { resolveInterpreter, makeMarker, type InteractiveInterpreter } from './interpreter';
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

/** 去除 ANSI 转义序列（工具返回给模型的可读输出） */
function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, '');
}

export class TerminalManager implements TerminalService {
  private readonly runtimes = new Map<string, Runtime>();
  /** 会话默认终端 id（terminal 工具缺省执行时复用；人类创建不受影响） */
  private readonly defaultIds = new Map<string, string>();
  private readonly emit: TerminalEmitter;
  private readonly logger: Logger;
  private readonly isWindows: boolean;

  constructor(deps: { emitter: TerminalEmitter; logger: Logger; isWindows: boolean }) {
    this.emit = deps.emitter;
    this.logger = deps.logger;
    this.isWindows = deps.isWindows;
  }

  async create(opts: TerminalCreateOptions): Promise<TerminalInfo> {
    if (this.list(opts.sessionId).length >= TERMINAL_LIMITS.maxPerSession) {
      throw new Error(t('terminal.tooManyPerSession', { max: TERMINAL_LIMITS.maxPerSession }));
    }

    const interpreter = resolveInterpreter(this.isWindows, opts.interpreter);
    const cols = clamp(Math.floor(opts.cols ?? TERMINAL_LIMITS.defaultCols), 20, 500);
    const rows = clamp(Math.floor(opts.rows ?? TERMINAL_LIMITS.defaultRows), 5, 200);
    const cwd = opts.cwd && opts.cwd.trim() ? opts.cwd : process.cwd();
    const id = `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const index = this.list(opts.sessionId).length + 1;

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
    if (!rt) return false;
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
    const out: TerminalInfo[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.info.sessionId === sessionId) out.push(rt.info);
    }
    return out;
  }

  snapshot(id: string): string | undefined {
    return this.runtimes.get(id)?.buffer;
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
      this.submit(rt, command);
      this.submit(rt, rt.interpreter.markerCommand(marker));
    });

    // 清理：去 ANSI；剔除含完成标记的行（回显的标记命令行）
    const cleaned = stripAnsi(res.output)
      .split(/\r?\n/)
      .filter((line) => !line.includes(marker))
      .join('\n')
      .replace(/\s+$/, '');

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
  }

  // ── 内部 ──

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
      // 匹配「换行 + 标记」：跳过回显的标记命令行（其中标记前是引号，非换行）
      const idx = rt.buffer.indexOf(`\n${w.marker}`, w.start);
      if (idx < 0) continue;
      clearTimeout(w.timer);
      rt.waiters.delete(w);
      w.resolve({
        output: rt.buffer.slice(w.start, idx),
        found: true,
        exitCode: this.parseExitCode(rt.buffer, idx, w.marker),
      });
    }
  }

  /**
   * 解析标记行尾部的退出状态：
   * bash/zsh 与 cmd 为数字（`$?` / `%errorlevel%`）；PowerShell `$?` 为 True/False（→ 0/1）。
   * 解析不到返回 undefined。
   */
  private parseExitCode(buffer: string, markerIdx: number, marker: string): number | undefined {
    const rest = buffer.slice(markerIdx + 1); // 跳过标记前的换行
    const lineEnd = rest.search(/\r?\n/);
    const line = lineEnd >= 0 ? rest.slice(0, lineEnd) : rest;
    const after = line.slice(line.indexOf(marker) + marker.length).trim();
    const token = after.split(/\s+/)[0] ?? '';
    if (/^-?\d+$/.test(token)) return parseInt(token, 10);
    if (token === 'True') return 0;
    if (token === 'False') return 1;
    return undefined;
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
  }
}