// src/modules/computer/service.ts
// Computer 服务实现：持有 cua-driver mcp 子进程（stdio MCP），提供工具调用、
// 面板截图、活动记录、暂停与安装能力。
//
// 设计要点：
// - 单连接：Agent 工具与面板共用一个 cua 运行时；cua 的 session 标签用于隔离快照/token。
// - 惰性/后台连接：模块初始化不阻塞内核；未安装时只记录状态，等用户安装或手动安装后重连。
// - 不自动安装、不自启、不改 PATH；安装是面板中的显式用户动作。
// - 截图落盘在 ~/.moss/computer；cua 的 screenshot_out_file 直接写文件，避免 base64 经 stdio 往返。

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { t } from '../../core/i18n';
import type { ConfigService, Environment, EventBus, Logger } from '../../core/types';
import { McpClient, type McpToolInfo, type McpToolResult, type ServerConfig } from '../mcp/client';
import type {
  ComputerActivity,
  ComputerCallOptions,
  ComputerCapture,
  ComputerConnectionState,
  ComputerFocusResult,
  ComputerHealth,
  ComputerHealthCheck,
  ComputerProcessWindow,
  ComputerScreenInfo,
  ComputerService,
  ComputerStatus,
  ComputerToolResult,
  ComputerWindowTarget,
} from './types';
import {
  getForegroundWindowInfo as getNativeForegroundWindow,
  initNativeWindows,
  isCuaOverlayWindow,
  isInternalWindowClass,
  isNativeWindowEnumerationAvailable,
  listNativeWindows,
  type NativeWindowInfo,
} from './win32';
import {
  ensureComputerDirs,
  getComputerDirs,
  newLivePath,
  newScreenshotPath,
  pruneComputerFiles,
  pruneLiveAfterCapture,
  resolveCuaDriverPath,
  type ComputerDirs,
} from './paths';

const CONNECT_TIMEOUT_MS = 15_000;
const VERSION_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 300_000;
const MAX_ACTIVITIES = 50;
/** 会话复活（start_session）超时：失败即轮换标签，不拖住截图 */
const SESSION_REVIVE_TIMEOUT_MS = 8_000;
/** 面板会话预热超时（best-effort，不阻塞连接） */
const SESSION_PREWARM_TIMEOUT_MS = 5_000;
/** 截图失败后的健康检查最小间隔（避免每 1.5s 轮询都触发诊断） */
const HEALTH_MIN_INTERVAL_MS = 30_000;

/** cua 官方 Windows 安装脚本 */
const WINDOWS_INSTALLER_URL =
  'https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1';
/** cua 官方 macOS / Linux 安装脚本 */
const UNIX_INSTALLER_URL =
  'https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh';

/** cua 工具 inputSchema 的最小结构（仅用于检测 session 字段） */
interface McpInputSchemaLike {
  properties?: Record<string, unknown>;
}

/** 面板截图的默认会话标签（与 Agent 会话隔离，避免替换其快照） */
const PANEL_SESSION = 'moss_panel';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pickString(obj: unknown, keys: string[]): string | undefined {
  if (!isObject(obj)) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function pickNumber(obj: unknown, keys: string[]): number | undefined {
  if (!isObject(obj)) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickBoolean(obj: unknown, keys: string[]): boolean | undefined {
  if (!isObject(obj)) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

/** 读取 HWND：兼容 number、十进制字符串与 0x 十六进制字符串 */
function pickHwnd(obj: unknown, keys: string[]): number | undefined {
  if (!isObject(obj)) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const text = value.trim();
      const parsed = /^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text, 16) : Number(text);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/** 尝试把文本解析为 JSON 对象（cua 部分工具以 text 返回结构化数据） */
function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function truncate(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（输出已截断）`;
}

/** 窗口面积（像素） */
function windowArea(bounds: { width: number; height: number }): number {
  return Math.max(0, bounds.width) * Math.max(0, bounds.height);
}

/** 两个窗口矩形是否相交 */
function rectsIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** 原生窗口信息 → 跨模块契约结构 */
function toProcessWindow(info: NativeWindowInfo): ComputerProcessWindow {
  return {
    windowId: info.hwnd,
    pid: info.pid,
    className: info.className,
    title: info.title,
    bounds: info.bounds,
    visible: info.visible,
    minimized: info.minimized,
    isForeground: info.isForeground,
    owner: info.owner,
    isPopup: info.isPopup,
    isToolWindow: info.isToolWindow,
    zOrder: info.zOrder,
  };
}

/** 是否为传输/连接层错误（可安全重连并重试；超时/中止不在此列） */
function isTransportErrorMessage(message: string): boolean {
  return /\bnot connected\b|connection closed|client is closed|transport closed|EPIPE|ECONNRESET|broken pipe|未连接|连接已关闭|MCP 客户端/i.test(
    message,
  );
}

export interface ComputerServiceDeps {
  logger: Logger;
  config: ConfigService;
  env: Environment;
  eventBus: EventBus;
  /** 事件投递：指定 sessionId 发该会话，否则广播；实现方惰性解析 SERVER_INSTANCE */
  emitter: (sessionId: string | undefined, message: unknown) => void;
}

export class ComputerServiceImpl implements ComputerService {
  private readonly logger: Logger;
  private readonly config: ConfigService;
  private readonly env: Environment;
  private readonly eventBus: EventBus;
  private readonly emitter: ComputerServiceDeps['emitter'];
  private readonly dirs: ComputerDirs;

  private driverPath: string | null = null;
  private version: string | null = null;
  private connection: ComputerConnectionState = 'disconnected';
  private error: string | null = null;
  private client: McpClient | null = null;
  private connectPromise: Promise<void> | null = null;
  private tools: McpToolInfo[] = [];
  private toolMap = new Map<string, McpToolInfo>();
  private screen: ComputerScreenInfo | null = null;
  private paused = false;
  private activities: ComputerActivity[] = [];
  private disposed = false;
  /** 连接失败冷却：避免驱动无响应时每次工具调用都重新拉起进程（进程风暴） */
  private nextConnectAt = 0;
  private consecutiveConnectFailures = 0;
  /** 聚焦防抖：同一窗口 2s 内不重复前置（避免每步都闪屏） */
  private lastFocusKey = '';
  private lastFocusAt = 0;
  /**
   * cua 会话标签：logicalKey（panel / 具体 MOSS 会话）→ 当前可用标签。
   * cua 的会话一旦 end_session 就不会被普通动作复活，必须显式 start_session 或换新标签，
   * 否则面板截图会永久失败（session 'moss_panel' has ended）。
   */
  private readonly sessionLabels = new Map<string, string>();
  /** 会话恢复单飞：并发截图同时命中 ended 错误时只执行一次复活/轮换/重连 */
  private readonly sessionRecovering = new Map<string, Promise<void>>();
  /** 恢复失败时轮换标签的序号 */
  private sessionSeq = 0;
  /** 最近一次健康检查结果（连接失败/截图失败/手动诊断时填充） */
  private health: ComputerHealth | null = null;
  private lastHealthAt = 0;

  constructor(deps: ComputerServiceDeps) {
    this.logger = deps.logger;
    this.config = deps.config;
    this.env = deps.env;
    this.eventBus = deps.eventBus;
    this.emitter = deps.emitter;
    this.dirs = getComputerDirs(deps.env);
  }

  async initialize(): Promise<void> {
    this.driverPath = resolveCuaDriverPath(this.env);
    if (!this.driverPath) {
      this.connection = 'disconnected';
      this.emitStatus();
      this.logger.info(t('computer.moduleInitializedWithoutDriver'));
      return;
    }
    // 目录准备、截图清理、版本探测与连接全部移到 warmup
    this.logger.info(t('computer.moduleInitialized'), { driverPath: this.driverPath });
  }

  /** 后台预热：目录创建 + 历史截图清理 + 原生窗口枚举 + 驱动探测/连接 */
  async warmup(): Promise<void> {
    ensureComputerDirs(this.dirs);
    try {
      pruneComputerFiles(this.dirs);
    } catch {
      // 清理失败不影响功能
    }
    // 原生窗口枚举（Windows/Bun FFI）：失败自动回退 cua list_windows，不阻塞启动
    await initNativeWindows();
    if (!this.driverPath) return;
    await this.bootstrapDriver();
    this.logger.info('computer: warmup completed', { driverPath: this.driverPath });
  }

  async destroy(): Promise<void> {
    this.disposed = true;
    const client = this.client;
    this.client = null;
    this.connection = 'disconnected';
    this.tools = [];
    this.toolMap.clear();
    this.sessionLabels.clear();
    this.sessionRecovering.clear();
    this.health = null;
    this.screen = null;
    if (client) {
      try {
        await client.disconnect();
      } catch (err) {
        this.logger.warn(t('computer.disconnectFailed', {
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }
  }

  private async bootstrapDriver(): Promise<void> {
    if (!this.driverPath) return;
    this.version = await this.readDriverVersion(this.driverPath);
    try {
      await this.ensureConnected();
    } catch (err) {
      this.logger.warn(t('computer.connectFailed', {
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    this.emitStatus();
  }

  getStatus(): ComputerStatus {
    // 手动安装后无需重启：每次读取时重新探测一次（existsSync 成本很低）
    if (!this.driverPath) {
      this.driverPath = resolveCuaDriverPath(this.env);
    }
    const installed = !!this.driverPath && existsSync(this.driverPath);

    let maxImageDimension = 1280;
    let allowForeground = true;
    try {
      const tools = this.config.getAppConfig().tools as Record<string, Record<string, unknown>>;
      const cfg = tools.computer ?? {};
      if (typeof cfg.maxImageDimension === 'number') maxImageDimension = cfg.maxImageDimension;
      if (typeof cfg.allowForeground === 'boolean') allowForeground = cfg.allowForeground;
    } catch {
      // 配置未加载时使用默认值
    }

    return {
      installed,
      driverPath: this.driverPath,
      version: this.version,
      connection: this.connection,
      toolCount: this.tools.length,
      screen: this.screen,
      paused: this.paused,
      platform: this.env.platform,
      supported: !this.env.isAndroid,
      capabilities: {
        startSession: this.toolMap.has('start_session'),
        healthReport: this.toolMap.has('health_report'),
        desktopCapture: this.toolMap.has('get_desktop_state'),
        windowCapture: this.toolMap.has('get_window_state'),
      },
      health: this.health,
      config: { maxImageDimension, allowForeground },
      error: this.error,
    };
  }

  async ensureConnected(force = false): Promise<void> {
    if (this.disposed) throw new Error(t('computer.serviceDisposed'));
    if (this.client && this.connection === 'connected') return;
    // 连接失败冷却：避免驱动持续无响应时每次调用都拉起新进程
    if (!force && Date.now() < this.nextConnectAt) {
      const seconds = Math.max(1, Math.ceil((this.nextConnectAt - Date.now()) / 1000));
      throw new Error(
        t('computer.connectCooldown', {
          seconds,
          error: this.error ?? t('computer.driverNotInstalled'),
        }),
      );
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    if (!this.driverPath) {
      this.driverPath = resolveCuaDriverPath(this.env);
    }
    if (!this.driverPath) {
      this.connection = 'disconnected';
      this.error = t('computer.driverNotInstalled');
      this.emitStatus();
      throw new Error(this.error);
    }

    this.connection = 'connecting';
    this.error = null;
    this.emitStatus();

    const driverDir = dirname(this.driverPath);
    const pathValue = `${driverDir}${sep}${process.env.PATH ?? process.env.Path ?? ''}`;
    const serverConfig: ServerConfig = {
      transport: 'stdio',
      command: this.driverPath,
      args: ['mcp'],
      env: { PATH: pathValue },
    };

    const client = new McpClient(
      'cua-driver',
      serverConfig,
      this.logger.child('cua-driver'),
      this.eventBus,
    );

    try {
      // McpClient 内部超时并关闭 transport，避免超时后留下半连接/孤儿进程
      await client.connect(CONNECT_TIMEOUT_MS);

      if (this.disposed) {
        await client.disconnect().catch(() => {});
        throw new Error(t('computer.serviceDisposed'));
      }

      this.client = client;
      this.tools = client.getTools();
      this.toolMap = new Map(this.tools.map(tool => [tool.name, tool]));
      this.connection = 'connected';
      this.error = null;
      this.nextConnectAt = 0;
      this.consecutiveConnectFailures = 0;
      // 新连接 = 新的 transport lease：旧会话标签状态全部作废
      this.sessionLabels.clear();
      this.sessionRecovering.clear();
      this.health = null;
      this.lastHealthAt = 0;
      this.screen = await this.readScreenSize(client);
      this.emitStatus();
      this.logger.info(t('computer.connected'), {
        driverPath: this.driverPath,
        toolCount: this.tools.length,
      });
      // 预热面板会话（best-effort）：避免首次面板截图撞上「会话不存在/已结束」多一次往返
      void this.prewarmPanelSession(client);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await client.disconnect();
      } catch {
        // 关闭失败忽略
      }
      this.client = null;
      this.tools = [];
      this.toolMap.clear();
      this.sessionLabels.clear();
      this.sessionRecovering.clear();
      this.screen = null;
      this.connection = 'error';
      this.error = message;
      this.consecutiveConnectFailures += 1;
      const backoff = Math.min(30_000, 5_000 * 2 ** Math.max(0, this.consecutiveConnectFailures - 1));
      this.nextConnectAt = Date.now() + backoff;
      this.emitStatus();
      throw new Error(t('computer.connectFailedWithReason', { message }));
    }
  }

  async reconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connection = 'disconnected';
    this.tools = [];
    this.toolMap.clear();
    this.sessionLabels.clear();
    this.sessionRecovering.clear();
    this.health = null;
    this.lastHealthAt = 0;
    this.screen = null;
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // 忽略
      }
    }
    this.driverPath = resolveCuaDriverPath(this.env);
    this.version = this.driverPath ? await this.readDriverVersion(this.driverPath) : null;
    // 手动重连：跳过冷却并重置失败计数
    this.nextConnectAt = 0;
    this.consecutiveConnectFailures = 0;
    await this.ensureConnected(true);
  }

  isPaused(): boolean {
    return this.paused;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.emitStatus();
  }

  listToolNames(): string[] {
    return this.tools.map(tool => tool.name);
  }

  supportsTool(name: string): boolean {
    return this.toolMap.has(name);
  }

  getToolSchema(name: string): unknown | null {
    return this.toolMap.get(name)?.inputSchema ?? null;
  }

  async callTool(
    tool: string,
    args: Record<string, unknown>,
    opts: ComputerCallOptions = {},
  ): Promise<ComputerToolResult> {
    const source = opts.source ?? 'agent';
    if (source !== 'panel' && this.paused) {
      throw new Error(t('computer.pausedByUser'));
    }

    await this.ensureConnected();

    const startedAt = Date.now();
    try {
      const { raw, retried } = await this.invokeWithRetry(tool, args, opts);
      const result = this.normalizeResult(raw);
      if (retried) {
        result.text = `${result.text}\n${t('computer.retryAfterReconnect')}`.trim();
      }
      this.recordActivity(tool, opts, result, Date.now() - startedAt, result.isError === true);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed: ComputerToolResult = { text: message, images: [], isError: true };
      this.recordActivity(tool, opts, failed, Date.now() - startedAt, true);
      // 工具级错误由 cua 以 isError 返回；这里抛出的多为传输/超时错误 → 标记连接失效，下次调用重连。
      if (!opts.signal?.aborted) this.markConnectionError(message);
      throw err;
    }
  }

  /**
   * 统一的 cua 调用通道：
   * 1) 按 schema 注入会话标签；
   * 2) 命中会话失效 → start_session 复活；仍失败 → 轮换新标签；仍失败 → 强制重连；
   * 3) 传输层错误重连后重试一次（超时/中止不重试）。
   */
  private async invokeWithRetry(
    tool: string,
    args: Record<string, unknown>,
    opts: ComputerCallOptions,
  ): Promise<{ raw: McpToolResult; retried: boolean }> {
    await this.ensureConnected();

    const finalArgs: Record<string, unknown> = { ...args };
    let key: string | null = null;
    let label: string | null = null;
    if (finalArgs.session === undefined && this.schemaHasSession(tool)) {
      key = this.logicalKey(opts);
      label = this.labelFor(key, opts);
      finalArgs.session = label;
    } else if (typeof finalArgs.session === 'string' && finalArgs.session) {
      key = this.logicalKey(opts);
      label = finalArgs.session;
      this.sessionLabels.set(key, label);
    }

    const timeoutMs = opts.timeoutMs ?? 120_000;
    let transportRetried = false;
    /** 会话恢复次数：0 未恢复；1 已复活/轮换；2 已强制重连 */
    let sessionRecovered = 0;

    const attempt = async (): Promise<McpToolResult> => {
      const client = this.client;
      if (!client) throw new Error(t('computer.serviceUnavailable'));
      return client.callTool(tool, finalArgs, { timeoutMs, signal: opts.signal });
    };

    /** 命中会话失效且还能恢复：执行恢复并返回 true */
    const recoverIfNeeded = async (message: string): Promise<boolean> => {
      if (!key || !label || opts.signal?.aborted === true) return false;
      if (this.isSessionEndedMessage(message) === false) return false;
      if (sessionRecovered >= 2) return false;
      sessionRecovered += 1;
      label = await this.recoverSession(key, label, sessionRecovered);
      finalArgs.session = label;
      return true;
    };

    for (;;) {
      try {
        const raw = await attempt();
        if (raw.isError === true && (await recoverIfNeeded(this.rawText(raw)))) {
          continue;
        }
        return { raw, retried: transportRetried };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const aborted =
          opts.signal?.aborted === true || (err instanceof Error && err.name === 'AbortError');
        if (aborted) throw err;
        // 会话失效也可能以异常形式抛出
        if (await recoverIfNeeded(message)) continue;
        // 传输类错误视为动作未投递：重连后自动重试一次；超时/中止不重试（动作可能已执行）
        if (!isTransportErrorMessage(message) || transportRetried) throw err;
        this.markConnectionError(message);
        transportRetried = true;
        await this.ensureConnected(true);
        // 新连接 = 新 transport lease：标签状态已清空，重新取基准标签
        if (key) {
          label = this.labelFor(key, opts);
          finalArgs.session = label;
        }
      }
    }
  }

  async captureDesktop(opts: { maxImageDimension?: number } = {}): Promise<ComputerCapture> {
    const path = newLivePath(this.dirs);
    const args: Record<string, unknown> = { screenshot_out_file: path };
    if (typeof opts.maxImageDimension === 'number' && opts.maxImageDimension > 0) {
      args.max_image_dimension = opts.maxImageDimension;
    }
    return this.capture('get_desktop_state', args, path);
  }

  async captureWindow(
    pid: number,
    windowId: number,
    opts: { maxImageDimension?: number } = {},
  ): Promise<ComputerCapture> {
    const path = newLivePath(this.dirs);
    const args: Record<string, unknown> = {
      pid,
      window_id: windowId,
      include_accessibility_tree: false,
      include_screenshot: true,
      display_only: true,
      screenshot_out_file: path,
    };
    if (typeof opts.maxImageDimension === 'number' && opts.maxImageDimension > 0) {
      args.max_image_dimension = opts.maxImageDimension;
    }
    return this.capture('get_window_state', args, path);
  }

  /**
   * 面板截图统一入口：走会话自愈/重连通道，产物标记为 transient（HTTP 读取后即删）。
   */
  private async capture(
    tool: string,
    args: Record<string, unknown>,
    fallbackPath: string,
  ): Promise<ComputerCapture> {
    let raw: McpToolResult;
    try {
      const resp = await this.invokeWithRetry(tool, args, {
        source: 'panel',
        sessionLabel: PANEL_SESSION,
        timeoutMs: 20_000,
      });
      raw = resp.raw;
    } catch (err) {
      // 截图失败常见于平台权限（macOS 辅助功能/屏幕录制）：限频刷一次健康检查，给出可操作提示
      void this.refreshHealthAfterFailure();
      throw err;
    }
    if (raw.isError) {
      if (!this.isSessionEndedMessage(this.rawText(raw))) void this.refreshHealthAfterFailure();
      throw new Error(this.cuaErrorMessage(raw));
    }
    const actualPath = this.resolveScreenshotPath(raw.structured, fallbackPath);
    if (!(await this.waitForScreenshotFile(actualPath))) {
      this.logScreenshotFailure(tool, actualPath, raw);
      void this.refreshHealthAfterFailure();
      throw new Error(t('computer.screenshotFailed'));
    }
    pruneLiveAfterCapture(this.dirs);
    return {
      path: actualPath,
      width: pickNumber(raw.structured, ['screenshot_width', 'width']),
      height: pickNumber(raw.structured, ['screenshot_height', 'height']),
      transient: true,
    };
  }

  getActivities(sessionId?: string): ComputerActivity[] {
    const list = sessionId
      ? this.activities.filter(item => item.sessionId === sessionId)
      : this.activities;
    return list.slice().sort((a, b) => b.ts - a.ts);
  }

  getDataDir(): string {
    return this.dirs.root;
  }

  createScreenshotPath(kind: string, pid?: number, windowId?: number): string {
    return newScreenshotPath(this.dirs, kind, pid, windowId);
  }

  /** 列出某进程的顶层窗口；Windows 原生枚举优先，失败回退 cua list_windows */
  async listProcessWindows(pid: number): Promise<ComputerProcessWindow[]> {
    const native = listNativeWindows(pid);
    if (native) return native.map(toProcessWindow);
    return this.listCuaWindows(pid);
  }

  /** 当前系统前台窗口（原生枚举不可用时返回 null） */
  getForegroundWindowInfo(): ComputerProcessWindow | null {
    const info = getNativeForegroundWindow();
    return info ? toProcessWindow(info) : null;
  }

  /**
   * 自动目标解析（浮层优先）。
   * 同一进程弹出浮层/对话框时返回最前面的浮层窗口，让截图与 UIA 树都针对它；
   * 否则返回请求窗口（未指定时返回主窗口）。
   */
  async resolveWindowTarget(
    pid: number,
    requestedWindowId?: number,
  ): Promise<ComputerWindowTarget> {
    const source: ComputerWindowTarget['source'] = isNativeWindowEnumerationAvailable()
      ? 'native'
      : 'cua';
    const all = await this.listProcessWindows(pid);
    const usable = all.filter(
      item =>
        item.visible &&
        !item.minimized &&
        item.bounds.width >= 80 &&
        item.bounds.height >= 60 &&
        !isInternalWindowClass(item.className) &&
        !isCuaOverlayWindow(item),
    );
    if (usable.length === 0) {
      const fallback =
        requestedWindowId ?? all.find(item => item.visible)?.windowId ?? requestedWindowId ?? 0;
      return { windowId: fallback, isOverlay: false, source };
    }

    const sorted = usable.slice().sort((a, b) => a.zOrder - b.zOrder);
    const main = sorted.reduce(
      (best, item) => (windowArea(item.bounds) > windowArea(best.bounds) ? item : best),
      sorted[0],
    );
    const mainArea = windowArea(main.bounds);
    const requested =
      requestedWindowId !== undefined
        ? sorted.find(item => item.windowId === requestedWindowId)
        : undefined;

    // 浮层候选：同进程、与主窗口相交、面积明显更小 / owned popup / WS_POPUP
    const overlays = sorted.filter(item => {
      if (item.windowId === main.windowId) return false;
      if (!rectsIntersect(item.bounds, main.bounds)) return false;
      if (windowArea(item.bounds) <= 6000) return false;
      return (
        windowArea(item.bounds) < mainArea * 0.92 ||
        item.owner === main.windowId ||
        (item.isPopup && !item.isToolWindow)
      );
    });

    const foreground = this.getForegroundWindowInfo();
    const foregroundOverlay =
      foreground && foreground.pid === pid
        ? overlays.find(item => item.windowId === foreground.windowId)
        : undefined;
    const requestedOverlay =
      requested && overlays.some(item => item.windowId === requested.windowId)
        ? requested
        : undefined;
    const zFrontOverlay = overlays.slice().sort((a, b) => a.zOrder - b.zOrder)[0];

    const overlay = foregroundOverlay ?? requestedOverlay ?? zFrontOverlay;
    const target = overlay ?? requested ?? main;
    return {
      windowId: target.windowId,
      isOverlay: target.windowId !== main.windowId,
      mainWindowId: main.windowId,
      className: target.className,
      title: target.title,
      bounds: target.bounds,
      source,
    };
  }

  /** cua list_windows 回退：只能拿到常规顶层窗口（无原生枚举时使用） */
  private async listCuaWindows(pid: number): Promise<ComputerProcessWindow[]> {
    try {
      const raw = await this.callTool(
        'list_windows',
        { pid, on_screen_only: true },
        { source: 'panel', timeoutMs: 8_000 },
      );
      if (raw.isError) return [];
      let list: unknown = raw.structured;
      if (!Array.isArray(list)) {
        if (isObject(list) && Array.isArray(list.windows)) list = list.windows;
        else list = parseJsonObject(raw.text);
        if (isObject(list) && Array.isArray((list as Record<string, unknown>).windows)) {
          list = (list as Record<string, unknown>).windows;
        }
      }
      if (!Array.isArray(list)) return [];
      return list
        .filter(isObject)
        .map((item, index) => {
          const boundsObj = isObject(item.bounds) ? item.bounds : {};
          const zIndex = pickNumber(item, ['z_index', 'zIndex']);
          return {
            windowId: pickHwnd(item, ['window_id', 'windowId', 'id']) ?? -1,
            pid,
            className: '',
            title: pickString(item, ['title']) ?? '',
            bounds: {
              x: pickNumber(boundsObj, ['x']) ?? 0,
              y: pickNumber(boundsObj, ['y']) ?? 0,
              width: pickNumber(boundsObj, ['width']) ?? 0,
              height: pickNumber(boundsObj, ['height']) ?? 0,
            },
            visible: pickBoolean(item, ['is_on_screen', 'onScreen']) !== false,
            minimized: pickBoolean(item, ['minimized']) === true,
            isForeground: false,
            owner: 0,
            isPopup: false,
            isToolWindow: false,
            zOrder: zIndex ?? index,
          };
        })
        .filter(item => item.windowId >= 0);
    } catch {
      return [];
    }
  }

  /**
   * 聚焦窗口：浮层优先（同进程弹出浮层时聚焦浮层，避免把主窗口压到浮层之上）；
   * 前台已是目标窗口时 no-op；浮层聚焦失败不再回退主窗口。
   */
  async focusWindow(
    pid: number,
    windowId?: number,
    opts: { force?: boolean } = {},
  ): Promise<ComputerFocusResult> {
    const target = await this.resolveWindowTarget(pid, windowId);
    const focusId = target.windowId;

    // 前台已经是目标窗口：不再重复前置（避免闪屏/把浮层压掉）
    const foreground = this.getForegroundWindowInfo();
    if (foreground && foreground.pid === pid && foreground.windowId === focusId) {
      this.lastFocusKey = `${pid}:${focusId}`;
      this.lastFocusAt = Date.now();
      return {
        ok: true,
        focusedWindowId: focusId,
        fallback: target.isOverlay,
        ...(target.isOverlay ? { overlay: true } : {}),
      };
    }

    const key = `${pid}:${focusId}`;
    if (!opts.force && this.lastFocusKey === key && Date.now() - this.lastFocusAt < 2000) {
      // 2s 内已聚焦同一窗口：不重复前置，避免连续动作导致闪屏
      return {
        ok: true,
        focusedWindowId: focusId,
        fallback: target.isOverlay,
        ...(target.isOverlay ? { overlay: true } : {}),
      };
    }

    const bring = async (targetWindowId?: number): Promise<number | undefined> => {
      await this.ensureConnected();
      const args: Record<string, unknown> = { pid };
      if (targetWindowId !== undefined) args.window_id = targetWindowId;
      const raw = await this.callTool('bring_to_front', args, {
        source: 'panel',
        timeoutMs: 8_000,
      });
      if (raw.isError) throw new Error(this.resultErrorMessage(raw));
      const structured = raw.structured ?? parseJsonObject(raw.text);
      return pickHwnd(structured, ['now_fg_hwnd', 'nowFgHwnd', 'window_id']);
    };

    try {
      const hwnd = await bring(focusId);
      const focused = hwnd === focusId || (typeof hwnd === 'number' && hwnd !== 0 && !target.isOverlay);
      if (focused) {
        this.lastFocusKey = key;
        this.lastFocusAt = Date.now();
        return {
          ok: true,
          ...(typeof hwnd === 'number' ? { focusedWindowId: hwnd } : {}),
          fallback: target.isOverlay,
          ...(target.isOverlay ? { overlay: true } : {}),
        };
      }
      // 浮层没有真正成为前台：不再回退主窗口（那会把浮层压掉/关闭）
      if (target.isOverlay) {
        return {
          ok: false,
          fallback: true,
          overlay: true,
          error: t('computer.focusFailed', { pid: String(pid) }),
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('computer: 目标窗口聚焦失败', {
        pid,
        windowId: focusId,
        overlay: target.isOverlay,
        error: message,
      });
      // 浮层聚焦失败：不再退到主窗口（那会把浮层压掉/关闭）
      if (target.isOverlay) {
        return { ok: false, fallback: true, overlay: true, error: message };
      }
    }

    // 回退 1：同 pid 的可见窗口（z_index 最大）
    const fallbackId = await this.pickFocusFallbackWindow(pid, focusId);
    if (fallbackId !== undefined) {
      try {
        const hwnd = await bring(fallbackId);
        if (typeof hwnd === 'number' && hwnd !== 0) {
          this.lastFocusKey = `${pid}:${fallbackId}`;
          this.lastFocusAt = Date.now();
          return { ok: true, focusedWindowId: fallbackId, fallback: true };
        }
      } catch {
        // 继续最后一个回退
      }
    }

    // 回退 2：不指定 window_id，让驱动选择该 pid 的首个可见顶层窗口（主窗口）
    try {
      const hwnd = await bring(undefined);
      if (typeof hwnd === 'number' && hwnd !== 0) {
        this.lastFocusKey = `${pid}:`;
        this.lastFocusAt = Date.now();
        return { ok: true, focusedWindowId: hwnd, fallback: true };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, fallback: true, error: message };
    }
    return {
      ok: false,
      fallback: true,
      error: t('computer.focusFailed', { pid: String(pid) }),
    };
  }

  /** 解析 list_windows，选出同 pid 可见且 z_index 最大的窗口（排除聚焦失败的原窗口） */
  private async pickFocusFallbackWindow(
    pid: number,
    excludeWindowId?: number,
  ): Promise<number | undefined> {
    try {
      const raw = await this.callTool('list_windows', { pid }, { source: 'panel', timeoutMs: 8_000 });
      if (raw.isError) return undefined;
      let list: unknown = raw.structured;
      if (!Array.isArray(list)) {
        if (isObject(list) && Array.isArray(list.windows)) list = list.windows;
        else {
          const text = raw.text.trim();
          list = parseJsonObject(text);
          if (isObject(list) && Array.isArray(list.windows)) list = list.windows;
        }
      }
      if (!Array.isArray(list)) return undefined;
      const candidates = list
        .filter(isObject)
        .map(item => ({
          windowId: pickHwnd(item, ['window_id', 'windowId', 'id']),
          onScreen: pickBoolean(item, ['is_on_screen', 'onScreen']),
          minimized: pickBoolean(item, ['minimized']),
          zIndex: pickNumber(item, ['z_index', 'zIndex']),
        }))
        .filter(
          item =>
            typeof item.windowId === 'number' &&
            item.windowId !== excludeWindowId &&
            item.minimized !== true &&
            item.onScreen !== false,
        )
        .sort((a, b) => (b.zIndex ?? -1) - (a.zIndex ?? -1));
      return candidates[0]?.windowId;
    } catch {
      return undefined;
    }
  }

  async install(): Promise<{ ok: boolean; output: string }> {
    if (this.env.isAndroid) {
      return { ok: false, output: t('computer.installUnsupported') };
    }

    this.connection = 'installing';
    this.error = null;
    this.emitStatus();

    const windows = this.env.isWindows;
    const scriptPath = join(this.dirs.root, windows ? 'install.ps1' : 'install.sh');
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const resp = await fetch(windows ? WINDOWS_INSTALLER_URL : UNIX_INSTALLER_URL);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const script = await resp.text();
      if (!script.trim()) throw new Error('empty installer script');
      writeFileSync(scriptPath, script, 'utf8');

      const proc = Bun.spawn(
        windows
          ? [
              'powershell.exe',
              '-NoProfile',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              scriptPath,
              '-NoAutoStart',
              '-NoPathUpdate',
            ]
          : // macOS / Linux：官方 install.sh，禁止改写 shell rc（--no-modify-path）
            ['/bin/bash', scriptPath, '--no-modify-path'],
        windows
          ? { stdout: 'pipe', stderr: 'pipe', windowsHide: true }
          : { stdout: 'pipe', stderr: 'pipe' },
      );

      const timeout = new Promise<'timeout'>(resolvePromise => {
        timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // 忽略
          }
          resolvePromise('timeout');
        }, INSTALL_TIMEOUT_MS);
      });

      const outputPromise = (async () => {
        const [out, err] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const code = await proc.exited;
        return { code, output: `${out}\n${err}`.trim() };
      })();

      const raced = await Promise.race([outputPromise, timeout]);
      if (raced === 'timeout') {
        this.connection = 'error';
        this.error = t('computer.installTimeout');
        this.emitStatus();
        return { ok: false, output: this.error };
      }

      if (raced.code !== 0) {
        this.connection = 'error';
        this.error = t('computer.installFailed', { code: raced.code });
        this.emitStatus();
        return { ok: false, output: truncate(this.error + '\n' + raced.output) };
      }

      this.driverPath = resolveCuaDriverPath(this.env);
      this.version = this.driverPath ? await this.readDriverVersion(this.driverPath) : null;
      if (!this.driverPath) {
        this.connection = 'error';
        this.error = t('computer.installPathNotFound');
        this.emitStatus();
        return { ok: false, output: truncate(this.error + '\n' + raced.output) };
      }

      // 安装完成后自动重连（失败由 reconnect 抛错，状态已广播）
      try {
        await this.reconnect();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, output: truncate(`${raced.output}\n${message}`) };
      }
      return { ok: true, output: truncate(raced.output) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.connection = 'error';
      this.error = message;
      this.emitStatus();
      return { ok: false, output: t('computer.installFailedWithReason', { message }) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ========================================================================
  // 内部工具
  // ========================================================================

  /** cua 工具 schema 是否声明 session 字段 */
  private schemaHasSession(tool: string): boolean {
    const schema = this.getToolSchema(tool) as McpInputSchemaLike | null;
    return !!schema?.properties && Object.prototype.hasOwnProperty.call(schema.properties, 'session');
  }

  /** MOSS 会话 id → 稳定 cua 会话标签 */
  private sessionLabel(sessionId?: string): string {
    if (!sessionId) return 'moss_shared';
    const hash = createHash('sha1').update(sessionId).digest('hex').slice(0, 10);
    return `moss_${hash}`;
  }

  /** 逻辑会话键：面板独立一路，Agent 按 MOSS 会话隔离 */
  private logicalKey(opts: ComputerCallOptions): string {
    if ((opts.source ?? 'agent') === 'panel') return '__panel__';
    return opts.sessionId ? `session:${opts.sessionId}` : '__shared__';
  }

  /** 取（或初始化）逻辑会话当前可用的 cua 标签 */
  private labelFor(key: string, opts: ComputerCallOptions): string {
    const existing = this.sessionLabels.get(key);
    if (existing) return existing;
    const label = opts.sessionLabel ?? this.sessionLabel(opts.sessionId);
    this.sessionLabels.set(key, label);
    return label;
  }

  /** cua 的「会话失效」错误（普通动作不会复活已结束/不存在的公开标签） */
  private isSessionEndedMessage(message: string): boolean {
    return (
      /session\s+['"]?[A-Za-z0-9_.:-]+['"]?\s+(?:has ended|expired|is invalid)/i.test(message) ||
      /\bsession\s+(?:not found|does not exist|expired)\b/i.test(message) ||
      /\b(?:unknown|no such|invalid|missing)\s+session\b/i.test(message)
    );
  }

  /** 结果中的文本部分（用于错误识别与结构化兜底解析） */
  private rawText(raw: McpToolResult): string {
    return raw.content
      .filter(part => part.type === 'text')
      .map(part => (part.type === 'text' ? part.text : ''))
      .join('\n');
  }

  /** 生成新的会话标签（cua 明确允许「or use a new session label」） */
  private nextSessionLabel(base: string): string {
    return `${base}_r${++this.sessionSeq}`;
  }

  /**
   * 会话恢复：attempt=1 先 start_session 复活（幂等），失败则轮换新标签；
   * attempt=2 强制重建 MCP 连接（新 transport lease）并用全新标签。
   * 同一逻辑会话的并发恢复走单飞，避免面板 1.5s 轮询重复执行。
   */
  private async recoverSession(key: string, label: string, attempt: number): Promise<string> {
    const inflight = this.sessionRecovering.get(key);
    if (inflight) {
      await inflight;
      return this.sessionLabels.get(key) ?? label;
    }
    const task = this.doRecoverSession(key, label, attempt);
    this.sessionRecovering.set(key, task);
    try {
      await task;
    } finally {
      this.sessionRecovering.delete(key);
    }
    return this.sessionLabels.get(key) ?? label;
  }

  private async doRecoverSession(key: string, label: string, attempt: number): Promise<void> {
    if (attempt <= 1) {
      const client = this.client;
      if (client && this.toolMap.has('start_session')) {
        try {
          const raw = await client.callTool(
            'start_session',
            { session: label },
            { timeoutMs: SESSION_REVIVE_TIMEOUT_MS },
          );
          if (raw.isError !== true) {
            this.sessionLabels.set(key, label);
            this.logger.info('computer: session revived', { key, label });
            return;
          }
        } catch {
          // 复活失败 → 走标签轮换
        }
      }
      const next = this.nextSessionLabel(label);
      this.sessionLabels.set(key, next);
      this.logger.warn('computer: session rotated', { key, from: label, to: next });
      return;
    }

    // 复活与轮换都失败：强制重建连接（transport lease 变化后旧会话全部作废）
    this.sessionLabels.delete(key);
    this.markConnectionError('session recovery failed');
    await this.ensureConnected(true);
    const next = this.nextSessionLabel(label);
    this.sessionLabels.set(key, next);
    this.logger.warn('computer: session reconnected', { key, to: next });
  }

  /** 连接成功后预热面板会话（失败静默；避免首帧多一次往返） */
  private async prewarmPanelSession(client: McpClient): Promise<void> {
    if (!this.toolMap.has('start_session')) return;
    try {
      const raw = await client.callTool(
        'start_session',
        { session: PANEL_SESSION },
        { timeoutMs: SESSION_PREWARM_TIMEOUT_MS },
      );
      if (raw.isError !== true) this.sessionLabels.set('__panel__', PANEL_SESSION);
    } catch {
      // 预热失败不影响连接；真正调用时会再自愈
    }
  }

  /** 手动/失败后健康检查（cua health_report）：平台能力与权限诊断 */
  async checkHealth(): Promise<ComputerHealth | null> {
    if (this.connection !== 'connected' || !this.toolMap.has('health_report')) return null;
    try {
      const { raw } = await this.invokeWithRetry('health_report', {}, {
        source: 'panel',
        sessionLabel: PANEL_SESSION,
        timeoutMs: 8_000,
      });
      const structured = raw.structured ?? parseJsonObject(this.rawText(raw));
      const health = this.parseHealth(structured);
      this.lastHealthAt = Date.now();
      if (health) {
        this.health = health;
        this.emitStatus();
      }
      return health;
    } catch (err) {
      this.logger.debug('computer: health check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** 截图失败后限频刷新健康检查（给出 macOS 权限等可操作提示） */
  private async refreshHealthAfterFailure(): Promise<void> {
    if (Date.now() - this.lastHealthAt < HEALTH_MIN_INTERVAL_MS) return;
    await this.checkHealth();
  }

  /** health_report 结构化结果 → ComputerHealth */
  private parseHealth(value: unknown): ComputerHealth | null {
    if (!isObject(value)) return null;
    const overall = pickString(value, ['overall']);
    if (overall !== 'ok' && overall !== 'degraded' && overall !== 'failed') return null;
    const rawChecks = Array.isArray(value.checks) ? value.checks : [];
    const checks: ComputerHealthCheck[] = [];
    for (const item of rawChecks) {
      if (!isObject(item)) continue;
      const name = pickString(item, ['name']);
      const status = pickString(item, ['status']);
      if (!name || (status !== 'pass' && status !== 'fail' && status !== 'skip')) continue;
      const message = pickString(item, ['message']) ?? '';
      const hint = pickString(item, ['hint']);
      checks.push({ name, status, message, ...(hint ? { hint } : {}) });
    }
    return { overall, checks, checkedAt: Date.now() };
  }

  /** McpClient 结果 → ComputerToolResult（image content 落盘并带 path） */
  private normalizeResult(raw: McpToolResult): ComputerToolResult {
    const texts: string[] = [];
    const images: ComputerToolResult['images'] = [];
    for (const part of raw.content) {
      if (part.type === 'text') {
        if (part.text) texts.push(part.text);
      } else if (part.type === 'image') {
        const saved = this.saveImageData(part.data, part.mimeType);
        if (saved) images.push(saved);
      }
    }
    return {
      text: texts.join('\n'),
      images,
      structured: raw.structured,
      isError: raw.isError === true,
    };
  }

  /** base64 图片落盘（zoom 等内联返回的图片），返回带 path 的 image 记录 */
  private saveImageData(
    data: string,
    mimeType: string,
  ): { data: string; mimeType: string; path: string } | null {
    if (!data) return null;
    try {
      const mime = mimeType || 'image/png';
      const ext = mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png';
      let path = this.createScreenshotPath('inline');
      if (ext !== '.png') path = path.replace(/\.png$/, ext);
      writeFileSync(path, Buffer.from(data, 'base64'));
      return { data, mimeType: mime, path };
    } catch (err) {
      this.logger.warn(t('computer.saveImageFailed', {
        error: err instanceof Error ? err.message : String(err),
      }));
      return null;
    }
  }

  /** cua structuredContent.screenshot_file_path（可能带 ~）→ 绝对路径 */
  private resolveScreenshotPath(structured: unknown, fallback: string): string {
    const raw = pickString(structured, ['screenshot_file_path', 'screenshot_path', 'file_path']);
    if (!raw) return fallback;
    let path = raw;
    if (path.startsWith('~')) path = join(this.env.homeDir, path.slice(1));
    if (!isAbsolute(path)) path = resolve(dirname(fallback), path);
    return path;
  }

  /**
   * 等待 cua 把 screenshot_out_file 落盘（工具返回与文件 flush 之间可能有毫秒级竞态）。
   * 最多等待 1500ms，仍不存在则视为截图失败。
   */
  private async waitForScreenshotFile(path: string, timeoutMs = 1500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const st = statSync(path);
        if (st.isFile() && st.size > 0) return true;
      } catch {
        // 文件尚未创建
      }
      if (Date.now() >= deadline) return false;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    }
  }

  /** 截图文件缺失时记录可诊断信息（不把路径/内容暴露给模型） */
  private logScreenshotFailure(tool: string, path: string, raw: McpToolResult): void {
    const text = raw.content
      .filter(part => part.type === 'text')
      .map(part => (part.type === 'text' ? part.text : ''))
      .join('\n')
      .slice(0, 1000);
    this.logger.warn(t('computer.screenshotFailed'), {
      tool,
      path,
      structured: raw.structured,
      text,
    });
  }

  /** cua 工具错误 → 可读错误文本（code + message），供面板/工具直接展示 */
  private cuaErrorMessage(raw: McpToolResult): string {
    const text = raw.content
      .filter(part => part.type === 'text')
      .map(part => (part.type === 'text' ? part.text : ''))
      .join('\n')
      .trim();
    const code = pickString(raw.structured, ['code']);
    if (text && code) return `${text} (${code})`;
    if (text) return text;
    return code ? `cua-driver error: ${code}` : t('computer.screenshotFailed');
  }

  /** 归一化结果（ComputerToolResult）→ 可读错误文本 */
  private resultErrorMessage(raw: ComputerToolResult): string {
    const text = raw.text.trim();
    const code = pickString(raw.structured, ['code']);
    if (text && code) return `${text} (${code})`;
    if (text) return text;
    return code ? `cua-driver error: ${code}` : t('computer.screenshotFailed');
  }

  /** 传输/超时错误：丢弃当前 client，下次 ensureConnected 重新拉起驱动 */
  private markConnectionError(message: string): void {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    this.connection = 'error';
    this.error = message;
    this.tools = [];
    this.toolMap.clear();
    this.screen = null;
    this.emitStatus();
    void client.disconnect().catch(() => {});
  }

  /** 读取主显示器尺寸（失败返回 null，不影响连接；连接期间不触发重连以免自我等待） */
  private async readScreenSize(client: McpClient): Promise<ComputerScreenInfo | null> {
    if (!client.getTools().some(tool => tool.name === 'get_screen_size')) return null;
    try {
      const raw = await client.callTool(
        'get_screen_size',
        { session: PANEL_SESSION },
        { timeoutMs: 10_000 },
      );
      const structured = raw.structured ?? parseJsonObject(this.rawText(raw));
      const width = pickNumber(structured, ['width', 'screen_width']);
      const height = pickNumber(structured, ['height', 'screen_height']);
      const scale =
        pickNumber(structured, ['scale_factor', 'scale', 'backing_scale_factor']) ?? null;
      if (typeof width === 'number' && typeof height === 'number') {
        return { width, height, scale };
      }
    } catch (err) {
      this.logger.debug(t('computer.screenSizeFailed', {
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    return null;
  }

  /** 读取驱动版本（失败返回 null） */
  private async readDriverVersion(path: string): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const proc = Bun.spawn([path, '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
      });
      const timeout = new Promise<null>(resolvePromise => {
        timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // 忽略
          }
          resolvePromise(null);
        }, VERSION_TIMEOUT_MS);
      });
      const resultPromise = (async () => {
        const out = await new Response(proc.stdout).text();
        const code = await proc.exited;
        if (code !== 0) return null;
        const line = out.trim().split(/\r?\n/)[0] ?? '';
        return line || null;
      })();
      return await Promise.race([resultPromise, timeout]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 记录一次工具活动（仅 Agent 来源），并推送 WS 事件 */
  private recordActivity(
    tool: string,
    opts: ComputerCallOptions,
    result: ComputerToolResult,
    durationMs: number,
    isError: boolean,
  ): void {
    if ((opts.source ?? 'agent') !== 'agent') return;

    const effect = pickString(result.structured, ['effect', 'result.effect']);
    const verified = pickBoolean(result.structured, ['verified', 'result.verified']);
    const screenshotPath = opts.screenshotPath ?? result.images[0]?.path;
    const activity: ComputerActivity = {
      id: randomUUID(),
      ts: Date.now(),
      sessionId: opts.sessionId,
      action: opts.action ?? tool,
      tool,
      target: opts.target ?? '',
      summary: opts.summary ?? opts.action ?? tool,
      ...(effect ? { effect } : {}),
      ...(verified !== undefined ? { verified } : {}),
      ...(isError ? { isError: true } : {}),
      ...(durationMs >= 0 ? { durationMs } : {}),
      ...(screenshotPath ? { screenshotPath } : {}),
    };

    this.activities.push(activity);
    if (this.activities.length > MAX_ACTIVITIES) {
      this.activities.splice(0, this.activities.length - MAX_ACTIVITIES);
    }
    this.emitter(activity.sessionId, {
      type: 'computer.activity',
      sessionId: activity.sessionId,
      payload: activity,
    });
  }

  private emitStatus(): void {
    this.emitter(undefined, { type: 'computer.status', payload: this.getStatus() });
  }
}
