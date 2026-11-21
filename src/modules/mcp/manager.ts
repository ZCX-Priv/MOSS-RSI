// src/modules/mcp/manager.ts
// MCP 多服务器生命周期管理。
//
// 服务器定义来源（按优先级合并）：
//   1. ~/.moss/mcps/*.json  （用户实例，每个文件一个 server）
//   2. <packageRoot>/mcps/*.json （默认模板，首次运行时复制到用户目录）
//   3. config.json.mcpServers   （已 deprecated，仅为向后兼容保留；非空时 warn）

import { t } from '../../core/i18n';
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  McpClient,
  type McpClientEntry,
  type McpClientHooks,
  type McpElicitOutcome,
  type McpElicitRequest,
  type McpToolInfo,
  type McpToolResult,
  type ServerConfig,
} from './client';
import type { MCPManager, McpToolAnnotations, LLMRouter } from '../contracts';
import type { ConfigService, EventBus, Environment, Logger, ServiceRegistry } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { UnifiedMessage } from '../llm/types';
import { readdir, readFile, stat, mkdir, copyFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

/** 服务器运行状态（connecting 用于前端展示与安装反馈） */
type ServerStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface ServerState {
  status: ServerStatus;
  lastError?: string;
  retryCount: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  /** 同一服务器的并发 connect 合并到该 Promise，避免重复 spawn 子进程 */
  inFlight?: Promise<void>;
  /** 正在连接中的 client：断开/删除时可立即中止，而不是等初始化超时 */
  connectingClient?: McpClient;
  /** 用户主动断开/禁用：阻止自动重连 */
  manualStop?: boolean;
}

/** 自动重连退避序列（毫秒，之后固定 60s） */
const RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

export class MCPManagerImpl implements MCPManager {
  private readonly entries = new Map<string, McpClientEntry>();
  /** 每台服务器的运行状态（连接中/已连接/失败/断开 + 重试定时器） */
  private readonly states = new Map<string, ServerState>();
  /** 正在删除的服务器：阻止重连调度与 reload 期间的重新连接 */
  private readonly deleting = new Set<string>();
  private readonly config: ConfigService;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly env: Environment;
  private readonly services: ServiceRegistry;
  /** 当前合并后的服务器定义（按 name 索引） */
  private serverDefs: Map<string, ServerConfig> = new Map();
  private mcpsWatcher?: FSWatcher;
  private watchStarted = false;
  /** 重载代次：每次 reloadAll/shutdown 递增，用于作废重载前发起、重载后才完成的连接 */
  private epoch = 0;
  /** 进程关闭中：阻止重连调度 */
  private shuttingDown = false;

  constructor(deps: {
    config: ConfigService;
    eventBus: EventBus;
    logger: Logger;
    env: Environment;
    services: ServiceRegistry;
  }) {
    this.config = deps.config;
    this.eventBus = deps.eventBus;
    this.logger = deps.logger;
    this.env = deps.env;
    this.services = deps.services;
  }

  /**
   * sampling 钩子：MCP 服务器借用本地 LLM 生成。
   * config.mcp.allowSampling=false 时不注入（能力不声明，server 不会发起）。
   * 模型：请求带 model 时按 id/model 解析，否则用 agent.defaultModel。
   */
  private buildSamplingHook(): McpClientHooks {
    return {
      onSampling: async req => {
        const cfg = this.config.getAppConfig();
        if (cfg.mcp?.allowSampling === false) {
          throw new Error('sampling is disabled by config (mcp.allowSampling=false)');
        }
        const llm = this.services.tryResolve<LLMRouter>(ServiceNames.LLM_ROUTER);
        if (!llm) {
          throw new Error('LLM router not available');
        }
        // 映射 sampling 消息（content 可能是 string 或 content block 数组）
        const messages: UnifiedMessage[] = [];
        if (req.systemPrompt) {
          messages.push({ role: 'system', content: req.systemPrompt });
        }
        for (const m of req.messages) {
          let text = '';
          if (typeof m.content === 'string') {
            text = m.content;
          } else if (Array.isArray(m.content)) {
            text = (m.content as Array<{ type: string; text?: string }>)
              .filter(p => p.type === 'text')
              .map(p => p.text ?? '')
              .join('\n');
          }
          messages.push({ role: m.role, content: text });
        }
        const model =
          req.model && req.model !== '?'
            ? req.model
            : this.config.getAppConfig().agent.defaultModel;
        const result = await llm.complete({
          model,
          messages,
          max_tokens: Math.min(req.maxTokens || 1024, 8192),
          stream: false,
        });
        return {
          role: 'assistant' as const,
          model,
          content: { type: 'text' as const, text: result.content },
          stopReason:
            result.finish_reason === 'length' ? ('max_tokens' as const) : ('endturn' as const),
        };
      },
    };
  }

  /**
   * 初始化：从 mcps/ 目录与 config.json 加载所有 MCP 服务器定义。
   * 连接在后台逐个进行（不阻塞启动——stdio 子进程握手可达数十秒，
   * 拖慢 kernel 模块初始化链；连接完成后经 mcp:server:* 事件通知前端刷新）。
   */
  async initialize(): Promise<void> {
    this.serverDefs = await this.loadServerDefs();
    const names = Array.from(this.serverDefs.keys());
    // 未配置任何 MCP 服务器是正常状态（定义在 ~/.moss/mcps/*.json），只在 debug 记录
    if (names.length > 0) {
      this.logger.info(t('mcp.managerInitializing'), { serverCount: names.length, names });
    } else {
      this.logger.debug(t('mcp.managerInitializing'), { serverCount: 0, names: [] });
    }

    // 后台连接（单服务器失败不影响其他；禁用的跳过）。
    // connect 内部自带 180s 初始化超时与失败自动重连，启动阶段不阻塞模块初始化。
    for (const name of names) {
      if (this.serverDefs.get(name)?.enabled === false) {
        this.logger.info(t('mcp.serverDisabledSkip', { name }));
        this.stateOf(name).status = 'disconnected';
        continue;
      }
      void this.connect(name).catch(() => {});
    }

    // 监听用户 mcps 目录配置变更，实现热重载（延迟启动，避免启动期 watcher 开销）
    setTimeout(() => this.startWatch(), 1000);
  }

  /** 读取/创建某台服务器的运行状态 */
  private stateOf(name: string): ServerState {
    let state = this.states.get(name);
    if (!state) {
      state = { status: 'disconnected', retryCount: 0 };
      this.states.set(name, state);
    }
    return state;
  }

  /** 清除重连定时器 */
  private clearRetryTimer(state: ServerState): void {
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = undefined;
    }
  }

  /** 失败后按退避序列安排自动重连（持续重试，间隔封顶 60s） */
  private scheduleReconnect(name: string): void {
    if (this.shuttingDown || this.deleting.has(name)) return;
    const def = this.serverDefs.get(name);
    if (!def || def.enabled === false) return;
    const state = this.stateOf(name);
    if (state.manualStop || state.retryTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(state.retryCount, RECONNECT_DELAYS_MS.length - 1)];
    state.retryCount += 1;
    this.logger.info(
      t('mcp.serverReconnectScheduled', {
        name,
        delay,
        attempt: state.retryCount,
      }),
    );
    const timer = setTimeout(() => {
      state.retryTimer = undefined;
      if (this.shuttingDown || state.manualStop) return;
      if (this.serverDefs.get(name)?.enabled === false) return;
      void this.connect(name).catch(() => {});
    }, delay);
    // 重连定时器不应阻止进程退出
    (timer as { unref?: () => void }).unref?.();
    state.retryTimer = timer;
  }

  /** 已连接客户端意外关闭（子进程退出/远端断连）：更新状态并重连 */
  private handleUnexpectedClose(name: string, client: McpClient): void {
    if (this.deleting.has(name)) return;
    const entry = this.entries.get(name);
    // 仅处理当前登记在册的连接；连接失败阶段/已被替换的 client 不重复触发
    if (!entry || entry.client !== client) return;
    this.entries.delete(name);
    const state = this.stateOf(name);
    const message = t('mcp.serverUnexpectedClose', { name });
    state.status = 'error';
    state.lastError = message;
    this.logger.warn(message);
    void this.eventBus
      .broadcast('mcp:server:disconnected', { server: name, error: message })
      .catch(() => {});
    this.scheduleReconnect(name);
  }

  /**
   * 加载并合并所有服务器定义。
   * 优先级：用户目录 mcps/*.json > 包内模板 mcps/*.json > config.json.mcpServers（deprecated）
   */
  private async loadServerDefs(): Promise<Map<string, ServerConfig>> {
    const defs = new Map<string, ServerConfig>();

    // 1. 包内模板 mcps/*.json
    const builtinDir = join(this.env.packageRoot, 'mcps');
    await this.loadFromDir(defs, builtinDir).catch(() => {});

    // 2. 用户目录 ~/.moss/mcps/*.json（首次运行从包内复制）
    const userDir = join(this.env.dataDir, 'mcps');
    await this.ensureUserMcpsDir(userDir, builtinDir);
    await this.loadFromDir(defs, userDir).catch(() => {});

    // 3. config.json.mcpServers（deprecated，向后兼容）
    const cfg = this.config.getAppConfig();
    const legacyServers = cfg.mcpServers as Record<string, ServerConfig> | undefined;
    if (legacyServers && typeof legacyServers === 'object') {
      const legacyNames = Object.keys(legacyServers);
      if (legacyNames.length > 0) {
        this.logger.warn(
          t('mcp.mcpServersDeprecated'),
          { legacyNames },
        );
        for (const name of legacyNames) {
          if (!defs.has(name)) {
            defs.set(name, legacyServers[name]);
          }
        }
      }
    }

    return defs;
  }

  /** 从目录加载 *.json 服务器定义文件 */
  private async loadFromDir(defs: Map<string, ServerConfig>, dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const full = join(dir, file);
      const s = await stat(full).catch(() => null);
      if (!s || !s.isFile()) continue;
      try {
        const raw = await readFile(full, 'utf8');
        const parsed = JSON.parse(raw) as Partial<ServerConfig> & { name?: string };
        // 文件名作为默认 name，但优先使用文件内 name 字段
        const name = parsed.name ?? file.replace(/\.json$/, '');
        if (!parsed.transport) {
          this.logger.warn(t('mcp.missingTransport', { file: full }));
          continue;
        }
        defs.set(name, parsed as ServerConfig);
      } catch (err) {
        this.logger.warn(t('mcp.parseFileFailed', { file: full }), {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** 确保用户 mcps 目录存在；首次运行时从包内模板复制默认 server 文件 */
  private async ensureUserMcpsDir(userDir: string, builtinDir: string): Promise<void> {
    try {
      await stat(userDir);
      return; // 已存在
    } catch {
      // 不存在，创建
    }
    await mkdir(userDir, { recursive: true }).catch(() => {});
    // 尝试从包内模板复制所有 .json 文件
    let entries: string[] = [];
    try {
      entries = await readdir(builtinDir);
    } catch {
      return;
    }
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const src = join(builtinDir, file);
      const dst = join(userDir, file);
      await copyFile(src, dst).catch(err => {
        this.logger.debug(t('mcp.copyDefaultFailed', { file }), {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  async connect(serverName: string, opts?: { timeoutMs?: number }): Promise<void> {
    const serverCfg = this.serverDefs.get(serverName);
    if (!serverCfg) {
      throw new Error(
        `MCP server "${serverName}" not found. Check ~/.moss/mcps/${serverName}.json or config.json.mcpServers.`,
      );
    }
    if (serverCfg.enabled === false) {
      throw new Error(t('mcp.serverDisabled', { name: serverName }));
    }
    // 正在删除的服务器：拒绝任何连接请求（reload/watch 竞态兜底）
    if (this.deleting.has(serverName)) {
      throw new Error(t('mcp.serverNotFound', { name: serverName }));
    }

    const state = this.stateOf(serverName);
    // 并发合并：同一服务器同时只跑一条连接链路（启动/安装/手动点击可能重叠）
    if (state.inFlight) return state.inFlight;

    this.clearRetryTimer(state);
    state.manualStop = false;
    state.status = 'connecting';
    state.lastError = undefined;
    this.logger.info(t('mcp.serverConnecting', { name: serverName }));
    void this.eventBus
      .broadcast('mcp:server:connecting', { server: serverName })
      .catch(() => {});

    const task = this.doConnect(serverName, opts).finally(() => {
      state.inFlight = undefined;
    });
    state.inFlight = task;
    return task;
  }

  /** connect 的实际执行体：失败时记录错误、广播并安排自动重连 */
  private async doConnect(serverName: string, opts?: { timeoutMs?: number }): Promise<void> {
    const serverCfg = this.serverDefs.get(serverName);
    if (!serverCfg) {
      throw new Error(`MCP server "${serverName}" definition is no longer available`);
    }
    const state = this.stateOf(serverName);

    // 若已存在，先断开
    const existing = this.entries.get(serverName);
    if (existing) {
      await existing.client.disconnect().catch(() => {});
      this.entries.delete(serverName);
    }

    // sampling 钩子按配置注入（allowSampling=false 时不声明能力）
    const samplingEnabled = this.config.getAppConfig().mcp?.allowSampling !== false;
    const epoch = this.epoch;
    let client: McpClient | null = null;
    const hooks: McpClientHooks = samplingEnabled ? this.buildSamplingHook() : {};
    hooks.onUnexpectedClose = () => {
      if (client) this.handleUnexpectedClose(serverName, client);
    };
    client = new McpClient(serverName, serverCfg, this.logger, this.eventBus, hooks);

    // 记录连接中的 client：disconnect/delete 可立即中止，不必等待初始化超时
    state.connectingClient = client;
    try {
      try {
        await client.connect(opts?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (state.manualStop || this.deleting.has(serverName)) {
          // 用户中途断开/删除：不广播错误、不安排重连
          state.status = 'disconnected';
          state.lastError = undefined;
          throw err;
        }
        state.status = 'error';
        state.lastError = message;
        this.logger.error(t('mcp.connectFailed', { name: serverName }), { error: message });
        void this.eventBus
          .broadcast('mcp:server:error', { server: serverName, error: message })
          .catch(() => {});
        this.scheduleReconnect(serverName);
        throw err;
      }

      // 连接期间已发生重载/关闭/删除/手动断开：本次连接结果作废
      if (epoch !== this.epoch || state.manualStop || this.deleting.has(serverName)) {
        await client.disconnect().catch(() => {});
        if (epoch !== this.epoch) {
          throw new Error(`connect aborted by reload: ${serverName}`);
        }
        return;
      }

      this.entries.set(serverName, {
        client,
        config: serverCfg,
        status: 'connected',
      });
      state.status = 'connected';
      state.retryCount = 0;
      state.lastError = undefined;

      this.logger.info(t('mcp.serverConnected', { name: serverName }), {
        effectiveTransport: client.getEffectiveTransport(),
      });
      await this.eventBus.broadcast('mcp:server:connected', { server: serverName });
    } finally {
      if (state.connectingClient === client) state.connectingClient = undefined;
    }
  }

  async disconnect(serverName: string): Promise<void> {
    const state = this.stateOf(serverName);
    // 主动断开：停止重试，并阻止连接完成后的“复活”
    state.manualStop = true;
    this.clearRetryTimer(state);
    state.status = 'disconnected';
    state.lastError = undefined;

    // 连接进行中：立即取消（关闭子进程/transport），不再等待初始化超时
    const connecting = state.connectingClient;
    if (connecting) {
      state.connectingClient = undefined;
      await connecting.abortConnect().catch(() => {});
    }

    const entry = this.entries.get(serverName);
    if (!entry) {
      this.logger.warn(t('mcp.notConnected', { name: serverName }));
      return;
    }
    await entry.client.disconnect();
    this.entries.delete(serverName);
    this.logger.info(t('mcp.serverDisconnected', { name: serverName }));
    await this.eventBus.broadcast('mcp:server:disconnected', { server: serverName });
  }

  /** reloadAll 进行中标志（串行化：并发调用合并，避免全量重连风暴） */
  private reloadInFlight = false;
  /** 进行中收到新请求时置位，当前轮完成后追加执行一轮 */
  private reloadQueued = false;

  async reloadAll(): Promise<void> {
    // 串行化 + 合并：上一轮未完成时只记录"需要再跑一轮"，
    // 避免 config:changed 双路径通知导致 stdio 子进程反复断开重连。
    if (this.reloadInFlight) {
      this.reloadQueued = true;
      return;
    }
    this.reloadInFlight = true;
    try {
      this.epoch += 1;
      this.logger.info(t('mcp.reloadingAll'));
      // 断开所有
      const names = Array.from(this.entries.keys());
      await Promise.allSettled(names.map(n => this.disconnect(n).catch(() => {})));
      // 取消仍在进行中的连接 + 清理旧周期的重试定时器，避免重载后旧连接“复活”
      const aborts: Array<Promise<void>> = [];
      for (const state of this.states.values()) {
        this.clearRetryTimer(state);
        const connecting = state.connectingClient;
        if (connecting) {
          state.connectingClient = undefined;
          aborts.push(connecting.abortConnect().catch(() => {}));
        }
      }
      await Promise.allSettled(aborts);
      this.states.clear();
      // 重新加载定义并连接
      await this.initialize();
    } finally {
      this.reloadInFlight = false;
      if (this.reloadQueued) {
        this.reloadQueued = false;
        void this.reloadAll().catch(err => {
          this.logger.error(t('mcp.reloadFailed'), {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }

  /**
   * 监听用户 mcps 目录（~/.moss/mcps/）的 *.json 变更，防抖后自动重连。
   * 仅首次调用生效（reloadAll 内部会再次 initialize，需避免重复起 watch）。
   */
  private startWatch(): void {
    if (this.watchStarted) return;
    this.watchStarted = true;
    const userDir = join(this.env.dataDir, 'mcps');
    let debounce: ReturnType<typeof setTimeout> | null = null;
    try {
      this.mcpsWatcher = watch(userDir, { recursive: true }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          (async () => {
            // 内容对比守卫：磁盘定义与内存一致（外部程序写相同内容 / 本进程 CRUD 已同步）时
            // 跳过全量重连，防止同步盘/杀毒等反复写盘演变为断开-重连循环
            const diskDefs = await this.loadServerDefs();
            if (this.defsEqual(diskDefs, this.serverDefs)) {
              this.logger.debug(t('mcp.defsUnchangedSkipReload'));
              return;
            }
            await this.reloadAll();
          })().catch(err => {
            this.logger.error(t('mcp.reloadFailed'), {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, 300);
      });
      this.logger.debug('mcp mcps dir watcher started', { dir: userDir });
    } catch (err) {
      this.logger.warn('mcp mcps dir watcher start failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 比较两份服务器定义是否完全一致（key 集合 + 每项 JSON 序列化对比） */
  private defsEqual(a: Map<string, ServerConfig>, b: Map<string, ServerConfig>): boolean {
    if (a.size !== b.size) return false;
    for (const [name, def] of a) {
      const other = b.get(name);
      if (!other) return false;
      if (JSON.stringify(def) !== JSON.stringify(other)) return false;
    }
    return true;
  }

  listServers(): Array<{
    name: string;
    status: ServerStatus;
    toolCount: number;
    enabled: boolean;
    transport?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    lastError?: string;
    market?: ServerConfig['market'];
  }> {
    const result: Array<{
      name: string;
      status: ServerStatus;
      toolCount: number;
      enabled: boolean;
      transport?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
      lastError?: string;
      market?: ServerConfig['market'];
    }> = [];
    // 统一按定义顺序输出；连接状态/错误取自运行时状态表
    for (const [name, def] of this.serverDefs.entries()) {
      const entry = this.entries.get(name);
      const state = this.states.get(name);
      result.push({
        name,
        status: entry ? 'connected' : state?.status ?? 'disconnected',
        toolCount: entry?.client.getToolCount() ?? 0,
        enabled: def.enabled !== false,
        ...(def.transport ? { transport: def.transport } : {}),
        ...(def.command ? { command: def.command } : {}),
        ...(def.args && def.args.length > 0 ? { args: def.args } : {}),
        ...(def.env && Object.keys(def.env).length > 0 ? { env: def.env } : {}),
        ...(def.url ? { url: def.url } : {}),
        ...(def.headers && Object.keys(def.headers).length > 0 ? { headers: def.headers } : {}),
        ...(state?.lastError ? { lastError: state.lastError } : {}),
        ...(def.market ? { market: def.market } : {}),
      });
    }
    return result;
  }

  listTools(serverName?: string): Array<{
    server: string;
    name: string;
    title?: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: McpToolInfo['annotations'];
  }> {
    const result: Array<{
      server: string;
      name: string;
      title?: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: McpToolInfo['annotations'];
    }> = [];
    const entries = serverName
      ? [[serverName, this.entries.get(serverName)] as const].filter(([, e]) => e !== undefined)
      : Array.from(this.entries.entries());

    for (const [name, entry] of entries) {
      if (!entry || entry.status !== 'connected') continue;
      // 禁用的服务器不注入工具
      if (entry.config.enabled === false) continue;
      for (const tool of entry.client.getTools()) {
        result.push({
          server: name,
          name: tool.name,
          title: tool.title ?? tool.annotations?.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        });
      }
    }
    return result;
  }

  isServerEnabled(serverName: string): boolean | null {
    const def = this.serverDefs.get(serverName);
    if (!def) return null;
    return def.enabled !== false;
  }

  getToolAnnotations(serverName: string, toolName: string): McpToolAnnotations | null {
    const entry = this.entries.get(serverName);
    if (!entry || entry.status !== 'connected') return null;
    const annotations = entry.client.getTool(toolName)?.annotations;
    return annotations ?? null;
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: unknown,
    opts?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      /** elicitation 桥：MCP 服务器向用户请求输入（agent 通道注入；缺省时 decline） */
      elicit?: (req: McpElicitRequest) => Promise<McpElicitOutcome>;
    },
  ): Promise<McpToolResult> {
    const entry = this.entries.get(serverName);
    if (!entry || entry.status !== 'connected') {
      throw new Error(t('mcp.serverNotConnected', { name: serverName }));
    }
    if (opts?.elicit) {
      entry.client.setElicitationBridge(opts.elicit);
    }
    try {
      return await entry.client.callTool(toolName, args, {
        timeoutMs: opts?.timeoutMs,
        signal: opts?.signal,
      });
    } finally {
      if (opts?.elicit) {
        entry.client.setElicitationBridge(null);
      }
    }
  }

  // ========================================================================
  // 服务器定义 CRUD（写 ~/.moss/mcps/<name>.json；目录 watch 自动热重载）
  // ========================================================================

  /** 校验服务器定义（transport 必填；stdio 需 command；http/sse 需 url） */
  private validateServerDef(def: unknown): def is ServerConfig {
    if (!def || typeof def !== 'object') return false;
    const d = def as Partial<ServerConfig>;
    if (d.transport !== 'stdio' && d.transport !== 'http' && d.transport !== 'sse') {
      return false;
    }
    if (d.transport === 'stdio' && !d.command) return false;
    if (d.transport !== 'stdio' && !d.url) return false;
    return true;
  }

  /** 服务器定义文件路径（~/.moss/mcps/<name>.json） */
  private serverDefPath(serverName: string): string {
    return join(this.env.dataDir, 'mcps', `${serverName}.json`);
  }

  async createServer(name: string, def: unknown, opts?: { connect?: boolean }): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(t('mcp.invalidServerName', { name }));
    }
    if (!this.validateServerDef(def)) {
      throw new Error(t('mcp.invalidServerDef'));
    }
    if (this.serverDefs.has(name) || this.defFileExists(this.serverDefPath(name))) {
      throw new Error(t('mcp.serverAlreadyExists', { name }));
    }
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(this.env.dataDir, 'mcps'), { recursive: true });
    const payload = { ...(def as ServerConfig), name };
    await writeFile(this.serverDefPath(name), JSON.stringify(payload, null, 2), 'utf8');
    // watch 会自动 reload；此处同步本地定义并即时连接（disabled 的跳过）
    this.serverDefs.set(name, payload);
    if (opts?.connect !== false && payload.enabled !== false) {
      await this.connect(name);
    }
  }

  async updateServer(name: string, def: unknown, opts?: { connect?: boolean }): Promise<void> {
    const filePath = this.serverDefPath(name);
    if (!this.defFileExists(filePath)) {
      throw new Error(t('mcp.serverNotFound', { name }));
    }
    // 支持部分更新（如仅切换 enabled）：与现有定义合并后再校验，避免抹掉 command/url/env
    const base = this.serverDefs.get(name) ?? ({} as ServerConfig);
    const payload = { ...base, ...(def as ServerConfig), name };
    if (!this.validateServerDef(payload)) {
      throw new Error(t('mcp.invalidServerDef'));
    }
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    // 写盘后立即同步内存定义（真相源）：修正已连接服务器 connect 用旧定义的 bug；
    // 且 watcher 触发时内容对比将发现与内存一致 → 跳过 reloadAll（消除 CRUD 双重重载）
    this.serverDefs.set(name, payload);
    const state = this.stateOf(name);
    state.manualStop = false;
    if (payload.enabled === false) {
      // 禁用：断开并停止重试
      await this.disconnect(name);
    } else if (opts?.connect !== false) {
      // 启用/配置变更：重连（connect 内部处理超时与失败重试）
      await this.connect(name);
    }
  }

  async deleteServer(name: string): Promise<void> {
    const filePath = this.serverDefPath(name);
    const def = this.serverDefs.get(name);
    if (!def && !this.defFileExists(filePath)) {
      throw new Error(t('mcp.serverNotFound', { name }));
    }
    // 标记删除中：阻止重连调度、连接完成后的“复活”，以及 watch/reload 期间的重新连接
    this.deleting.add(name);
    try {
      // 先从内存定义移除：即使文件删除有延迟，reload 的 defsEqual 也会认为已删除
      this.serverDefs.delete(name);
      // 断开并立即取消进行中的连接
      await this.disconnect(name).catch(() => {});
      // 清理重试定时器与运行状态
      const state = this.states.get(name);
      if (state) this.clearRetryTimer(state);
      this.states.delete(name);
      const { rm } = await import('node:fs/promises');
      if (this.defFileExists(filePath)) {
        await rm(filePath, { force: true });
      }
      await this.eventBus.broadcast('mcp:server:deleted', { server: name });
    } catch (err) {
      // 删除失败（如 Windows 文件占用）：恢复定义，避免文件仍在但内存丢失
      if (def) this.serverDefs.set(name, def);
      throw err;
    } finally {
      this.deleting.delete(name);
    }
  }

  private defFileExists(path: string): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('node:fs');
      return fs.existsSync(path);
    } catch {
      return false;
    }
  }

  /** 关闭所有连接（模块销毁时调用） */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.epoch += 1;
    this.mcpsWatcher?.close();
    this.mcpsWatcher = undefined;
    const aborts: Array<Promise<void>> = [];
    for (const state of this.states.values()) {
      this.clearRetryTimer(state);
      const connecting = state.connectingClient;
      if (connecting) {
        state.connectingClient = undefined;
        aborts.push(connecting.abortConnect().catch(() => {}));
      }
    }
    this.states.clear();
    const names = Array.from(this.entries.keys());
    await Promise.allSettled([
      ...aborts,
      ...names.map(n => this.disconnect(n).catch(() => {})),
    ]);
  }
}
