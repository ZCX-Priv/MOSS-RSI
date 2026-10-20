// src/modules/terminal/service.ts
// 持久终端管理器：原生 PTY（Bun.spawn({ terminal })）承载交互式终端；PTY 不可用时回退管道模式。
// - 人类（WS）与 agent（terminal 工具）共用同一批终端；
// - 命令完成/退出码由 **shell 集成 OSC 133 序列**判定（不可见；不再向 PTY 敲入任何标记命令）；
// - 每个终端用 @xterm/headless 镜像输出，输出缓冲以「序列化（带格式、可回滚）」形式供订阅/复原；
// - 输出经注入的 emitter 按会话路由到 WS 订阅者。

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { t } from '../../core/i18n';
import type { Logger } from '../../core/types';
import {
  resolveInterpreter,
  MOSS_RCDIR_PLACEHOLDER,
  MOSS_RCFILE_PLACEHOLDER,
  type InteractiveInterpreter,
  type ShellIntegration,
} from './interpreter';
import { TerminalPersistence, type PersistedTerminal } from './persistence';
import { cleanRunOutput } from './clean-output';
import { OscScanner, makeNonce } from './osc';
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

/** @xterm/headless 的最小结构（仅用到的 API；避免依赖其类型解析） */
interface HeadlessTerm {
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  loadAddon(addon: unknown): void;
}
/** @xterm/addon-serialize 的最小结构 */
interface SerializeAddonLike {
  serialize(opts?: { scrollback?: number }): string;
}

/** 无头镜像的 scrollback 行数（决定"可回滚到多早"；含首行） */
const HEADLESS_SCROLLBACK = 20_000;

let headlessLibsCache: { Terminal: new (opts: Record<string, unknown>) => HeadlessTerm; SerializeAddon: new () => SerializeAddonLike } | null | undefined;
/** 惰性加载 CJS 版 headless + serialize（createRequire：Node/Bun 均可稳定解析 CJS 入口） */
function headlessLibs(): typeof headlessLibsCache {
  if (headlessLibsCache !== undefined) return headlessLibsCache;
  try {
    const req = createRequire(import.meta.url);
    const { Terminal } = req('@xterm/headless') as { Terminal: new (o: Record<string, unknown>) => HeadlessTerm };
    const { SerializeAddon } = req('@xterm/addon-serialize') as { SerializeAddon: new () => SerializeAddonLike };
    headlessLibsCache = { Terminal, SerializeAddon };
  } catch {
    headlessLibsCache = null; // 依赖不可用 → 快照降级为原始流（不影响终端可用）
  }
  return headlessLibsCache;
}

interface Waiter {
  /** OSC 集成模式：需等待的「第几个 D 标记」（rt.dCount 达到即完成） */
  targetCount?: number;
  /** 兼容模式：完成标记（shell 集成不可用时） */
  marker?: string;
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
  /** 原始输出流（命令回显剔除 / run 切片用；capped） */
  buffer: string;
  /** 无头终端镜像（带格式历史快照；依赖不可用时为 null） */
  headless: HeadlessTerm | null;
  serializer: SerializeAddonLike | null;
  /** shell 集成 nonce（解析器据此防伪） */
  nonce: string;
  /** OSC 增量扫描器 */
  scanner: OscScanner;
  /** 已完成的 D 标记计数 */
  dCount: number;
  /** 最近一次 D 的退出码 */
  lastExit: number | undefined;
  waiters: Set<Waiter>;
  closed: boolean;
  /** shell 集成 rc 临时目录（关闭时清理） */
  rcDir: string | null;
}

/** 输出投递函数（按会话路由到 WS 订阅者） */
export type TerminalEmitter = (sessionId: string, message: Record<string, unknown>) => void;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ── 兼容模式（仅当 shell 集成不可用时使用；标记会出现在终端里，非首选路径） ──

/** 生成唯一完成标记 */
function makeMarker(): string {
  return `__MOSS_DONE_${Math.random().toString(36).slice(2, 10)}__`;
}

/** 各 shell 的「完成标记 + 退出码」命令（兼容模式） */
function legacyMarkerCommand(shell: InteractiveInterpreter['shell'], marker: string): string {
  switch (shell) {
    case 'powershell':
      return `Write-Output "${marker} $(if ($?) {0} else {1})"`;
    case 'cmd':
      return `echo ${marker} %errorlevel%`;
    default:
      return `printf '${marker} %s\\n' "$?"`;
  }
}

/** 转义正则元字符 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 标记与退出码之间可能插入的 ANSI CSI 序列（ConPTY 常见） */
const ANSI_CSI = '(?:\\u001b\\[[0-9;?]*[A-Za-z])*';

/**
 * 在缓冲中定位「兼容完成标记 + 退出码」的真实输出（取最后一个匹配）。
 * 回显的命令行里标记后跟的是语法片段（$(if… / %errorlevel% / %s），不会被数字匹配。
 */
function findSentinel(buffer: string, from: number, marker: string): { index: number; exitCode?: number } | null {
  const re = new RegExp(escapeRegExp(marker) + ANSI_CSI + '[ \\t]*(-?\\d+)(?!\\d)', 'g');
  re.lastIndex = from;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer)) !== null) {
    last = m;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return last ? { index: last.index, exitCode: parseInt(last[1], 10) } : null;
}

export class TerminalManager implements TerminalService {
  private readonly runtimes = new Map<string, Runtime>();
  /** 会话默认终端 id（terminal 工具缺省执行时复用；人类创建不受影响） */
  private readonly defaultIds = new Map<string, string>();
  private readonly emit: TerminalEmitter;
  private readonly logger: Logger;
  private readonly isWindows: boolean;
  private readonly dataDir: string;
  /** 落盘存储（元数据 + 序列化历史）：进程重启后 list/snapshot 仍可还原（离线只读） */
  private readonly storage: TerminalPersistence;

  constructor(deps: { emitter: TerminalEmitter; logger: Logger; isWindows: boolean; dataDir: string }) {
    this.emit = deps.emitter;
    this.logger = deps.logger;
    this.isWindows = deps.isWindows;
    this.dataDir = deps.dataDir;
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

    const nonce = makeNonce();
    const rt: Runtime = {
      info,
      proc: null,
      pty: null,
      interpreter,
      decoder: new TextDecoder('utf-8', { fatal: false }),
      buffer: '',
      headless: this.createHeadless(cols, rows),
      serializer: null,
      nonce,
      scanner: new OscScanner(nonce),
      dCount: 0,
      lastExit: undefined,
      waiters: new Set(),
      closed: false,
      rcDir: null,
    };
    // 载入 serialize 插件（与 headless 同源加载）
    const libs = headlessLibs();
    if (rt.headless && libs) {
      try {
        rt.serializer = new libs.SerializeAddon();
        rt.headless.loadAddon(rt.serializer);
      } catch {
        rt.serializer = null;
      }
    }

    // shell 集成注入（启动期、零可见回显）：rc 文件落地 + 占位符替换
    const integration = this.materializeIntegration(id, interpreter.makeIntegration(nonce));
    rt.rcDir = integration.rcDir;

    const env = this.buildEnv(integration.env);
    const argv = [interpreter.bin, ...interpreter.args, ...integration.extraArgs];
    try {
      if (usePty && ptyCtor) {
        const pty = new ptyCtor({
          cols,
          rows,
          data: (_term, data) => this.onData(rt, data),
          exit: (_term, code) => this.onExit(rt, code),
        });
        rt.pty = pty;
        rt.proc = this.spawn(argv, { cwd, env, terminal: pty });
      } else {
        const proc = this.spawn(argv, {
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
      this.disposeRuntime(rt);
      throw new Error(
        t('terminal.spawnFailed', { message: err instanceof Error ? err.message : String(err) }),
      );
    }

    this.runtimes.set(id, rt);
    void rt.proc.exited.then((code) => this.onExit(rt, code)).catch(() => this.onExit(rt, -3));

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
    const c = clamp(Math.floor(cols), 20, 500);
    const r = clamp(Math.floor(rows), 5, 200);
    try {
      rt.pty.resize(c, r);
      // 无头镜像同步尺寸 → 回滚/reflow 与前端一致
      try {
        rt.headless?.resize(c, r);
      } catch {
        /* 镜像 resize 失败不影响本体 */
      }
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
    this.disposeRuntime(rt);
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

  /** 输出快照：优先返回**序列化历史**（行导向、带 ANSI 颜色、可回滚），依赖不可用时降级为原始流 */
  snapshot(id: string): string | undefined {
    const rt = this.runtimes.get(id);
    if (rt) return this.serializeHistory(rt);
    // 离线历史项：回放落盘（序列化）历史
    return this.storage.getById(id)?.buffer;
  }

  async run(id: string, command: string, timeoutMs?: number): Promise<TerminalRunResult> {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error(t('terminal.notFound', { id }));
    if (!command || !command.trim()) throw new Error(t('terminal.commandRequired'));
    if (rt.closed) {
      return { output: rt.buffer, info: rt.info, completed: false };
    }

    const timeout = clamp(Math.floor(timeoutMs ?? TERMINAL_LIMITS.defaultTimeoutMs), 1000, 600_000);
    const start = rt.buffer.length;
    // shell 集成可用性：启动提示符应已发过 OSC；从未见过任何标记 → 判定集成不可用（走兼容标记）
    const useOsc = rt.scanner.count > 0;
    const marker = useOsc ? '' : makeMarker();
    const targetCount = rt.dCount + 1;

    const res = await new Promise<{ output: string; found: boolean; exitCode?: number }>((resolve) => {
      const waiter: Waiter = {
        ...(useOsc ? { targetCount } : { marker }),
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
        // 只提交用户命令：完成/退出码由 shell 集成 OSC 标记给出（不敲入任何可见标记命令）
        this.submit(rt, command);
        // 集成不可用时才敲入兼容标记（会出现在终端里，非首选路径）
        if (!useOsc) this.submit(rt, legacyMarkerCommand(rt.interpreter.shell, marker));
      } catch {
        // 提交失败（PTY/管道已关闭等中断场景）：立即以「未完成」收尾，避免空等到超时
        clearTimeout(waiter.timer);
        rt.waiters.delete(waiter);
        resolve({ output: rt.buffer.slice(start), found: false });
      }
    });

    // 清洗：剔除命令回显（含 ConPTY 硬换行切断）与残留的标记/提示符噪声，只留真实输出。
    const cleaned = cleanRunOutput(res.output, [command]);

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

  /** 建无头镜像终端（cols/rows 同 PTY；windowsPty 与前端一致，保证回滚/reflow 行为一致） */
  private createHeadless(cols: number, rows: number): HeadlessTerm | null {
    const libs = headlessLibs();
    if (!libs) return null;
    try {
      const build = Number(release().split('.')[2]);
      return new libs.Terminal({
        cols,
        rows,
        scrollback: HEADLESS_SCROLLBACK,
        allowProposedApi: true,
        convertEol: false,
        ...(this.isWindows ? { windowsPty: { backend: 'conpty', buildNumber: Number.isFinite(build) ? build : 19045 } } : {}),
      });
    } catch {
      return null;
    }
  }

  /** 序列化可回滚历史（带格式）；失败/依赖缺失时降级为原始流 */
  private serializeHistory(rt: Runtime): string {
    if (rt.serializer) {
      try {
        return rt.serializer.serialize({ scrollback: HEADLESS_SCROLLBACK });
      } catch {
        /* 降级 */
      }
    }
    return rt.buffer;
  }

  /** 组装落盘条目：在线终端（当前 info + 序列化历史）覆盖同 id 的既有历史条目 */
  private snapshotEntries(sessionId: string): PersistedTerminal[] {
    const entries = new Map<string, PersistedTerminal>();
    for (const e of this.storage.list(sessionId)) entries.set(e.info.id, e);
    for (const rt of this.runtimes.values()) {
      if (rt.info.sessionId !== sessionId) continue;
      entries.set(rt.info.id, { info: rt.info, buffer: this.serializeHistory(rt) });
    }
    return Array.from(entries.values());
  }

  /** 立即落盘某会话（创建/退出/关闭等关键节点） */
  private persistNow(sessionId: string): void {
    this.storage.save(sessionId, this.snapshotEntries(sessionId));
  }

  /**
   * 落地 shell 集成注入：写 rc 文件（bash --rcfile / zsh ZDOTDIR）并把占位符替换为真实路径；
   * 任何失败都静默降级（终端仍可用，只是没有不可见完成标记）。
   */
  private materializeIntegration(id: string, integration: ShellIntegration): {
    extraArgs: string[];
    env: Record<string, string>;
    rcDir: string | null;
  } {
    let extraArgs = integration.extraArgs ?? [];
    let env = integration.env ?? {};
    let rcDir: string | null = null;
    const files = integration.rcFiles;
    if (files && files.length > 0) {
      try {
        const dir = join(this.dataDir, 'terminals', 'rc', id);
        mkdirSync(dir, { recursive: true });
        for (const f of files) writeFileSync(join(dir, f.name), f.body, 'utf8');
        const firstPath = join(dir, files[0].name);
        const repl = (s: string): string =>
          s.split(MOSS_RCDIR_PLACEHOLDER).join(dir).split(MOSS_RCFILE_PLACEHOLDER).join(firstPath);
        extraArgs = extraArgs.map(repl);
        env = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, repl(v)]));
        rcDir = dir;
      } catch {
        /* 注入失败：降级为无集成 */
      }
    }
    return { extraArgs, env, rcDir };
  }

  /** 释放运行时的镜像/临时文件（关闭/退出/spawn 失败时调用，幂等） */
  private disposeRuntime(rt: Runtime): void {
    try {
      rt.headless?.dispose();
    } catch {
      /* 静默 */
    }
    rt.headless = null;
    rt.serializer = null;
    if (rt.rcDir) {
      try {
        rmSync(rt.rcDir, { recursive: true, force: true });
      } catch {
        /* 静默 */
      }
      rt.rcDir = null;
    }
  }

  private buildEnv(extra?: Record<string, string>): Record<string, string> {
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
    if (extra) Object.assign(env, extra);
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
    // 无头镜像（带格式历史的单一事实源）
    try {
      rt.headless?.write(text);
    } catch {
      /* 镜像写入失败不影响本体 */
    }
    // shell 集成 OSC：命令完成（D）计数（A 不参与完成计数）；随后统一结算等待者
    for (const m of rt.scanner.push(text)) {
      if (m.kind === 'D') {
        rt.dCount += 1;
        rt.lastExit = m.exitCode;
      }
    }
    this.settleWaiters(rt);
    this.emit(rt.info.sessionId, {
      type: 'terminal.data',
      sessionId: rt.info.sessionId,
      payload: { terminalId: rt.info.id, sessionId: rt.info.sessionId, data: text },
    });
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

  /** 结算等待者：OSC 模式看 D 计数；兼容模式看缓冲区中的完成标记 */
  private settleWaiters(rt: Runtime): void {
    for (const w of Array.from(rt.waiters)) {
      if (w.marker) {
        const hit = findSentinel(rt.buffer, w.start, w.marker);
        if (!hit) continue;
        clearTimeout(w.timer);
        rt.waiters.delete(w);
        w.resolve({
          output: rt.buffer.slice(w.start, hit.index),
          found: true,
          ...(hit.exitCode !== undefined ? { exitCode: hit.exitCode } : {}),
        });
        continue;
      }
      if (w.targetCount === undefined || rt.dCount < w.targetCount) continue;
      clearTimeout(w.timer);
      rt.waiters.delete(w);
      w.resolve({
        output: rt.buffer.slice(w.start),
        found: true,
        ...(rt.lastExit !== undefined ? { exitCode: rt.lastExit } : {}),
      });
    }
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
    // 退出：同步落盘（含退出码）+ 释放镜像/临时文件
    this.persistNow(rt.info.sessionId);
    this.disposeRuntime(rt);
  }
}
