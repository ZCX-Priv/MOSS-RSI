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
  ComputerScreenInfo,
  ComputerService,
  ComputerStatus,
  ComputerToolResult,
} from './types';
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

/** cua 官方 Windows 安装脚本 */
const WINDOWS_INSTALLER_URL =
  'https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1';

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

  constructor(deps: ComputerServiceDeps) {
    this.logger = deps.logger;
    this.config = deps.config;
    this.env = deps.env;
    this.eventBus = deps.eventBus;
    this.emitter = deps.emitter;
    this.dirs = getComputerDirs(deps.env);
  }

  async initialize(): Promise<void> {
    ensureComputerDirs(this.dirs);
    // 清理历史截图（失败不影响启动）
    pruneComputerFiles(this.dirs);

    this.driverPath = resolveCuaDriverPath(this.env);
    if (!this.driverPath) {
      this.connection = 'disconnected';
      this.emitStatus();
      this.logger.info(t('computer.moduleInitializedWithoutDriver'));
      return;
    }

    // 后台探测版本并连接，不阻塞内核模块初始化链
    void this.bootstrapDriver();
    this.logger.info(t('computer.moduleInitialized'), { driverPath: this.driverPath });
  }

  async destroy(): Promise<void> {
    this.disposed = true;
    const client = this.client;
    this.client = null;
    this.connection = 'disconnected';
    this.tools = [];
    this.toolMap.clear();
    this.screen = null;
    if (client) {
      try {
        await client.disconnect();
      } catch (err) {
        this.logger.warn(t('computer.disconnectFailed'), {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async bootstrapDriver(): Promise<void> {
    if (!this.driverPath) return;
    this.version = await this.readDriverVersion(this.driverPath);
    try {
      await this.ensureConnected();
    } catch (err) {
      this.logger.warn(t('computer.connectFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
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
      config: { maxImageDimension, allowForeground },
      error: this.error,
    };
  }

  async ensureConnected(): Promise<void> {
    if (this.disposed) throw new Error(t('computer.serviceDisposed'));
    if (this.client && this.connection === 'connected') return;
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

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`connect timeout after ${CONNECT_TIMEOUT_MS}ms`)),
          CONNECT_TIMEOUT_MS,
        );
      });
      await Promise.race([client.connect(), timeout]);

      if (this.disposed) {
        await client.disconnect().catch(() => {});
        throw new Error(t('computer.serviceDisposed'));
      }

      this.client = client;
      this.tools = client.getTools();
      this.toolMap = new Map(this.tools.map(tool => [tool.name, tool]));
      this.connection = 'connected';
      this.error = null;
      this.screen = await this.readScreenSize(client);
      this.emitStatus();
      this.logger.info(t('computer.connected'), {
        driverPath: this.driverPath,
        toolCount: this.tools.length,
      });
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
      this.screen = null;
      this.connection = 'error';
      this.error = message;
      this.emitStatus();
      throw new Error(t('computer.connectFailedWithReason', { message }));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async reconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connection = 'disconnected';
    this.tools = [];
    this.toolMap.clear();
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
    await this.ensureConnected();
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
    const client = this.client;
    if (!client) throw new Error(t('computer.serviceUnavailable'));

    const finalArgs: Record<string, unknown> = { ...args };
    if (finalArgs.session === undefined && this.schemaHasSession(tool)) {
      finalArgs.session = opts.sessionLabel ?? this.sessionLabel(opts.sessionId);
    }

    const startedAt = Date.now();
    try {
      const raw = await client.callTool(tool, finalArgs, {
        timeoutMs: opts.timeoutMs ?? 120_000,
        signal: opts.signal,
      });
      const result = this.normalizeResult(raw);
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

  async captureDesktop(opts: { maxImageDimension?: number } = {}): Promise<ComputerCapture> {
    await this.ensureConnected();
    const client = this.client;
    if (!client) throw new Error(t('computer.serviceUnavailable'));

    const path = newLivePath(this.dirs);
    const args: Record<string, unknown> = {
      screenshot_out_file: path,
      session: PANEL_SESSION,
    };
    if (typeof opts.maxImageDimension === 'number' && opts.maxImageDimension > 0) {
      args.max_image_dimension = opts.maxImageDimension;
    }

    const raw = await client.callTool('get_desktop_state', args, { timeoutMs: 20_000 }).catch(err => {
      this.markConnectionError(err instanceof Error ? err.message : String(err));
      throw err;
    });
    if (raw.isError) throw new Error(this.cuaErrorMessage(raw));
    const actualPath = this.resolveScreenshotPath(raw.structured, path);
    if (!(await this.waitForScreenshotFile(actualPath))) {
      this.logScreenshotFailure('get_desktop_state', actualPath, raw);
      throw new Error(t('computer.screenshotFailed'));
    }
    pruneLiveAfterCapture(this.dirs);
    return {
      path: actualPath,
      width: pickNumber(raw.structured, ['screenshot_width', 'width']),
      height: pickNumber(raw.structured, ['screenshot_height', 'height']),
    };
  }

  async captureWindow(
    pid: number,
    windowId: number,
    opts: { maxImageDimension?: number } = {},
  ): Promise<ComputerCapture> {
    await this.ensureConnected();
    const client = this.client;
    if (!client) throw new Error(t('computer.serviceUnavailable'));

    const path = newLivePath(this.dirs);
    const args: Record<string, unknown> = {
      pid,
      window_id: windowId,
      include_accessibility_tree: false,
      include_screenshot: true,
      display_only: true,
      screenshot_out_file: path,
      session: PANEL_SESSION,
    };
    if (typeof opts.maxImageDimension === 'number' && opts.maxImageDimension > 0) {
      args.max_image_dimension = opts.maxImageDimension;
    }

    const raw = await client.callTool('get_window_state', args, { timeoutMs: 20_000 }).catch(err => {
      this.markConnectionError(err instanceof Error ? err.message : String(err));
      throw err;
    });
    if (raw.isError) throw new Error(this.cuaErrorMessage(raw));
    const actualPath = this.resolveScreenshotPath(raw.structured, path);
    if (!(await this.waitForScreenshotFile(actualPath))) {
      this.logScreenshotFailure('get_window_state', actualPath, raw);
      throw new Error(t('computer.screenshotFailed'));
    }
    pruneLiveAfterCapture(this.dirs);
    return {
      path: actualPath,
      width: pickNumber(raw.structured, ['screenshot_width', 'width']),
      height: pickNumber(raw.structured, ['screenshot_height', 'height']),
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

  async install(): Promise<{ ok: boolean; output: string }> {
    if (!this.env.isWindows) {
      return { ok: false, output: t('computer.installUnsupported') };
    }

    this.connection = 'installing';
    this.error = null;
    this.emitStatus();

    const scriptPath = join(this.dirs.root, 'install.ps1');
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const resp = await fetch(WINDOWS_INSTALLER_URL);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const script = await resp.text();
      if (!script.trim()) throw new Error('empty installer script');
      writeFileSync(scriptPath, script, 'utf8');

      const proc = Bun.spawn(
        [
          'powershell.exe',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          '-NoAutoStart',
          '-NoPathUpdate',
        ],
        { stdout: 'pipe', stderr: 'pipe', windowsHide: true },
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
      this.logger.warn(t('computer.saveImageFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
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
   * 最多等待 800ms，仍不存在则视为截图失败。
   */
  private async waitForScreenshotFile(path: string, timeoutMs = 800): Promise<boolean> {
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

  /** 读取主显示器尺寸（失败返回 null，不影响连接） */
  private async readScreenSize(client: McpClient): Promise<ComputerScreenInfo | null> {
    if (!client.getTools().some(tool => tool.name === 'get_screen_size')) return null;
    try {
      const raw = await client.callTool('get_screen_size', { session: PANEL_SESSION }, { timeoutMs: 10_000 });
      const text = raw.content
        .filter(part => part.type === 'text')
        .map(part => (part.type === 'text' ? part.text : ''))
        .join('\n');
      const structured = raw.structured ?? parseJsonObject(text);
      const width = pickNumber(structured, ['width', 'screen_width']);
      const height = pickNumber(structured, ['height', 'screen_height']);
      const scale =
        pickNumber(structured, ['scale_factor', 'scale', 'backing_scale_factor']) ?? null;
      if (typeof width === 'number' && typeof height === 'number') {
        return { width, height, scale };
      }
    } catch (err) {
      this.logger.debug(t('computer.screenSizeFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
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
