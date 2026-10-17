// src/modules/context/api/service.ts
// ContextEngine 服务实现：整合 governor 流水线、healer 自愈、遥测环形缓冲、
// busy 管理、session store 桥接。注册为 ServiceNames.CONTEXT_ENGINE。
// agent 模块通过 bindSessionStore 注入会话存取回调（依赖方向 agent → context）。

import type {
  ConfigService,
  Environment,
  Logger,
  ServiceRegistry,
} from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import { flattenModels } from '../../../core/provider-utils';
import type { LLMRouter, ToolRegistry, MCPManager } from '../../contracts';
import type {
  CompactPreview,
  CompactionRecord,
  ContextBreakdown,
  ContextEngineConfig,
  ContextMessage,
  ContextSessionLike,
  ContextStats,
  HealResult,
  ManualCompactResult,
  PreparedRequest,
  SessionStoreBridge,
  SystemSection,
} from '../types';
// 注：ContextStatsEventPayload 已删除——部分形状类型合法化了不完整 payload（白屏缺陷共犯）
import { DEFAULT_CONTEXT_CONFIG, TELEMETRY_BUFFER_SIZE as BUFFER_SIZE } from '../types';
import { TokenCalibrator } from '../budgeter/calibration';
import { estimateTextTokens, messagesChars, parseContextWindow } from '../budgeter/estimator';
import { buildStaticSystemPrompt, buildRequestView, getSystemSections } from '../compiler';
import type { RulesSectionInput } from '../compiler/system-prompt';
import { ensureEnvProbed } from '../compiler/env-probe';
import { buildRulesSection } from '../../rules/inject';
import type { RulesEngineServiceImpl } from '../../rules/service';
import { ENV_CONTEXT_MSG_NAME } from '../compiler/env-context';
import { healToolCall, type HealRegistryLike } from '../healer';
import {
  prepareRequest as governorPrepare,
  manualCompact as governorManualCompact,
  previewCompact as governorPreview,
  type GovernorDeps,
} from '../governor';
import { resolveSummaryModel } from '../compressor';
import { ensureContextPrompts } from '../prompt-loader';
import { FileIndexService } from '../file-index';

/** ToolRegistry 鸭子类型（get/listSchemas） */
interface ToolRegistryLike {
  get(name: string): { name: string; description?: string; inputSchema?: unknown } | null;
  listSchemas(): Array<{ name: string; description: string; inputSchema?: unknown }>;
}

/** MCPManager 鸭子类型（listTools） */
interface McpManagerLike {
  listTools(): Array<{ server: string; name: string; description?: string; inputSchema?: unknown }>;
}

/** 会话级遥测状态（发送视图内存缓存；真实 usage/命中样本的单一真源在
 *  session.contextTelemetry——持久化，重启恢复） */
interface SessionTelemetry {
  lastBreakdown: ContextBreakdown | null;
  lastWindowTokens: number;
  lastSystemSections: SystemSection[];
  lastSentChars: number;
}

export interface ContextEngineServiceDeps {
  env: Environment;
  config: ConfigService;
  services: ServiceRegistry;
  logger: Logger;
}

export interface PrepareRequestOptions {
  cwd: string;
  model: string;
  modelDisplayName: string;
  /** 上下文窗口 token；缺省从模型配置 contextWindow 解析 */
  windowTokens?: number;
}

export class ContextEngineServiceImpl {
  private readonly env: Environment;
  private readonly config: ConfigService;
  private readonly services: ServiceRegistry;
  private readonly logger: Logger;
  private readonly calibrator = new TokenCalibrator();
  private readonly telemetry = new Map<string, SessionTelemetry>();
  private readonly busySessions = new Set<string>();
  /**
   * 待确认的「图片已发送」标记（sessionId → 本轮内联发送过图片的原始消息引用）。
   * prepareRequest 写入；调用方在请求成功送达后 confirm、失败/中断时 discard。
   */
  private readonly pendingImageMarks = new Map<string, ContextMessage[]>();
  private sessionStore: SessionStoreBridge | null = null;
  /** 文件索引模块（三引擎；默认关闭，配置打开后激活） */
  private readonly fileIndex: FileIndexService;

  constructor(deps: ContextEngineServiceDeps) {
    this.env = deps.env;
    this.config = deps.config;
    this.services = deps.services;
    this.logger = deps.logger;
    this.fileIndex = new FileIndexService({
      env: deps.env,
      config: deps.config,
      services: deps.services,
      logger: deps.logger,
    });
  }

  /** 模块初始化：补充播种 compact/heal 提示词目录 */
  onInitialize(): void {
    ensureContextPrompts(this.env);
    this.logger.info('context: engine initialized', {
      compaction: this.getConfig().compaction.enabled ? 'enabled' : 'disabled',
      fileIndex: this.getConfig().fileIndex.indexing.enabled ? 'enabled' : 'disabled',
    });
  }

  /** 模块销毁：停用文件索引（保数据） */
  async onDestroy(): Promise<void> {
    await this.fileIndex.stopAll();
  }

  /** 文件索引服务访问器（glob/grep 工具 / governor 注入 / API 路由使用） */
  getFileIndex(): FileIndexService {
    return this.fileIndex;
  }

  /** 配置热重载：文件索引引擎启停（config:changed 时由 server 路由调用） */
  async onFileIndexConfigChanged(): Promise<void> {
    await this.fileIndex.applyConfigChange();
    // 开关刚打开时通常无既有运行时 → 为最近工作目录主动建索引并扫描
    if (this.getConfig().fileIndex.indexing.enabled && this.lastCwd) {
      void this.fileIndex.ensureProject(this.lastCwd).catch(() => {
        // 失败静默（后续任务请求会重试）
      });
    }
  }

  /** agent 模块注入会话存取桥（依赖方向 agent → context） */
  bindSessionStore(bridge: SessionStoreBridge): void {
    this.sessionStore = bridge;
  }

  /** 实时读取引擎配置（config:changed 自动生效） */
  getConfig(): ContextEngineConfig {
    const app = this.config.getAppConfig();
    const ctx = (app as { context?: Partial<ContextEngineConfig> }).context;
    if (!ctx) return DEFAULT_CONTEXT_CONFIG;
    return {
      compaction: { ...DEFAULT_CONTEXT_CONFIG.compaction, ...ctx.compaction },
      toolPruning: { ...DEFAULT_CONTEXT_CONFIG.toolPruning, ...ctx.toolPruning },
      healer: { ...DEFAULT_CONTEXT_CONFIG.healer, ...ctx.healer },
      telemetry: { ...DEFAULT_CONTEXT_CONFIG.telemetry, ...ctx.telemetry },
      fileIndex: ctx.fileIndex ?? DEFAULT_CONTEXT_CONFIG.fileIndex,
      rules: { ...DEFAULT_CONTEXT_CONFIG.rules, ...ctx.rules },
      hooks: { ...DEFAULT_CONTEXT_CONFIG.hooks, ...ctx.hooks },
      memory: { ...DEFAULT_CONTEXT_CONFIG.memory, ...ctx.memory },
      maxRequestBytes:
        typeof ctx.maxRequestBytes === 'number' && Number.isFinite(ctx.maxRequestBytes)
          ? ctx.maxRequestBytes
          : DEFAULT_CONTEXT_CONFIG.maxRequestBytes,
    };
  }

  // ========================================================================
  // 请求准备（governor 流水线）
  // ========================================================================

  /**
   * 每轮 LLM 请求前的统一流水线（engine 调用点）。
   * 同时记录遥测（breakdown/systemSections）供 stats API 与 WS 推送。
   */
  async prepareRequest(
    session: ContextSessionLike,
    opts: PrepareRequestOptions,
  ): Promise<PreparedRequest> {
    // 环境探测预热（首次 ~1s 并行探测解释器/工具链/编码，之后进程级缓存 0ms）；
    // 确保 system prompt 中的环境信息自第一帧起完整且字节级稳定（缓存周期不中途切换）
    await ensureEnvProbed(this.env);
    const windowTokens = opts.windowTokens ?? this.resolveWindowTokens(opts.model);
    this.noteCwd(opts.cwd);
    const deps = this.buildGovernorDeps();
    const prepared = await governorPrepare(deps, {
      session,
      cwd: opts.cwd,
      model: opts.model,
      modelDisplayName: opts.modelDisplayName,
      windowTokens,
    });

    // 图片「只发一次」：缓存本轮内联发送的图片消息引用（等待调用方确认/丢弃）
    if (prepared.imageMessagesToMark && prepared.imageMessagesToMark.length > 0) {
      this.pendingImageMarks.set(session.id, prepared.imageMessagesToMark);
    } else {
      this.pendingImageMarks.delete(session.id);
    }

    // 遥测：breakdown + systemSections + 发送字符数（校准口径）
    const skillName = session.activeSkill?.mode === 'system' ? session.activeSkill.name : undefined;
    const sections = getSystemSections(
      this.env,
      skillName,
      name => this.resolveSkillPrompt(name),
      this.buildRulesSectionForTelemetry(opts.cwd),
    );
    const sentChars = messagesChars(
      prepared.messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
        ...(m.name !== undefined ? { name: m.name } : {}),
        ...(m.toolCalls
          ? {
              toolCalls: m.toolCalls.map(tc => ({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
              })),
            }
          : {}),
      })),
    );
    const t = this.ensureTelemetry(session.id);
    t.lastBreakdown = prepared.breakdown;
    t.lastWindowTokens = windowTokens;
    t.lastSystemSections = sections;
    t.lastSentChars = sentChars;

    return prepared;
  }

  // ========================================================================
  // 自愈（healer 入口）
  // ========================================================================

  /** 工具调用自愈：参数修复 → 工具名纠正 → schema 校验修正 */
  healToolCall(toolName: string, args: string): HealResult {
    const config = this.getConfig().healer;
    const registry = this.buildHealRegistry();
    return healToolCall({
      toolName,
      arguments: args,
      registry,
      config,
      env: this.env,
    });
  }

  /** 组合 ToolRegistry + MCP 工具为 healer 可用的注册表视图 */
  private buildHealRegistry(): HealRegistryLike {
    const toolRegistry = this.services.tryResolve<ToolRegistryLike>(ServiceNames.TOOL_REGISTRY);
    const mcpManager = this.services.tryResolve<McpManagerLike>(ServiceNames.MCP_MANAGER);
    let mcpTools: Array<{ server: string; name: string; description?: string; inputSchema?: unknown }> = [];
    try {
      mcpTools = mcpManager?.listTools() ?? [];
    } catch {
      mcpTools = [];
    }

    return {
      get: (name: string) => {
        const mcpMatch = /^mcp__([^_]+)__(.+)$/.exec(name);
        if (mcpMatch) {
          const t = mcpTools.find(x => x.server === mcpMatch[1] && x.name === mcpMatch[2]);
          return t ? { name, description: t.description, inputSchema: t.inputSchema } : null;
        }
        const t = toolRegistry?.get(name);
        return t ? { name: t.name, description: t.description, inputSchema: t.inputSchema } : null;
      },
      listSchemas: () => {
        const builtin = toolRegistry
          ? toolRegistry.listSchemas().map(s => ({
              name: s.name,
              description: s.description,
              inputSchema: s.inputSchema,
            }))
          : [];
        const mcp = mcpTools.map(t => ({
          name: `mcp__${t.server}__${t.name}`,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        return [...builtin, ...mcp];
      },
    };
  }

  // ========================================================================
  // 手动压缩
  // ========================================================================

  markBusy(sessionId: string): void {
    this.busySessions.add(sessionId);
  }

  markIdle(sessionId: string): void {
    this.busySessions.delete(sessionId);
  }

  /**
   * 请求**成功送达** → 把本轮内联发送过图片的消息落 imagesSentAt 并持久化。
   * 之后这些图片在发送视图中降级为占位符（附原始路径，可 read 重看），
   * 从根上阻止历史图片 base64 每轮重发导致的请求体无界增长（HTTP 413）。
   */
  confirmImagesSent(sessionId: string): void {
    const pending = this.pendingImageMarks.get(sessionId);
    this.pendingImageMarks.delete(sessionId);
    if (!pending || pending.length === 0) return;
    const at = new Date().toISOString();
    let changed = false;
    for (const m of pending) {
      if (!m.imagesSentAt) {
        m.imagesSentAt = at;
        changed = true;
      }
    }
    if (!changed) return;
    const session = this.sessionStore?.get(sessionId);
    if (session) this.sessionStore?.persist(session);
  }

  /** 请求失败/中断 → 丢弃本轮标记：下次请求仍会重新发送该图片（模型不会"从未见过"）。 */
  discardImagesSent(sessionId: string): void {
    this.pendingImageMarks.delete(sessionId);
  }

  /** 手动压缩（空闲时可用） */
  async manualCompact(sessionId: string, focus?: string): Promise<ManualCompactResult> {
    const session = this.sessionStore?.get(sessionId);
    if (!session) return { ok: false, reason: 'session not found' };
    if (this.busySessions.has(sessionId)) {
      return { ok: false, reason: 'session is running; compaction is only available when idle' };
    }
    const model = this.resolveMainModel();
    const windowTokens = this.resolveWindowTokens(model);
    const deps = this.buildGovernorDeps();
    this.markBusy(sessionId);
    try {
      const outcome = await governorManualCompact(deps, {
        session,
        cwd: this.lastCwd ?? process.cwd(),
        model,
        modelDisplayName: model,
        windowTokens,
        ...(focus !== undefined ? { focus } : {}),
      });
      return outcome.record
        ? { ok: true, compaction: outcome.record }
        : { ok: false, reason: outcome.reason ?? 'compaction not applicable' };
    } finally {
      this.markIdle(sessionId);
    }
  }

  /** 手动压缩预览（确认对话框数据） */
  previewCompact(sessionId: string): CompactPreview | null {
    const session = this.sessionStore?.get(sessionId);
    if (!session) return null;
    const model = this.resolveMainModel();
    const windowTokens = this.resolveWindowTokens(model);
    const deps = this.buildGovernorDeps();
    const est = governorPreview(deps, session, windowTokens);
    return {
      sessionId,
      compactableCount: est.compactableCount,
      compactableTokens: est.compactableTokens,
      tailKeepCount: est.tailKeepCount,
      estimatedAfterTokens: est.estimatedAfterTokens,
    };
  }

  // ========================================================================
  // 统计与遥测
  // ========================================================================

  /** 获取会话上下文统计（token 构成/缓存命中/压缩状态/系统上下文分段） */
  getStats(sessionId: string): ContextStats | null {
    const session = this.sessionStore?.get(sessionId);
    if (!session) return null;
    const t = this.ensureTelemetry(sessionId);
    const config = this.getConfig();
    // 重启后内存缓存缺失：按当前 session 状态惰性重算发送视图（纯估算，无 LLM 调用）
    if (!t.lastBreakdown) {
      this.recomputeView(session, t);
    }
    const breakdown =
      t.lastBreakdown ??
      ({ system: 0, env: 0, summary: 0, history: 0, rules: 0, memory: 0, total: 0 } as ContextBreakdown);
    const windowTokens = t.lastWindowTokens || this.resolveWindowTokens(this.resolveMainModel());
    const compactedMessages = session.messages.filter(m => m.compacted).length;
    const activeSummary = session.messages.find(
      m => m.name === 'compaction-summary' && !m.compacted && !m.deletedAt,
    );
    const summaryTokens = activeSummary ? Math.ceil(activeSummary.content.length * 0.4) : 0;
    // 真实 usage 与命中样本：session.contextTelemetry 单一真源（持久化，重启恢复）
    const cacheHits = session.contextTelemetry?.cacheHits ?? [];
    const avgHitRate =
      cacheHits.length > 0
        ? cacheHits.reduce((s, x) => s + x.hitRate, 0) / cacheHits.length
        : null;
    // 统一口径：占用优先用真实 promptTokens（与前端 StatsBar"输入"同源同值）
    const usedTokens = session.contextTelemetry?.lastUsage?.promptTokens ?? breakdown.total;
    const modelId = this.resolveMainModel();

    return {
      sessionId,
      model: { id: modelId, name: this.lookupModelName(modelId) },
      breakdown,
      windowTokens,
      usedPercent: windowTokens > 0 ? Math.round((usedTokens / windowTokens) * 100) : 0,
      lastUsage: session.contextTelemetry?.lastUsage ?? null,
      compaction: {
        enabled: config.compaction.enabled,
        compactRatio: config.compaction.compactRatio,
        compactedMessages,
        activeSummaryTokens: summaryTokens,
        ...(session.compactions && session.compactions.length > 0
          ? { lastCompaction: session.compactions[session.compactions.length - 1] }
          : {}),
      },
      cacheHits: [...cacheHits],
      avgHitRate,
      systemSections: this.appendDynamicSections(t.lastSystemSections, session),
    };
  }

  /** 压缩历史 */
  getCompactions(sessionId: string): CompactionRecord[] {
    const session = this.sessionStore?.get(sessionId);
    return session?.compactions ? [...session.compactions] : [];
  }

  /** engine 每轮流结束后上报 usage（持久化遥测 + tokPerChar 校准 + WS 推送） */
  onTurnUsage(
    sessionId: string,
    usage: { promptTokens: number; cachedTokens: number; completionTokens?: number },
  ): void {
    const t = this.ensureTelemetry(sessionId);
    const promptTokens = Math.max(0, usage.promptTokens);
    const cachedTokens = Math.max(0, Math.min(usage.cachedTokens, promptTokens));
    const completionTokens = Math.max(0, usage.completionTokens ?? 0);
    const hitRate = promptTokens > 0 ? cachedTokens / promptTokens : 0;
    const lastUsage = { promptTokens, completionTokens, cachedTokens };
    // 持久化遥测：真实 usage + 命中样本写入 session.contextTelemetry（单一真源）
    // 并随 session 落盘——后端重启后侧边栏进度条与指标栏数据恢复
    const session = this.sessionStore?.get(sessionId);
    if (session) {
      const cacheHits = [
        ...(session.contextTelemetry?.cacheHits ?? []),
        { at: new Date().toISOString(), promptTokens, cachedTokens, hitRate },
      ];
      if (cacheHits.length > BUFFER_SIZE) {
        cacheHits.splice(0, cacheHits.length - BUFFER_SIZE);
      }
      session.contextTelemetry = { lastUsage, cacheHits };
      try {
        this.sessionStore?.persist(session);
      } catch (err) {
        this.logger.warn('context: persist telemetry failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // tokPerChar 校准（chars 口径：最近一次发送内容）
    this.calibrator.calibrate(promptTokens, t.lastSentChars);

    // WS 推送实时命中（完整统计：与 onCompaction / stats API 同一数据源 getStats，
    // 避免部分形状 payload 覆盖前端 store 导致渲染崩溃——白屏缺陷根治点）
    const stats = this.getStats(sessionId);
    if (stats) {
      this.emitWs(sessionId, { type: 'context-stats-updated', sessionId, payload: stats });
    }
  }

  /** 校准器（遥测/调试用） */
  getCalibrator(): TokenCalibrator {
    return this.calibrator;
  }

  /** 摘要模型可选列表（设置页数据源） */
  getSummaryModels(): Array<{ id: string; name: string; model: string }> {
    return flattenModels(this.config.getApiConfig()).map(m => ({ id: m.id, name: m.name, model: m.model }));
  }

  // ========================================================================
  // 内部辅助
  // ========================================================================

  /** 最近一次 prepareRequest 的 cwd（手动压缩摘要前缀复用） */
  private lastCwd: string | null = null;

  private buildGovernorDeps(): GovernorDeps {
    return {
      env: this.env,
      logger: this.logger,
      services: this.services,
      getConfig: () => this.getConfig(),
      getLlm: () => this.services.tryResolve<LLMRouter>(ServiceNames.LLM_ROUTER),
      getApiModels: () =>
        flattenModels(this.config.getApiConfig()).map(m => ({ id: m.id, model: m.model })),
      getProjectOverview: (cwd: string) => this.fileIndex.projectOverview(cwd),
      ensureFileIndex: (cwd: string) => {
        void this.fileIndex.ensureProject(cwd).catch(() => {
          // 单次失败静默（下次请求会重试）
        });
      },
      persistSession: session => this.sessionStore?.persist(session),
      emitWs: (sessionId, message) => this.emitWs(sessionId, message),
      onCompaction: sessionId => {
        // 压缩后立即刷新 stats 推送（全量：与 onTurnUsage / stats API 同一数据源 getStats，
        // 避免部分形状 payload 覆盖前端 store 导致渲染崩溃——白屏缺陷根治点）
        const stats = this.getStats(sessionId);
        if (stats) {
          this.emitWs(sessionId, { type: 'context-stats-updated', sessionId, payload: stats });
        }
      },
      onDegraded: (sessionId, reason) => {
        this.logger.warn('context: degraded', { sessionId, reason });
        this.emitWs(sessionId, {
          type: 'context-degraded',
          sessionId,
          payload: { sessionId, reason },
        });
      },
    };
  }

  /** prepareRequest 时同步 lastCwd */
  noteCwd(cwd: string): void {
    this.lastCwd = cwd;
  }

  private emitWs(sessionId: string, message: unknown): void {
    const server = this.services.tryResolve<{
      sendToSession: (sid: string, msg: unknown) => void;
    }>(ServiceNames.SERVER_INSTANCE);
    try {
      server?.sendToSession(sessionId, message);
    } catch {
      // server 未就绪/连接已关：静默
    }
  }

  private ensureTelemetry(sessionId: string): SessionTelemetry {
    let t = this.telemetry.get(sessionId);
    if (!t) {
      t = {
        lastBreakdown: null,
        lastWindowTokens: 0,
        lastSystemSections: [],
        lastSentChars: 0,
      };
      this.telemetry.set(sessionId, t);
    }
    return t;
  }

  /** 重算发送视图（重启后内存遥测缺失时惰性重建；纯估算，无 LLM 调用）。
   *  breakdown 为"下一次发送的预估占用"——与 prepareRequest 同一确定性函数 */
  private recomputeView(session: ContextSessionLike, t: SessionTelemetry): void {
    try {
      const model = this.resolveMainModel();
      const cwd = this.lastCwd ?? process.cwd();
      const skillName =
        session.activeSkill?.mode === 'system' ? session.activeSkill.name : undefined;
      const rulesSection = this.buildRulesSectionForTelemetry(cwd);
      const staticSystemPrompt = buildStaticSystemPrompt(
        this.env,
        this.resolveSkillPrompt(skillName),
        rulesSection,
      );
      const view = buildRequestView(session, staticSystemPrompt, {
        toolPruning: this.getConfig().toolPruning,
        resolveSkillPrompt: name => this.resolveSkillPrompt(name),
      });
      t.lastBreakdown = view.breakdown;
      t.lastWindowTokens = this.resolveWindowTokens(model);
      t.lastSystemSections = getSystemSections(
        this.env,
        skillName,
        name => this.resolveSkillPrompt(name),
        rulesSection,
      );
    } catch (err) {
      this.logger.warn('context: recompute view failed', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 构建 always 用户规则段（遥测/系统标签页展示用；rules 引擎不可用返回 null） */
  private buildRulesSectionForTelemetry(cwd: string): RulesSectionInput | null {
    try {
      const rulesEngine = this.services.tryResolve<RulesEngineServiceImpl>(ServiceNames.RULES_ENGINE);
      if (!rulesEngine) return null;
      const compiled = rulesEngine.getCompiledSet(cwd);
      const text = buildRulesSection(compiled.alwaysRules);
      if (!text) return null;
      return { fingerprint: compiled.fingerprint, text };
    } catch {
      return null;
    }
  }

  /** 解析主模型请求名（agent.defaultModel） */
  private resolveMainModel(): string {
    try {
      return this.config.getAppConfig().agent.defaultModel || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** 模型显示名（providers 扁平视图按 id 查找；缺失回退 id） */
  private lookupModelName(id: string): string {
    try {
      return flattenModels(this.config.getApiConfig()).find(m => m.id === id)?.name ?? id;
    } catch {
      return id;
    }
  }

  /** 在系统提示词分段之后追加动态段（工具清单 / 环境上下文），供「系统」标签页展示 */
  private appendDynamicSections(
    sections: SystemSection[],
    session: ContextSessionLike,
  ): SystemSection[] {
    const out = [...sections];
    // 工具清单：实际注入 LLM tools 参数的定义（系统提示词中已移除硬编码工具列表的可视化替代）
    try {
      const schemas = this.buildHealRegistry().listSchemas();
      if (schemas.length > 0) {
        const mcpCount = schemas.filter(s => s.name.startsWith('mcp__')).length;
        const lines = schemas.map(
          s => `- ${s.name}：${(s.description ?? '').replace(/\s+/g, ' ').trim()}`,
        );
        const content = `共 ${schemas.length} 个（内置 ${schemas.length - mcpCount} · MCP ${mcpCount}），经请求 tools 参数动态注入，不在系统提示词中。\n\n${lines.join('\n')}`;
        out.push({
          id: 'tools',
          title: '工具定义',
          tokens: estimateTextTokens(content),
          content,
          defaultOpen: false,
        });
      }
    } catch {
      // registry 不可用：跳过该段
    }
    // 环境上下文消息（会话首条锚定消息的实际内容）
    const envMsg = session.messages.find(m => m.name === ENV_CONTEXT_MSG_NAME);
    if (envMsg) {
      out.push({
        id: 'env',
        title: '环境信息',
        tokens: estimateTextTokens(envMsg.content),
        content: envMsg.content,
        defaultOpen: false,
      });
    }
    return out;
  }

  /** 从模型配置解析上下文窗口（inputTokens 优先，回退旧 contextWindow 档位） */
  private resolveWindowTokens(model: string): number {
    try {
      const models = flattenModels(this.config.getApiConfig());
      const found = models.find(m => m.id === model || m.model === model);
      return found?.inputTokens ?? parseContextWindow(found?.contextWindow);
    } catch {
      return parseContextWindow(undefined);
    }
  }

  private resolveSkillPrompt(name: string | undefined): string | null {
    if (!name) return null;
    const registry = this.services.tryResolve<{
      get(n: string): { prompt: string } | null;
      isEnabled(n: string): boolean;
    }>(ServiceNames.SKILL_REGISTRY);
    if (!registry) return null;
    const skill = registry.get(name);
    if (!skill || !registry.isEnabled(name)) return null;
    return skill.prompt;
  }

  /** 摘要模型解析（设置页/调试） */
  resolveSummaryModelId(): string {
    const config = this.getConfig();
    const main = this.resolveMainModel();
    return resolveSummaryModel(config.compaction.summaryModel, main, []).requestModel;
  }
}
