// src/modules/terminal/service.ts
// 持久终端管理器：原生 PTY（Bun.spawn({ terminal })）承载交互式终端；PTY 不可用时回退管道模式。
// - 人类（WS）与 agent（terminal 工具）共用同一批终端；
// - 命令完成/退出码：PowerShell/bash/zsh 用 **shell 集成 OSC 133**（不可见，按「命令回显之后」的
//   位置门控结算）；cmd 无钩子 → 用 **shell 自己打印的提示符**结算（不敲任何标记命令）；
// - **PTY 人侧输出原样透传**：绝不删改人侧流（删行会让 xterm 与 ConPTY 屏幕模型分叉 →
//   绝对光标定位/重绘整体错位）。只有非 PTY 管道回退（纯文本流）才用标记 + 行过滤；
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
import {
  cleanRunOutput,
  findEchoEnd,
  findPromptTail,
  findSentinel,
  isContinuationTail,
  MarkerLineFilter,
  stripTerminalNoise,
} from './clean-output';
import { OscScanner, makeNonce, type OscMarker } from './osc';
import { saveTerminalOutput } from './output-store';
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

/** 无头镜像的 scrollback 行数（与前端 xterm 的 5000 对齐：快照序列化成本/WS 帧减半） */
const HEADLESS_SCROLLBACK = 5_000;

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

/** 一次 run 的结算结果（定时器 / 中止 / 看门狗 / D 标记多路只生效一次） */
interface RunOutcome {
  output: string;
  found: boolean;
  exitCode?: number;
  /** OSC 路径：输出窗口是否精确（来自回显结束位置，无需再猜回显） */
  exact?: boolean;
  aborted?: boolean;
  /** shell 停在续行态（命令语法不完整），已被看门狗取消 */
  syntaxIncomplete?: boolean;
  /** 连续超时后默认终端已被自动重启 */
  restarted?: boolean;
}

interface Waiter {
  /** 完成标记（仅非 PTY 管道回退模式使用） */
  marker?: string;
  /** 本次提交的命令（回显门控用） */
  command: string;
  /** 提交时的绝对流偏移（用于排除上一条命令残留的 C/D） */
  startAbs: number;
  /** 命令回显结束的绝对流偏移（undefined = 尚未识别） */
  echoEnd?: number;
  /** 本次命令的 C 标记绝对偏移（命令行已读入；残留 D 必早于它） */
  cAt?: number;
  /** 提交时刻（提示符结算的 OSC 兜底宽限期用） */
  submitAt: number;
  /** OSC：已命中完成 D，正在静默观察期（等输出刷完再切片） */
  settling?: boolean;
  /** 静默观察期使用的退出码（取自命中的 D） */
  settleExit?: number;
  /** 命中 D 的绝对流偏移（用于检测其后的整屏重绘） */
  settleDAt?: number;
  /** 命中 D 后检测到整屏重绘 → 输出窗口在此处截止（绝对偏移） */
  settleCut?: number;
  settleStartedAt?: number;
  settleTimer?: ReturnType<typeof setTimeout>;
  /** 提示符结算：已看到的尾部提示符绝对偏移 / 静默复检定时器 */
  promptAt?: number;
  promptTimer?: ReturnType<typeof setTimeout>;
  /** OSC 模式：提交时的 D/C 计数（排除 shell 启动阶段的空命令 C/D 被误当作本次完成） */
  dCountAtSubmit: number;
  cCountAtSubmit: number;
  start: number;
  /** 是否已结算（幂等保护） */
  settled: boolean;
  resolve: (r: RunOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** 结算清理（清本地定时器、摘除 abort 监听） */
  cleanup?: () => void;
}

interface Runtime {
  info: TerminalInfo;
  proc: SubprocessLike | null;
  pty: PtyLike | null;
  /** 当前网格尺寸（resize 去重：同尺寸不再调用 ConPTY Resize，避免整屏重绘产生脏行） */
  cols: number;
  rows: number;
  interpreter: InteractiveInterpreter;
  decoder: TextDecoder;
  /** 原始输出流（命令回显剔除 / run 切片用；capped） */
  buffer: string;
  /** buffer 首字符在终端累计流中的绝对偏移（裁剪时累加，用于对齐 OSC 的 at） */
  bufferBase: number;
  /** 人侧行过滤器（仅非 PTY 管道回退使用；PTY 原样透传，绝不删行） */
  filter: MarkerLineFilter;
  /** 无头终端镜像（带格式历史快照；依赖不可用时为 null） */
  headless: HeadlessTerm | null;
  serializer: SerializeAddonLike | null;
  /** 序列化历史缓存（仅在可见输出变化时重算，避免每次落盘/订阅都全量重算） */
  historyCache: string | null;
  /** 可见输出已变化（缓存需要重算） */
  historyDirty: boolean;
  /** headless 写入序号 / 已解析序号（write 回调驱动；解析完成前序列化会缺尾） */
  writeSeq: number;
  parsedSeq: number;
  /** 等待「headless 解析追上写入」的回调 */
  parseWaiters: Array<() => void>;
  /** shell 集成 nonce（解析器据此防伪） */
  nonce: string;
  /** OSC 增量扫描器 */
  scanner: OscScanner;
  /** 首个 OSC 标记到达（shell 就绪门控：首条命令提交前等待 prompt 绘制） */
  oscReady: Promise<void>;
  resolveOscReady: () => void;
  /** 是否已完成「首条命令就绪等待」 */
  oscChecked: boolean;
  /** 已完成的 D 标记计数（续行看门狗判定「命令已产生完成 D」用） */
  dCount: number;
  /** 最近一次完成 D（绝对偏移 + 退出码）：用于「D 早于回显识别」时回看结算，避免永久等 D */
  lastD: { at: number; exitCode?: number } | null;
  /** 已收到的 C 标记计数（命令行已读入；>0 表示该 shell 提供 C，可用它排除残留 D） */
  cCount: number;
  /** 人侧输出待发送缓冲（24ms 微批，降低 WS 帧数与主线程开销） */
  pendingEmit: string;
  emitTimer: ReturnType<typeof setTimeout> | null;
  /** 上次发送时间（小数据立即发送的节流；降低键盘回显延迟） */
  lastEmitAt: number;
  /** 连续超时次数（>=2 时自动重启会话默认终端） */
  stuckTimeouts: number;
  /** 超时后的延迟复位定时器（关闭时清理） */
  resetTimer: ReturnType<typeof setTimeout> | null;
  /** 上次请求落盘的时间（每 250ms 最多调度一次，减少每个输出分片的闭包分配） */
  persistQueuedAt: number;
  waiters: Set<Waiter>;
  closed: boolean;
  /** shell 集成 rc 临时目录（关闭时清理） */
  rcDir: string | null;
  /** 输出流读尽（管道模式等待两个 pump；PTY 模式立即 resolve） */
  streamsDone: Promise<void>;
}

/** 输出投递函数（按会话路由到 WS 订阅者） */
export type TerminalEmitter = (sessionId: string, message: Record<string, unknown>) => void;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** 有界等待用的定时器 Promise */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 人侧输出微批间隔（ms）：合并高频小分片，显著降低 WS 帧数与 JSON 序列化开销 */
const EMIT_BATCH_MS = 24;
/** 人侧输出微批上限（字符）：超过立即 flush，避免单帧过大/内存堆积 */
const EMIT_BATCH_MAX = 64 * 1024;
/** 续行看门狗：命令提交后若 shell 停在纯续行提示符，判为语法不完整并取消 */
const CONTINUATION_GUARD_MS = 1200;
/** 提示符结算静默复检（ms）：尾部出现提示符后等一小段再确认；命令回显/后续输出会立刻打破该状态 */
const PROMPT_QUIET_MS = 60;
/**
 * OSC 模式下提示符兜底的宽限期（ms）：正常命令由 D 标记结算（约 30ms）。
 * 超过该时间仍未等到 D，才允许用「尾部提示符」结算（shell 集成失效时的兜底）。
 */
const OSC_PROMPT_FALLBACK_MS = 300;
/**
 * 未识别到命令回显时，提示符结算的最小等待（ms）。
 * 正常情况下必须先看到回显才允许提示符结算：上一条命令超时/中止后遗留的提示符也会出现在
 * 提交点之后，只有「回显之后」的提示符才是本次命令的完成信号。echo 被关闭等极端情况下
 * 才退化为「等到该时限后按尾部提示符结算」。
 */
const PROMPT_NO_ECHO_MS = 1500;
/**
 * shell 就绪门控：首条命令提交前等待首个 OSC 标记（prompt 已绘制）。
 * 实测 PowerShell 在启动完成前接收输入会被 PSReadLine 重绘成 `e\becho ...`，
 * 既丢行又拖慢到 2s+；等待 A 标记（通常 <1s）后提交即可消除。
 */
const SHELL_READY_MAX_MS = 3000;
/**
 * 超长/多行命令改为「临时脚本 + 加载执行」：PSReadLine/ConPTY 对单行输入有硬限制（实测 2KB 起
 * 回显被重绘撕裂、命令被截断）。脚本化后回显只有一行 loader，命令体不经行编辑，
 * 长命令/长脚本可完整执行；cd/变量等状态通过 dot-source / call / source 保持。
 * 多行命令同样脚本化：避免逐行执行产生多个提示符/D 导致早结算与串台。
 */
const LONG_COMMAND_CHARS = 1024;
/** 超时后延迟复位输入（避开紧接着启动的下一条命令） */
const TIMEOUT_RESET_DELAY_MS = 220;
/** OSC 命中完成 D 后的静默观察期：提示符 D 可能先于被缓冲的输出刷出，等安静再切片（防截断） */
const SETTLE_QUIET_MS = 30;
/** 静默观察期上限：输出持续不断时的兜底 */
const SETTLE_MAX_MS = 250;
/**
 * 结算边界：整屏重绘（H/2J/0;0H）或新提示符出现 → 本次命令输出到此为止。
 * 刻意不再把任意光标定位（`ESC[n;mH`）与隐藏光标（`ESC[?25l`）当边界：
 * 进度条/表格/彩色输出大量使用光标定位，旧规则会在命令输出中途截断（缺尾）。
 */
const SETTLE_STOP_RE =
  /\u001b\[(?:H|2J|0;0H)|(?:\r?\n|^)\s*PS [A-Za-z]:\\[^\r\n]*>|(?:\r?\n|^)\s*\S+@\S+:[^\r\n]*[$#]/g;

// ── 兼容模式（仅非 PTY 管道回退使用；PTY 绝不敲标记，人侧原样透传） ──

/** 生成唯一完成标记 */
function makeMarker(): string {
  return `__MOSS_DONE_${Math.random().toString(36).slice(2, 10)}__`;
}

/** 各 shell 的「完成标记 + 退出码」命令（兼容模式） */
function legacyMarkerCommand(shell: InteractiveInterpreter['shell'], marker: string): string {
  switch (shell) {
    case 'powershell':
      // 优先用集成在 prompt 首条语句保存的真实退出码（marker 执行时 $? 已被 prompt/PSReadLine 重置）
      return (
        `Write-Output "${marker} ` +
        `$(if ($null -ne $global:__MossCode) { $global:__MossCode } elseif ($?) {0} else {1})"`
      );
    case 'cmd':
      return `echo ${marker} %errorlevel%`;
    default:
      return `printf '${marker} %s\\n' "$?"`;
  }
}

/** 在 buffer 的 from 位置之后查找结算边界（整屏重绘/新提示符），返回下标；无则 -1 */
function findSettleStop(buffer: string, from: number): number {
  SETTLE_STOP_RE.lastIndex = Math.max(0, from);
  const m = SETTLE_STOP_RE.exec(buffer);
  SETTLE_STOP_RE.lastIndex = 0;
  return m ? m.index : -1;
}

export class TerminalManager implements TerminalService {
  private readonly runtimes = new Map<string, Runtime>();
  /** 会话默认终端 id（最近使用的主默认；terminal 工具缺省执行时复用） */
  private readonly defaultIds = new Map<string, string>();
  /**
   * 每会话、每解释器各一个默认终端：请求 CMD 时复用 CMD 专属终端，
   * 请求 PowerShell 时复用 PowerShell 专属终端；不再每次新建（撞 maxPerSession）
   * 也不会静默复用另一种解释器的终端（用户反馈的「让用 cmd 却跑了 powershell」）。
   */
  private readonly defaultByKind = new Map<string, Map<InterpreterKind, string>>();
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
    // 与 ws-handler 的 ptyBackendInfo 同源：随终端信息单帧下发，前端创建 xterm 时即可注入
    // windowsPty（避免 terminal.created 早于 terminal.list 时丢失、退回错误 reflow 行为）。
    const conptyBuild = Number(release().split('.')[2]);
    const ptyBackend =
      this.isWindows && usePty && Number.isFinite(conptyBuild)
        ? { backend: 'conpty' as const, buildNumber: conptyBuild }
        : undefined;

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
      ...(ptyBackend ? { ptyBackend } : {}),
    };

    const nonce = makeNonce();
    let resolveOscReady: () => void = () => {};
    const oscReady = new Promise<void>((res) => {
      resolveOscReady = res;
    });
    const rt: Runtime = {
      info,
      proc: null,
      pty: null,
      cols,
      rows,
      interpreter,
      decoder: new TextDecoder('utf-8', { fatal: false }),
      buffer: '',
      bufferBase: 0,
      filter: new MarkerLineFilter(),
      headless: this.createHeadless(cols, rows),
      serializer: null,
      historyCache: null,
      historyDirty: true,
      writeSeq: 0,
      parsedSeq: 0,
      parseWaiters: [],
      nonce,
      scanner: new OscScanner(nonce),
      oscReady,
      resolveOscReady,
      oscChecked: false,
      dCount: 0,
      lastD: null,
      cCount: 0,
      pendingEmit: '',
      emitTimer: null,
      lastEmitAt: 0,
      stuckTimeouts: 0,
      resetTimer: null,
      persistQueuedAt: 0,
      waiters: new Set(),
      closed: false,
      rcDir: null,
      streamsDone: Promise.resolve(),
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
        // 退出时等待两个输出流读尽（最多 200ms），避免管道模式的尾部输出丢失
        rt.streamsDone = Promise.all([this.pump(proc.stdout, rt), this.pump(proc.stderr, rt)]).then(
          () => undefined,
        );
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
    void this.persistNowAsync(opts.sessionId);
    return rt.info;
  }

  /** 会话默认终端（按解释器隔离）：该解释器已有默认且未关闭则复用；否则创建并登记 */
  async ensureDefault(opts: TerminalCreateOptions): Promise<TerminalInfo> {
    const kind = resolveInterpreter(this.isWindows, opts.interpreter).kind;
    const byKind = this.defaultByKind.get(opts.sessionId);
    const id = byKind?.get(kind);
    const rt = id ? this.runtimes.get(id) : undefined;
    if (rt && !rt.closed) {
      this.defaultIds.set(opts.sessionId, rt.info.id);
      return rt.info;
    }
    const info = await this.create({ ...opts, interpreter: kind, creator: opts.creator ?? 'ai' });
    this.registerDefault(opts.sessionId, kind, info.id);
    return info;
  }

  /** 重启该解释器的默认终端（未指定解释器时重启最近使用的主默认） */
  async restartDefault(opts: TerminalCreateOptions): Promise<TerminalInfo> {
    const resolvedKind = resolveInterpreter(this.isWindows, opts.interpreter).kind;
    const byKind = this.defaultByKind.get(opts.sessionId);
    const prevId =
      (opts.interpreter ? byKind?.get(resolvedKind) : undefined) ??
      this.defaultIds.get(opts.sessionId) ??
      byKind?.get(resolvedKind);
    const prevRt = prevId ? this.runtimes.get(prevId) : undefined;
    const kind = prevRt?.info.interpreterKind ?? resolvedKind;
    if (prevId) {
      this.close(prevId);
      byKind?.delete(kind);
      if (this.defaultIds.get(opts.sessionId) === prevId) this.defaultIds.delete(opts.sessionId);
    }
    const info = await this.create({ ...opts, interpreter: kind, creator: opts.creator ?? 'ai' });
    this.registerDefault(opts.sessionId, kind, info.id);
    return info;
  }

  /** 登记某解释器的会话默认终端（同时更新主默认） */
  private registerDefault(sessionId: string, kind: InterpreterKind, terminalId: string): void {
    const map = this.defaultByKind.get(sessionId) ?? new Map<InterpreterKind, string>();
    map.set(kind, terminalId);
    this.defaultByKind.set(sessionId, map);
    this.defaultIds.set(sessionId, terminalId);
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
      this.writePty(rt, data);
      return true;
    }
    const stdin = rt.proc?.stdin;
    if (!stdin) return false;
    this.writePipe(stdin, data);
    return true;
  }

  /**
   * 写入 PTY。超长输入（粘贴/多行脚本）按 8KB 字节分块：
   * Windows ConPTY 的单次输入缓冲有限，一次性写入几十 KB 可能被截断。
   * 按字节切分不会破坏 UTF-8（PTY 是连续字节流）。
   */
  private writePty(rt: Runtime, data: string): void {
    const pty = rt.pty;
    if (!pty) return;
    if (data.length <= 8192) {
      pty.write(data);
      return;
    }
    const bytes = Buffer.from(data, 'utf8');
    const CHUNK = 8192;
    for (let off = 0; off < bytes.length; off += CHUNK) {
      pty.write(bytes.subarray(off, Math.min(off + CHUNK, bytes.length)));
    }
  }

  /** 写入管道 stdin（同样分块，避免单次超大写入） */
  private writePipe(stdin: { write(data: string | Uint8Array): number | void }, data: string): void {
    if (data.length <= 8192) {
      stdin.write(data);
      return;
    }
    const bytes = Buffer.from(data, 'utf8');
    const CHUNK = 8192;
    for (let off = 0; off < bytes.length; off += CHUNK) {
      stdin.write(bytes.subarray(off, Math.min(off + CHUNK, bytes.length)));
    }
  }

  resize(id: string, cols: number, rows: number): boolean {
    const rt = this.runtimes.get(id);
    if (!rt || rt.closed || !rt.pty) return false;
    const c = clamp(Math.floor(cols), 20, 500);
    const r = clamp(Math.floor(rows), 5, 200);
    // 同尺寸直接短路：Windows ConPTY 收到 ResizePseudoConsole 必然整屏重绘，
    // 重复的「相同尺寸」调用会把重绘产生的空行写进滚动历史（前端回前台/布局抖动时高发）。
    if (c === rt.cols && r === rt.rows) return true;
    try {
      rt.pty.resize(c, r);
      rt.cols = c;
      rt.rows = r;
      // 无头镜像同步尺寸 → 回滚/reflow 与前端一致（reflow 会改变序列化结果 → 缓存失效）
      try {
        rt.headless?.resize(c, r);
        rt.historyCache = null;
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
      void (async () => {
        const entries = (await this.snapshotEntries(sid)).filter((e) => e.info.id !== id);
        await this.storage.save(sid, entries);
      })();
      this.emit(sid, { type: 'terminal.closed', sessionId: sid, payload: { terminalId: id, sessionId: sid } });
      return true;
    }
    rt.closed = true;
    this.flushEmit(rt);
    for (const w of Array.from(rt.waiters)) {
      this.settleWaiter(rt, w, { output: rt.buffer.slice(w.start), found: false });
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
    // 异步清除落盘条目（关闭后刷新不应复活该标签）；同时并入其余在线终端的最新缓冲
    void (async () => {
      const entries = (await this.snapshotEntries(rt.info.sessionId)).filter((e) => e.info.id !== id);
      await this.storage.save(rt.info.sessionId, entries);
    })();
    // 若关闭的是会话默认终端，同步清掉默认登记（下次 ensureDefault 会重建）
    if (this.defaultIds.get(rt.info.sessionId) === id) {
      this.defaultIds.delete(rt.info.sessionId);
    }
    const kindMap = this.defaultByKind.get(rt.info.sessionId);
    if (kindMap?.get(rt.info.interpreterKind) === id) kindMap.delete(rt.info.interpreterKind);
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

  /** 输出快照（等待 headless 解析追上写入后再序列化） */
  async snapshotAsync(id: string): Promise<string | undefined> {
    const rt = this.runtimes.get(id);
    if (rt) {
      await this.flushParsed(rt);
      return this.serializeHistory(rt);
    }
    return this.storage.getById(id)?.buffer;
  }

  /**
   * 在终端内执行一条命令并等待完成。
   *
   * 结算多路并发（OSC D / 提示符 / 标记 / 超时 / 中止 / 续行看门狗）通过 `settleWaiter` 幂等收敛：
   * - PTY + OSC shell（PowerShell/bash/zsh）：D 标记精确窗口结算（回显结束 → D）；
   * - PTY + cmd（无 OSC）：提示符结算（回显结束 → shell 自己打印的提示符），不敲任何标记；
   * - 非 PTY 管道回退：唯一标记（纯文本流，行过滤不会造成屏幕模型分叉）；
   * - 信号中止：立即 Ctrl+C 并返回，不再等满超时。
   */
  async run(id: string, command: string, timeoutMs?: number, signal?: AbortSignal): Promise<TerminalRunResult> {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error(t('terminal.notFound', { id }));
    if (!command || !command.trim()) throw new Error(t('terminal.commandRequired'));
    if (rt.closed) {
      // 终端已退出：本次命令未执行，不应把整段历史当作本次输出返回
      return { output: '', info: rt.info, completed: false };
    }
    if (signal?.aborted) {
      this.interrupt(rt);
      return { output: '', info: rt.info, completed: false, aborted: true };
    }

    const timeout = clamp(Math.floor(timeoutMs ?? TERMINAL_LIMITS.defaultTimeoutMs), 1000, 600_000);
    // 超长/多行命令改写为临时脚本：
    // - 避开 PSReadLine/ConPTY 的单行输入限制（长命令被截断/回显撕裂）；
    // - 多行命令逐行执行会在每行之间各产生一次提示符/D（早结算 + 输出串台），脚本化后只完成一次。
    const normalized = command.replace(/\r\n?/g, '\n');
    const multiLineInput = normalized.includes('\n');
    const scripted =
      normalized.length > LONG_COMMAND_CHARS || multiLineInput
        ? this.prepareScriptFile(rt, normalized)
        : null;
    const runCommand = scripted?.command ?? normalized;
    // 脚本化失败且确实多行时才按多行提交（此时不做 OSC 结算，退化为提示符结算）
    const multiLine = !scripted && /\n/.test(runCommand.trim());
    // 仅非 PTY 管道回退保留标记（PTY 绝不敲标记：人侧输出必须原样透传）
    const useMarker = rt.pty === null;
    const oscCapable = rt.interpreter.hasOsc && rt.pty !== null && !multiLine;
    /**
     * 首条命令提交前等待 shell 就绪（首个 OSC 标记 = prompt 已绘制）：
     * PowerShell 在启动完成前接收输入会被 PSReadLine 重绘撕裂（实测丢行且拖慢到 2s+）。
     * 等待后首条命令同样走 OSC，不再退化为标记路径。
     */
    if (oscCapable && !rt.oscChecked) {
      await Promise.race([rt.oscReady, delay(SHELL_READY_MAX_MS)]);
      await delay(80);
      rt.oscChecked = true;
    }
    const useOsc = oscCapable;
    const start = rt.buffer.length;
    const startAbs = rt.bufferBase + rt.buffer.length;
    const marker = useMarker ? makeMarker() : '';

    const res = await new Promise<RunOutcome>((resolve) => {
      let guardTimer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;

      const waiter: Waiter = {
        ...(useMarker ? { marker } : {}),
        command: runCommand,
        startAbs,
        submitAt: Date.now(),
        dCountAtSubmit: rt.dCount,
        cCountAtSubmit: rt.cCount,
        start,
        settled: false,
        resolve: (r) => resolve(r),
        cleanup: () => {
          if (guardTimer) clearTimeout(guardTimer);
          if (waiter.promptTimer) clearTimeout(waiter.promptTimer);
          if (onAbort) signal?.removeEventListener('abort', onAbort);
        },
      };

      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        rt.stuckTimeouts += 1;
        // 连续两次超时：输入状态已不可信，自动重启会话默认终端（下一次 exec 即落在新终端）
        const restart = rt.stuckTimeouts >= 2 && this.defaultIds.get(rt.info.sessionId) === id;
        if (restart) rt.stuckTimeouts = 0;
        const output = this.sliceRunOutput(rt, waiter);
        this.interrupt(rt);
        this.settleWaiter(rt, waiter, {
          output,
          found: false,
          ...(waiter.echoEnd !== undefined ? { exact: true } : {}),
          ...(restart ? { restarted: true } : {}),
        });
        // 延迟复位：仅在没有下一条命令接管时再补一次 Ctrl+C + 回车，清掉残留续行输入
        if (rt.resetTimer) clearTimeout(rt.resetTimer);
        rt.resetTimer = setTimeout(() => {
          rt.resetTimer = null;
          if (rt.closed || rt.waiters.size > 0) return;
          try {
            // 只发 Ctrl+C：再发回车会让 PSReadLine 读入一条空命令并产生 C+D，
            // 被下一条命令的等待者误认为“本次完成”（错误地结束超时判定）。
            this.write(id, '\u0003');
          } catch {
            /* 静默 */
          }
        }, TIMEOUT_RESET_DELAY_MS);
        if (restart) {
          setTimeout(() => {
            void this.restartDefault({
              sessionId: rt.info.sessionId,
              cwd: rt.info.cwd,
              interpreter: rt.info.interpreterKind,
              creator: rt.info.creator,
            }).catch(() => {
              /* 重启失败：保留现场，由用户/模型决定是否手工 restart */
            });
          }, 0);
        }
      }, timeout);

      rt.waiters.add(waiter);

      // 续行看门狗：命令语法不完整时 shell 会停在 `>>`，提前取消，避免等满超时。
      // cmd 无续行提示符，跳过。
      if (rt.interpreter.shell !== 'cmd') {
        guardTimer = setTimeout(() => {
          if (waiter.settled || rt.closed) return;
          if (useOsc && rt.dCount > waiter.dCountAtSubmit) return; // 已产生完成 D，正在结算
          if (!isContinuationTail(rt.buffer, waiter.start, rt.interpreter.shell)) return;
          const output = this.sliceRunOutput(rt, waiter);
          this.interrupt(rt);
          this.settleWaiter(rt, waiter, {
            output,
            found: false,
            syntaxIncomplete: true,
            ...(waiter.echoEnd !== undefined ? { exact: true } : {}),
          });
        }, CONTINUATION_GUARD_MS);
      }

      if (signal) {
        onAbort = () => {
          if (waiter.settled) return;
          const output = this.sliceRunOutput(rt, waiter);
          this.interrupt(rt);
          this.settleWaiter(rt, waiter, {
            output,
            found: false,
            aborted: true,
            ...(waiter.echoEnd !== undefined ? { exact: true } : {}),
          });
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        // 上一条命令若仍在静默观察期，先以「当前缓冲」为界结算，避免新命令回显混入上一条输出。
        this.finishSettlingNow(rt);
        // 先提交用户命令（长命令为脚本 loader）：OSC 路径靠集成序列判断完成；
        // 标记路径随后敲入唯一标记命令。
        this.submit(rt, runCommand);
        if (useMarker) this.submit(rt, legacyMarkerCommand(rt.interpreter.shell, marker));
      } catch {
        // 提交失败（PTY/管道已关闭等中断场景）：立即以「未完成」收尾，避免空等到超时
        this.settleWaiter(rt, waiter, { output: this.sliceRunOutput(rt, waiter), found: false });
      }
    });

    if (res.found) rt.stuckTimeouts = 0;
    // 清洗：精确窗口只做轻量去噪；回退路径继续用回显区域猜测。
    // 管道回退才存在标记命令；PTY 路径 markerCmd 为空，cleanRunOutput 会忽略。
    const markerCmd = useMarker ? legacyMarkerCommand(rt.interpreter.shell, marker) : '';
    const cleaned = res.exact
      ? stripTerminalNoise(res.output)
      : cleanRunOutput(res.output, [runCommand, markerCmd]);
    // 临时脚本已执行完：立即清理（失败静默，close 时还会整目录清理）
    if (scripted) {
      try {
        rmSync(scripted.file, { force: true });
      } catch {
        /* 静默 */
      }
    }

    // 大输出：完整清洗结果落盘（模型只收到精简摘要，需要全文时按 ref 读取）
    const totalLines = cleaned ? cleaned.split('\n').length : 0;
    let outputRef: string | undefined;
    if (cleaned.length > 8000 || totalLines > 120) {
      outputRef =
        (await saveTerminalOutput(this.dataDir, rt.info.sessionId, rt.info.id, cleaned)) ?? undefined;
    }

    return {
      output: cleaned,
      info: rt.info,
      completed: res.found,
      totalLines,
      totalChars: cleaned.length,
      ...(outputRef ? { outputRef } : {}),
      ...(res.exitCode !== undefined ? { exitCode: res.exitCode } : {}),
      ...(res.aborted ? { aborted: true } : {}),
      ...(res.syntaxIncomplete ? { syntaxIncomplete: true } : {}),
      ...(res.restarted ? { restarted: true } : {}),
    };
  }

  /** 保存一段完整文本为该终端的输出文件（read 场景用；失败返回 null） */
  async saveOutput(id: string, text: string): Promise<string | null> {
    const info = this.runtimes.get(id)?.info ?? this.storage.getById(id)?.info;
    if (!info) return null;
    return saveTerminalOutput(this.dataDir, info.sessionId, info.id, text);
  }

  disposeSession(sessionId: string): void {
    for (const id of Array.from(this.runtimes.keys())) {
      const rt = this.runtimes.get(id);
      if (rt && rt.info.sessionId === sessionId) this.close(id);
    }
    this.defaultIds.delete(sessionId);
    this.defaultByKind.delete(sessionId);
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

  /** headless 写入解析完成：推进已解析序号并唤醒等待者 */
  private markParsed(rt: Runtime, seq: number): void {
    if (seq > rt.parsedSeq) rt.parsedSeq = seq;
    if (rt.parsedSeq < rt.writeSeq) return;
    const waiters = rt.parseWaiters;
    rt.parseWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** 等待 headless 解析追上所有已写入数据（最多 500ms，异常时退化而不是挂起） */
  private flushParsed(rt: Runtime): Promise<void> {
    if (!rt.headless || rt.parsedSeq >= rt.writeSeq) return Promise.resolve();
    return new Promise<void>((resolve) => {
      rt.parseWaiters.push(resolve);
      setTimeout(() => {
        const idx = rt.parseWaiters.indexOf(resolve);
        if (idx >= 0) {
          rt.parseWaiters.splice(idx, 1);
          resolve();
        }
      }, 500);
    });
  }

  /**
   * 序列化可回滚历史（带格式）；失败/依赖缺失时降级为原始流。
   * 仅在有新可见输出时重算；解析未追上时返回旧缓存/原始流，绝不用不完整状态覆盖缓存。
   */
  private serializeHistory(rt: Runtime): string {
    if (rt.parsedSeq < rt.writeSeq) return rt.historyCache ?? rt.buffer;
    if (rt.historyCache !== null && !rt.historyDirty) return rt.historyCache;
    if (rt.serializer) {
      try {
        const s = rt.serializer.serialize({ scrollback: HEADLESS_SCROLLBACK });
        rt.historyCache = s;
        rt.historyDirty = false;
        return s;
      } catch {
        /* 降级 */
      }
    }
    return rt.buffer;
  }

  /**
   * 组装落盘条目：在线终端（当前 info + 序列化历史）覆盖同 id 的既有历史条目。
   * 先等待所有在线终端的 headless 解析追上写入，保证落盘历史不缺尾。
   */
  private async snapshotEntries(sessionId: string): Promise<PersistedTerminal[]> {
    const entries = new Map<string, PersistedTerminal>();
    for (const e of this.storage.list(sessionId)) entries.set(e.info.id, e);
    const live = Array.from(this.runtimes.values()).filter((rt) => rt.info.sessionId === sessionId);
    if (live.length > 0) await Promise.all(live.map((rt) => this.flushParsed(rt)));
    for (const rt of live) {
      entries.set(rt.info.id, { info: rt.info, buffer: this.serializeHistory(rt) });
    }
    return Array.from(entries.values());
  }

  /** 立即落盘某会话（创建/退出/关闭等关键节点）；异步执行，不阻塞事件循环 */
  private async persistNowAsync(sessionId: string): Promise<void> {
    try {
      await this.storage.save(sessionId, await this.snapshotEntries(sessionId));
    } catch {
      /* 落盘失败不影响终端运行 */
    }
  }

  /**
   * 超长命令落盘为临时脚本，返回「加载该脚本的单行命令」与文件路径。
   * - PowerShell：dot-source（状态持久化；启动参数已加 -ExecutionPolicy Bypass）
   * - CMD：call（同进程批处理，cd/set 生效）
   * - bash/zsh：source（状态持久化）
   * 任何失败返回 null（回退为直接提交原命令）。
   */
  private prepareScriptFile(rt: Runtime, command: string): { command: string; file: string } | null {
    try {
      const dir = join(this.dataDir, 'terminal-cmds', rt.info.id);
      mkdirSync(dir, { recursive: true });
      const shell = rt.interpreter.shell;
      const ext = shell === 'powershell' ? 'ps1' : shell === 'cmd' ? 'cmd' : 'sh';
      const file = join(
        dir,
        `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`,
      );
      // Windows PowerShell 5.1 读取无 BOM 的 UTF-8 会按 ANSI 解码（中文乱码）→ 加 BOM
      writeFileSync(file, shell === 'powershell' ? `\uFEFF${command}\n` : `${command}\n`, 'utf8');
      let loader: string;
      if (shell === 'powershell') {
        loader = `. '${file.replace(/'/g, "''")}'`;
      } else if (shell === 'cmd') {
        loader = `call "${file}"`;
      } else {
        loader = `. '${file.replace(/'/g, "'\\''")}'`;
      }
      return { command: loader, file };
    } catch {
      return null;
    }
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
    if (rt.emitTimer) {
      clearTimeout(rt.emitTimer);
      rt.emitTimer = null;
    }
    if (rt.resetTimer) {
      clearTimeout(rt.resetTimer);
      rt.resetTimer = null;
    }
    rt.pendingEmit = '';
    try {
      rt.headless?.dispose();
    } catch {
      /* 静默 */
    }
    rt.headless = null;
    rt.serializer = null;
    rt.historyCache = null;
    if (rt.rcDir) {
      try {
        rmSync(rt.rcDir, { recursive: true, force: true });
      } catch {
        /* 静默 */
      }
      rt.rcDir = null;
    }
    // 长命令临时脚本目录（正常会在每条命令后删单文件；这里兜底清理残留）
    try {
      rmSync(join(this.dataDir, 'terminal-cmds', rt.info.id), { recursive: true, force: true });
    } catch {
      /* 静默 */
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

  /**
   * 提交命令（多行逐行）。PTY 用 `\r` 触发回车：把每行之间用 `\r` 连接（等价于人工逐行输入，
   * PowerShell 的 `>>` 续行由 shell 自己处理，不再当“卡死”）；管道用 `\n`。
   * 去掉末尾连续空行，避免多余的回车把空命令提交两次。
   */
  private submit(rt: Runtime, command: string): void {
    if (rt.closed) return;
    const normalized = command.replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === '') lines.pop();
    if (rt.pty) {
      if (lines.length === 0) return;
      this.writePty(rt, `${lines.join('\r')}\r`);
    } else {
      const data = lines.length === 0 ? '\n' : `${lines.join('\n')}\n`;
      const stdin = rt.proc?.stdin;
      if (stdin) this.writePipe(stdin, data);
    }
  }

  private pump(stream: ReadableStream<Uint8Array> | null, rt: Runtime): Promise<void> {
    if (!stream) return Promise.resolve();
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
    return loop();
  }

  private onData(rt: Runtime, bytes: Uint8Array): void {
    const text = rt.decoder.decode(bytes, { stream: true });
    if (!text) return;
    this.append(rt, text);
    // 1) 回显门控：必须在解析本分片 OSC 之前（残留 D 可能与本分片的回显同片到达）
    for (const w of rt.waiters) {
      if (w.marker) continue;
      if (w.echoEnd !== undefined) continue;
      const end = findEchoEnd(rt.buffer, w.start, w.command);
      if (end >= 0) w.echoEnd = rt.bufferBase + end;
    }
    // 2) shell 集成 OSC：A 不参与完成计数；D 由 settleWaiters 按「回显之后」位置门控结算
    const markers = rt.scanner.push(text);
    if (markers.length > 0) rt.resolveOscReady();
    for (const m of markers) {
      if (m.kind === 'C') {
        // 命令行已读入（开始执行）：只接受本次命令提交之后的**第一个** C。
        // 不能每次覆盖：迟到的上一条标记命令 C 会把本命令的输出起点改到旧位置，
        // 导致切片包含前面多条命令的回显/输出（实测第 18 条串台）。
        rt.cCount += 1;
        for (const w of rt.waiters) {
          if (w.marker || w.settled) continue;
          if (w.cAt === undefined && m.at >= w.startAbs && rt.cCount > w.cCountAtSubmit) {
            w.cAt = m.at;
          }
        }
        continue;
      }
      if (m.kind !== 'D') continue;
      rt.dCount += 1;
      // 记录最近一次 D：即使它早于回显识别（本分片找不到完整回显），后续仍可回看结算
      rt.lastD = m.exitCode === undefined ? { at: m.at } : { at: m.at, exitCode: m.exitCode };
    }
    this.settleWaiters(rt, markers);
    // D 可能早于「回显识别」到达（跨分片被撕裂）：本分片识别出回显后回看最近一次 D 结算。
    for (const w of Array.from(rt.waiters)) {
      if (w.marker || w.settled || w.settling) continue;
      this.trySettleFromLastD(rt, w);
    }
    // 提示符结算：cmd 主路径 + OSC 失效兜底（shell 自己打印提示符，不敲任何标记）。
    for (const w of Array.from(rt.waiters)) {
      if (w.marker || w.settled || w.settling) continue;
      this.checkPromptSettle(rt, w);
    }
    // 静默观察期：有新数据就重新计时（等输出刷完），超过上限立即结算；
    // 若 D 之后出现整屏重绘（PSReadLine 重放历史），立即在该位置截断，防止历史输出混入本次结果。
    for (const w of Array.from(rt.waiters)) {
      if (!w.settling) continue;
      const dIdx = Math.max(0, (w.settleDAt ?? 0) - rt.bufferBase);
      const stop = findSettleStop(rt.buffer, dIdx);
      if (stop >= 0) {
        w.settleCut = rt.bufferBase + stop;
        this.finishSettled(rt, w);
        continue;
      }
      if (w.settleTimer) clearTimeout(w.settleTimer);
      if (Date.now() - (w.settleStartedAt ?? 0) >= SETTLE_MAX_MS) {
        this.finishSettled(rt, w);
        continue;
      }
      w.settleTimer = setTimeout(() => this.finishSettled(rt, w), SETTLE_QUIET_MS);
    }
    // 3) 人侧输出：PTY 必须原样透传（删行会让 xterm 与 ConPTY 屏幕模型分叉 → 重绘错位）；
    //    只有非 PTY 管道回退才用行过滤丢弃标记（纯文本流，无绝对光标定位）。
    const visible = rt.pty ? text : rt.filter.push(text);
    if (visible) {
      // headless.write 是异步解析：必须带 callback 记录「已解析到哪个写入」，
      // 否则快照/落盘会在解析完成前序列化（历史缺尾且被缓存下来）。
      if (rt.headless) {
        const seq = ++rt.writeSeq;
        try {
          rt.headless.write(visible, () => this.markParsed(rt, seq));
        } catch {
          this.markParsed(rt, seq); // 镜像写入失败：推进序号，避免快照等待挂起
        }
      }
      // 可见输出变化 → 序列化缓存失效（下次落盘/快照才重算）
      rt.historyDirty = true;
      this.queueEmit(rt, visible);
    }
    // 高频输出：去抖落盘（刷新/后端重启后仍能看到历史输出）。
    // 传入「惰性构建器」：snapshotEntries 会复制整会话缓冲，必须延后到写盘时执行，
    // 否则每个输出分片都复制一次完整缓冲（O(分片×缓冲) 二次开销）。
    // 每 250ms 最多请求一次，避免逐分片分配闭包。
    const now = Date.now();
    if (now - rt.persistQueuedAt >= 250) {
      rt.persistQueuedAt = now;
      this.storage.scheduleSave(rt.info.sessionId, () => this.snapshotEntries(rt.info.sessionId));
    }
  }

  private append(rt: Runtime, text: string): void {
    rt.buffer += text;
    const max = TERMINAL_LIMITS.bufferChars;
    if (rt.buffer.length <= max) return;
    // 一次性裁到 80%：避免「每来一个分片就整串拷贝一次」的 O(分片×缓冲) 二次开销
    const keep = Math.floor(max * 0.8);
    const removed = rt.buffer.length - keep;
    rt.buffer = rt.buffer.slice(removed);
    rt.bufferBase += removed;
    for (const w of rt.waiters) w.start = Math.max(0, w.start - removed);
  }

  /** 人侧输出微批：合并高频小分片后一次性下发（24ms / 64KB 上限） */
  private queueEmit(rt: Runtime, data: string): void {
    rt.pendingEmit += data;
    if (rt.pendingEmit.length >= EMIT_BATCH_MAX) {
      this.flushEmit(rt);
      return;
    }
    // 小数据快速路径：键盘回显等低延迟场景立即发送（8ms 节流），
    // 大流量仍走 24ms 合批，避免帧数膨胀。
    const now = Date.now();
    if (
      data.length <= 256 &&
      rt.pendingEmit.length <= 4096 &&
      now - rt.lastEmitAt >= 8
    ) {
      this.flushEmit(rt);
      return;
    }
    if (rt.emitTimer) return;
    rt.emitTimer = setTimeout(() => {
      rt.emitTimer = null;
      this.flushEmit(rt);
    }, EMIT_BATCH_MS);
  }

  /** 立即冲刷待发送输出（关闭/退出/建快照前调用，保证不丢尾部数据） */
  private flushEmit(rt: Runtime): void {
    if (rt.emitTimer) {
      clearTimeout(rt.emitTimer);
      rt.emitTimer = null;
    }
    if (!rt.pendingEmit) return;
    const data = rt.pendingEmit;
    rt.pendingEmit = '';
    rt.lastEmitAt = Date.now();
    this.emit(rt.info.sessionId, {
      type: 'terminal.data',
      sessionId: rt.info.sessionId,
      payload: { terminalId: rt.info.id, sessionId: rt.info.sessionId, data },
    });
  }

  /** 向 shell 发送中断（Ctrl+C）：超时 / 中止 / 续行看门狗共用 */
  private interrupt(rt: Runtime): void {
    if (rt.closed) return;
    try {
      this.write(rt.info.id, '\u0003');
    } catch {
      /* PTY 已关：静默 */
    }
  }

  /** 截取本次命令的输出（回显结束/C 标记 → 从其位置起；否则从提交处起） */
  private sliceRunOutput(rt: Runtime, w: Waiter): string {
    const anchor = w.echoEnd ?? w.cAt;
    const from =
      anchor !== undefined ? clamp(anchor - rt.bufferBase, 0, rt.buffer.length) : w.start;
    return rt.buffer.slice(from);
  }

  /** 结算等待者（幂等：定时器/OSC/中止/看门狗多路只生效一次） */
  private settleWaiter(rt: Runtime, w: Waiter, outcome: RunOutcome): void {
    if (w.settled) return;
    w.settled = true;
    clearTimeout(w.timer);
    if (w.settleTimer) clearTimeout(w.settleTimer);
    if (w.promptTimer) clearTimeout(w.promptTimer);
    w.cleanup?.();
    rt.waiters.delete(w);
    w.resolve(outcome);
  }

  /** 结束静默观察期：以「安静后的完整输出」结算（窗口从回显结束/C 标记处起；整屏重绘处截断） */
  private finishSettled(rt: Runtime, w: Waiter): void {
    if (w.settled || !rt.waiters.has(w)) return;
    const anchor = w.echoEnd ?? w.cAt;
    const from =
      anchor !== undefined ? clamp(anchor - rt.bufferBase, 0, rt.buffer.length) : w.start;
    // 截止边界：整屏重绘位置优先，否则到当前缓冲末尾
    const to =
      w.settleCut !== undefined
        ? clamp(w.settleCut - rt.bufferBase, from, rt.buffer.length)
        : rt.buffer.length;
    // 窗口为空（锚点落在提示符之后等边界情况）→ 回退到「提交点 → 末尾」，交给
    // cleanRunOutput 剔除回显。宁可多清洗，也绝不把空输出当成命令结果返回。
    const rawSlice = rt.buffer.slice(from, to);
    const usable = rawSlice.trim().length > 0;
    this.settleWaiter(rt, w, {
      output: usable ? rawSlice : rt.buffer.slice(w.start),
      found: true,
      // 回显结束位置或 C 标记已识别且窗口非空时精确；否则回退到回显剔除路径
      ...(usable && anchor !== undefined ? { exact: true } : {}),
      ...(w.settleExit !== undefined ? { exitCode: w.settleExit } : {}),
    });
  }

  /** 提示符结算的锚点：命令回显结束 / C 标记 / 提交点（绝对偏移） */
  private promptAnchorAbs(w: Waiter): number {
    return Math.max(w.echoEnd ?? w.cAt ?? w.startAbs, w.startAbs);
  }

  /**
   * 提示符结算：缓冲尾部是否停在 shell 自己打印的提示符上。
   *
   * - cmd 的主路径（无 OSC，绝不敲标记命令）；
   * - OSC shell 的兜底（宽限期后仍无 D，例如 shell 集成被用户配置破坏）。
   *
   * 关键：尾部提示符必须**保持 60ms**（期间重新确认）才结算。命令回显/后续输出会在几毫秒内
   * 追加到同一行，从而立刻打破「尾部提示符」状态 → 不会把上一条命令的提示符误当本次完成。
   */
  private checkPromptSettle(rt: Runtime, w: Waiter): void {
    if (w.settled || w.settling || w.promptTimer) return;
    if (rt.closed) return;
    // 只在命令回显之后接受提示符：上一条命令超时/中止遗留的提示符也会落在提交点之后，
    // 不能把它当成本次完成。echo 被关闭等极端情况才在超时后退化为尾部提示符结算。
    if (w.echoEnd === undefined) {
      const wait = w.submitAt + PROMPT_NO_ECHO_MS - Date.now();
      if (wait > 0) {
        // 到点主动复查（命令可能已结束但没有回显，之后不会再有新数据触发本方法）
        w.promptTimer = setTimeout(() => {
          w.promptTimer = undefined;
          if (w.settled || w.settling || !rt.waiters.has(w) || rt.closed) return;
          this.checkPromptSettle(rt, w);
        }, wait);
        return;
      }
    }
    // OSC 正常路径先给 D 标记留出时间；超过宽限期才允许提示符兜底
    if (rt.interpreter.hasOsc && Date.now() < w.submitAt + OSC_PROMPT_FALLBACK_MS) return;
    const anchor = this.promptAnchorAbs(w);
    const at = findPromptTail(rt.buffer, anchor - rt.bufferBase, rt.interpreter.shell);
    if (at < 0) return;
    w.promptAt = rt.bufferBase + at;
    w.promptTimer = setTimeout(() => {
      w.promptTimer = undefined;
      if (w.settled || w.settling || !rt.waiters.has(w) || rt.closed) return;
      this.settleFromPrompt(rt, w);
    }, PROMPT_QUIET_MS);
  }

  /** 提示符结算（幂等）：窗口 = [回显结束/C 标记, 提示符起点)；提示符之后的文本不属于本次输出 */
  private settleFromPrompt(rt: Runtime, w: Waiter): void {
    if (w.settled || w.settling || !rt.waiters.has(w)) return;
    const anchor = this.promptAnchorAbs(w);
    // 定时器到期必须重新确认尾部仍是同一个提示符（输出继续 / 下一条命令回显都会打破它）
    const still = findPromptTail(rt.buffer, anchor - rt.bufferBase, rt.interpreter.shell);
    if (still < 0 || rt.bufferBase + still !== w.promptAt) return;
    const from = clamp(anchor - rt.bufferBase, 0, rt.buffer.length);
    const to = clamp((w.promptAt as number) - rt.bufferBase, from, rt.buffer.length);
    // 退出码：本命令窗口内命中的 D（cmd 无 OSC → undefined）
    const d = rt.lastD;
    const exitCode = d && d.at >= anchor ? d.exitCode : undefined;
    this.settleWaiter(rt, w, {
      output: rt.buffer.slice(from, to),
      found: true,
      ...(w.echoEnd !== undefined || w.cAt !== undefined ? { exact: true } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    });
  }

  /**
   * 结算等待者：
   * - 标记模式（仅非 PTY 管道回退）：缓冲区中出现唯一 marker（findSentinel，天然无竞态）；
   * - OSC 模式：只接受**位置位于命令回显之后**的首个 D（残留 D 不得结算 → 修早结算/截断），
   *   命中后进入静默观察期再切片（防 D 先于缓冲输出刷出导致截断）。
   */
  private settleWaiters(rt: Runtime, markers: readonly OscMarker[]): void {
    for (const w of Array.from(rt.waiters)) {
      if (w.marker) {
        const hit = findSentinel(rt.buffer, w.start, w.marker);
        if (!hit) continue;
        this.settleWaiter(rt, w, {
          output: rt.buffer.slice(w.start, hit.index),
          found: true,
          ...(hit.exitCode !== undefined ? { exitCode: hit.exitCode } : {}),
        });
        continue;
      }
      if (w.settling) continue;
      // 只接受提交后新增的完成 D（排除 shell 启动阶段的空命令 D）
      if (rt.dCount <= w.dCountAtSubmit) continue;
      // 门控优先用 C（命令已开始执行）：D 只需晚于 C 即可完成。
      // 不能优先用 echoEnd：PSReadLine 重绘会让 D 落在「文本回显结束」之前，
      // 以 echoEnd 为门控会把这个完成 D 永久丢弃（偶发等满超时的根因）。
      const anchor = w.cAt ?? w.echoEnd;
      if (anchor === undefined) continue;
      const gate = Math.max(anchor, w.startAbs);
      // D 的起始位置可能在命令开始处 → 用 >=；残留/提前 D 必严格早于 gate
      const done = markers.find((m) => m.kind === 'D' && m.at >= gate);
      if (!done) continue;
      this.beginSettle(rt, w, done.at, done.exitCode);
    }
  }

  /** 进入静默观察期（幂等）：命中 D 后等输出安静再切片，避免提示符先于缓冲输出刷出造成截断 */
  private beginSettle(rt: Runtime, w: Waiter, at: number, exitCode?: number): void {
    if (w.settled || w.settling) return;
    w.settling = true;
    w.settleExit = exitCode;
    w.settleDAt = at;
    w.settleStartedAt = Date.now();
    clearTimeout(w.timer);
    if (w.promptTimer) {
      clearTimeout(w.promptTimer);
      w.promptTimer = undefined;
    }
    if (w.settleTimer) clearTimeout(w.settleTimer);
    w.settleTimer = setTimeout(() => this.finishSettled(rt, w), SETTLE_QUIET_MS);
  }

  /**
   * 回看最近一次 D：处理「D 早于 echoEnd 识别」的跨分片竞态。
   * 旧实现只在本次新标记里找 D，若 D 在回显尚未识别时到达就被永久丢弃 → 等到超时（卡死）。
   */
  private trySettleFromLastD(rt: Runtime, w: Waiter): void {
    if (w.settled || w.settling) return;
    if (rt.dCount <= w.dCountAtSubmit) return;
    const anchor = w.cAt ?? w.echoEnd;
    if (anchor === undefined) return;
    const d = rt.lastD;
    if (!d) return;
    const gate = Math.max(anchor, w.startAbs);
    if (d.at < gate) return;
    this.beginSettle(rt, w, d.at, d.exitCode);
  }

  /** 提交新命令前结算所有仍在静默观察期的等待者（以当前缓冲为界，避免新命令回显混入上一条输出） */
  private finishSettlingNow(rt: Runtime): void {
    for (const w of Array.from(rt.waiters)) {
      if (w.settling) this.finishSettled(rt, w);
    }
  }

  private async onExit(rt: Runtime, code: number): Promise<void> {
    if (rt.closed) return;
    rt.closed = true;
    rt.info = { ...rt.info, running: false, exitCode: code };
    // 等待输出流读尽（PTY 立即 resolve；管道最多 200ms），再 flush 解码器剩余字节。
    // 旧实现进程 exit 后立即结算，管道模式的尾部输出与最后一个被分片切开的多字节字符会丢失。
    await Promise.race([
      rt.streamsDone,
      new Promise<void>((resolve) => setTimeout(resolve, 200)),
    ]);
    const tail = rt.decoder.decode();
    if (tail) this.append(rt, tail);
    this.flushEmit(rt);
    for (const w of Array.from(rt.waiters)) {
      this.settleWaiter(rt, w, { output: rt.buffer.slice(w.start), found: false });
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
    // 退出：先落盘（含退出码；等待 headless 解析完再序列化），再释放镜像/临时文件
    await this.persistNowAsync(rt.info.sessionId);
    this.disposeRuntime(rt);
  }
}
