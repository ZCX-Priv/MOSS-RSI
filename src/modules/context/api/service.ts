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
  ArchiveSearchResult,
  CompactPreview,
  CompactionRecord,
  ContextBreakdown,
  ContextEngineConfig,
  ContextMessage,
  ContextSessionLike,
  ContextStatusBlock,
  ContextStatusRange,
  ContextStatusReport,
  ContextStats,
  DecompressResult,
  HealResult,
  ManualCompactResult,
  ModelCompressRange,
  ModelCompressResult,
  PreparedRequest,
  RetrieveResult,
  SessionStoreBridge,
  SystemSection,
} from '../types';
// 注：ContextStatsEventPayload 已删除——部分形状类型合法化了不完整 payload（白屏缺陷共犯）
import {
  CACHE_LEDGER_BUFFER_SIZE,
  DEFAULT_CONTEXT_CONFIG,
  TELEMETRY_BUFFER_SIZE as BUFFER_SIZE,
} from '../types';
import { TokenCalibrator } from '../budgeter/calibration';
import { decomposeCacheMiss } from '../budgeter/cache-ledger';
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  messagesChars,
  parseContextWindow,
} from '../budgeter/estimator';
import { buildStaticSystemPrompt, buildRequestView, getSystemSections, ImageOptimizer } from '../compiler';
import type { PromptExtraSection, RulesSectionInput } from '../compiler/system-prompt';
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
import { applyFold, resolveSummaryModel } from '../compressor';
import { isProtectedMessage, planCompaction } from '../compressor/planner';
import {
  findArchivedByRef,
  gcContextStore,
  getExternalized,
  listArchiveSessionIds,
  listCompactions,
  readCompaction,
  searchArchive,
} from '../store/context-store';
import { readExternalizedFile } from '../compiler/tool-result-store';
import { ensureContextPrompts } from '../prompt-loader';
import { ensureSessionRefs, indexOfRef } from '../refs';
import { isReasoningContentProvider } from '../../llm/providers/openai-chat';

/** 本地自然日 key（YYYY-MM-DD；概览按日遥测的桶键） */
function localDayKey(date: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 按日遥测保留上限（天） */
const DAILY_USAGE_RETENTION_DAYS = 400;

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
  /** 上次发送视图对应的模型（校准必须按模型分键，否则切换模型后比率污染） */
  lastSentModel: string;
  /** 上一次请求的输入 token（缓存 miss 归因的“新内容”上界） */
  lastPromptTokens: number;
  /** 上一次 prepareRequest 是否触发了压缩 */
  lastCompactionTriggered: boolean;
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
  /** 动态系统提示附加段（代码模式 SDK；由 agent 引擎按当前工具集生成） */
  promptExtras?: PromptExtraSection[] | null;
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
  /** 自动压缩冷却水位：sessionId → { at, tokens }（防反复徒劳压缩） */
  /** 压缩冷却热缓存（真源在 session.compactionGuard；此处仅避免每次读会话） */
  private readonly compactionGuard = new Map<string, { at: number; tokens: number; windowTokens: number }>();
  /** 最近一次压缩失败：sessionId → { at, reason }（抑制压力提醒，防模型反复重试） */
  private readonly compactionFailures = new Map<string, { at: number; reason: string }>();
  /** 压缩重入锁：sessionId 正在压缩（防 governor 自动压缩与模型自主压缩并发） */
  private readonly compactingSessions = new Set<string>();
  /** 空闲后台预压缩定时器（run 结束 → 延迟检查；用户发新消息时取消） */
  private readonly backgroundCompactTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sessionStore: SessionStoreBridge | null = null;
  /** 图片优化器（发送前压缩；sharp 不可用时自动降级为不压缩） */
  private readonly imageOptimizer: ImageOptimizer;

  constructor(deps: ContextEngineServiceDeps) {
    this.env = deps.env;
    this.config = deps.config;
    this.services = deps.services;
    this.logger = deps.logger;
    this.imageOptimizer = new ImageOptimizer(deps.logger, () => this.getConfig().imageOptimization);
  }

  /** 模块初始化：只记录状态；提示词播种移到 onWarmup（启动路径零成本） */
  onInitialize(): void {
    this.logger.info('context: engine initialized', {
      compaction: this.getConfig().compaction.enabled ? 'enabled' : 'disabled',
    });
  }

  /** 后台预热：补充播种 compact/heal 提示词目录（幂等，仅缺失时复制） */
  onWarmup(): void {
    ensureContextPrompts(this.env);
  }

  /** 图片优化器访问器 */
  getImageOptimizer(): ImageOptimizer {
    return this.imageOptimizer;
  }

  /** agent 模块注入会话存取桥（依赖方向 agent → context） */
  bindSessionStore(bridge: SessionStoreBridge): void {
    this.sessionStore = bridge;
  }

  /** 读取压缩冷却水位：session 为真源，Map 仅作未绑定会话时的兜底 */
  private readCompactionGuard(sessionId: string): { at: number; tokens: number; windowTokens: number } | undefined {
    const session = this.sessionStore?.get(sessionId);
    if (session?.compactionGuard) return session.compactionGuard;
    return this.compactionGuard.get(sessionId);
  }

  /** 写入压缩冷却水位：同进程缓存 + session 持久化（重启不丢） */
  private writeCompactionGuard(
    sessionId: string,
    guard: { at: number; tokens: number; windowTokens: number },
  ): void {
    this.compactionGuard.set(sessionId, guard);
    const session = this.sessionStore?.get(sessionId);
    if (!session) return;
    session.compactionGuard = guard;
    try {
      this.sessionStore?.persist(session);
    } catch (err) {
      this.logger.warn('context: persist compaction guard failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 实时读取引擎配置（config:changed 自动生效） */
  getConfig(): ContextEngineConfig {
    const app = this.config.getAppConfig();
    const ctx = (app as { context?: Partial<ContextEngineConfig> }).context;
    if (!ctx) return DEFAULT_CONTEXT_CONFIG;
    return {
      compaction: { ...DEFAULT_CONTEXT_CONFIG.compaction, ...ctx.compaction },
      healer: { ...DEFAULT_CONTEXT_CONFIG.healer, ...ctx.healer },
      telemetry: { ...DEFAULT_CONTEXT_CONFIG.telemetry, ...ctx.telemetry },
      refs: { ...DEFAULT_CONTEXT_CONFIG.refs, ...ctx.refs },
      toolResultStorage: {
        ...DEFAULT_CONTEXT_CONFIG.toolResultStorage,
        ...ctx.toolResultStorage,
      },
      toolResultSummary: {
        ...DEFAULT_CONTEXT_CONFIG.toolResultSummary,
        ...ctx.toolResultSummary,
      },
      backgroundCompact: {
        ...DEFAULT_CONTEXT_CONFIG.backgroundCompact,
        ...ctx.backgroundCompact,
      },
      rules: { ...DEFAULT_CONTEXT_CONFIG.rules, ...ctx.rules },
      hooks: { ...DEFAULT_CONTEXT_CONFIG.hooks, ...ctx.hooks },
      memory: { ...DEFAULT_CONTEXT_CONFIG.memory, ...ctx.memory },
      imageOptimization: { ...DEFAULT_CONTEXT_CONFIG.imageOptimization, ...ctx.imageOptimization },
      thinking: { ...DEFAULT_CONTEXT_CONFIG.thinking, ...ctx.thinking },
      pressureReminder: { ...DEFAULT_CONTEXT_CONFIG.pressureReminder, ...ctx.pressureReminder },
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
    // 稳定消息引用：新消息在进入任何视图前分配 mNNNNN（编号永不复用）
    if (ensureSessionRefs(session)) {
      try {
        this.sessionStore?.persist(session);
      } catch {
        // 引用落盘失败不阻断请求；下一轮会重试
      }
    }
    const includeThinking = this.resolveIncludeThinking(opts.model);
    const deps = this.buildGovernorDeps(opts.model);
    const prepared = await governorPrepare(deps, {
      session,
      cwd: opts.cwd,
      model: opts.model,
      modelDisplayName: opts.modelDisplayName,
      windowTokens,
      promptExtras: opts.promptExtras ?? null,
      includeThinking,
    });

    // 图片「只发一次」：缓存本轮内联发送的图片消息引用（等待调用方确认/丢弃）
    if (prepared.imageMessagesToMark && prepared.imageMessagesToMark.length > 0) {
      this.pendingImageMarks.set(session.id, prepared.imageMessagesToMark);
    } else {
      this.pendingImageMarks.delete(session.id);
    }

    // 遥测：breakdown + systemSections + 发送字符数（校准口径）
    const sections = getSystemSections(
      this.env,
      this.buildRulesSectionForTelemetry(opts.cwd),
      opts.promptExtras ?? null,
    );
    const sentChars = messagesChars(
      prepared.messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.thinking !== undefined ? { thinking: m.thinking } : {}),
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
      includeThinking,
    );
    const t = this.ensureTelemetry(session.id);
    t.lastBreakdown = prepared.breakdown;
    t.lastWindowTokens = windowTokens;
    t.lastSystemSections = sections;
    t.lastSentChars = sentChars;
    t.lastSentModel = opts.model;
    t.lastCompactionTriggered = prepared.compactionTriggered;

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
    // 用户还在跑：取消任何待执行的空闲预压缩
    this.cancelBackgroundCompact(sessionId);
  }

  markIdle(sessionId: string): void {
    this.busySessions.delete(sessionId);
    this.scheduleBackgroundCompact(sessionId);
  }

  /** 模块销毁：清理所有待执行的空闲预压缩定时器 */
  dispose(): void {
    for (const timer of this.backgroundCompactTimers.values()) clearTimeout(timer);
    this.backgroundCompactTimers.clear();
  }

  /** 取消待执行的空闲预压缩（用户发新消息 / 会话销毁） */
  private cancelBackgroundCompact(sessionId: string): void {
    const timer = this.backgroundCompactTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.backgroundCompactTimers.delete(sessionId);
  }

  /** run 结束后延迟检查：占用 ≥ 阈值且会话仍空闲，则提前压缩（避免下一轮请求前阻塞） */
  private scheduleBackgroundCompact(sessionId: string): void {
    const cfg = this.getConfig().backgroundCompact;
    if (!cfg.enabled) return;
    if (this.backgroundCompactTimers.has(sessionId)) return;
    const delay = Math.max(0, cfg.delayMs);
    const timer = setTimeout(() => {
      this.backgroundCompactTimers.delete(sessionId);
      void this.runBackgroundCompact(sessionId);
    }, delay);
    this.backgroundCompactTimers.set(sessionId, timer);
  }

  private async runBackgroundCompact(sessionId: string): Promise<void> {
    if (this.busySessions.has(sessionId) || this.compactingSessions.has(sessionId)) return;
    const session = this.sessionStore?.get(sessionId);
    if (!session) return;
    const cfg = this.getConfig().backgroundCompact;
    const stats = this.getStats(sessionId);
    if (!stats || stats.windowTokens <= 0) return;
    const ratio = (stats.lastUsage?.promptTokens ?? stats.breakdown.total) / stats.windowTokens;
    if (ratio < cfg.ratio) return;
    const outcome = await this.manualCompact(sessionId);
    this.logger.debug('context: background compaction', {
      sessionId,
      ratio: Number(ratio.toFixed(3)),
      ok: outcome.ok,
      reason: outcome.reason,
    });
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
    if (this.compactingSessions.has(sessionId)) {
      return { ok: false, reason: 'compaction already in progress' };
    }
    // 用会话最近一次请求的模型解析窗口；无样本才回退全局默认模型。
    const model = session.contextTelemetry?.lastModel ?? this.resolveMainModel();
    const windowTokens = this.resolveWindowTokens(model);
    ensureSessionRefs(session);
    const deps = this.buildGovernorDeps(model);
    this.compactingSessions.add(sessionId);
    try {
      const outcome = await governorManualCompact(deps, {
        session,
        cwd: session.lastCwd ?? this.lastCwd ?? process.cwd(),
        model,
        modelDisplayName: model,
        windowTokens,
        ...(focus !== undefined ? { focus } : {}),
      });
      this.noteCompactionOutcome(sessionId, outcome);
      if (outcome.record) {
        this.writeCompactionGuard(sessionId, {
          at: Date.now(),
          tokens: outcome.record.afterTokens,
          windowTokens,
        });
      }
      return outcome.record
        ? { ok: true, compaction: outcome.record }
        : { ok: false, reason: outcome.reason ?? 'compaction not applicable' };
    } finally {
      this.compactingSessions.delete(sessionId);
    }
  }

  /**
   * 模型自主压缩（运行中可用；context 工具 action=compact 调用）。
   * 与 manualCompact 复用同一压缩流程，但**跳过 busy 检查**（模型在工具阶段主动压缩），
   * 并以重入锁防止与 governor 自动压缩并发。
   */
  async compactNow(sessionId: string, focus?: string): Promise<ManualCompactResult> {
    const session = this.sessionStore?.get(sessionId);
    if (!session) return { ok: false, reason: 'session not found' };
    if (this.compactingSessions.has(sessionId)) {
      return { ok: false, reason: 'compaction already in progress' };
    }
    const model = session.contextTelemetry?.lastModel ?? this.resolveMainModel();
    const windowTokens = this.resolveWindowTokens(model);
    ensureSessionRefs(session);
    const deps = this.buildGovernorDeps(model);
    this.compactingSessions.add(sessionId);
    try {
      const outcome = await governorManualCompact(deps, {
        session,
        cwd: session.lastCwd ?? this.lastCwd ?? process.cwd(),
        model,
        modelDisplayName: model,
        windowTokens,
        ...(focus !== undefined ? { focus } : {}),
      });
      this.noteCompactionOutcome(sessionId, outcome);
      if (outcome.record) {
        // 模型自主压缩完成后也记水位，避免 governor 紧接再来一轮自动压缩
        this.writeCompactionGuard(sessionId, {
          at: Date.now(),
          tokens: outcome.record.afterTokens,
          windowTokens,
        });
      }
      return outcome.record
        ? { ok: true, compaction: outcome.record }
        : { ok: false, reason: outcome.reason ?? 'compaction not applicable' };
    } finally {
      this.compactingSessions.delete(sessionId);
    }
  }

  /**
   * 模型主导压缩：按 ref 区间折叠，摘要由模型自己写（不再额外调用摘要 LLM）。
   * 全有或全无：任一区间校验失败则一条都不折叠，避免半截状态。
   */
  async compressRanges(
    sessionId: string,
    ranges: ModelCompressRange[],
    _focus?: string,
  ): Promise<ModelCompressResult> {
    const session = this.sessionStore?.get(sessionId);
    if (!session) return { ok: false, reason: 'session not found', blockIds: [], foldedRanges: 0 };
    if (this.compactingSessions.has(sessionId)) {
      return { ok: false, reason: 'compaction already in progress', blockIds: [], foldedRanges: 0 };
    }
    if (!Array.isArray(ranges) || ranges.length === 0) {
      return { ok: false, reason: 'ranges required', blockIds: [], foldedRanges: 0 };
    }
    ensureSessionRefs(session);
    const config = this.getConfig();
    const messages = session.messages;
    const protectedTools = config.compaction.protectedTools;
    const latestUserIndex = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'user' && !m.name && !m.deletedAt && !m.compacted) return i;
      }
      return -1;
    })();

    interface Resolved {
      start: number;
      end: number;
      region: ContextMessage[];
      summary: string;
    }
    const resolved: Resolved[] = [];
    const errors: string[] = [];

    for (const range of ranges) {
      const label = `${range.startRef ?? '?'}–${range.endRef ?? '?'}`;
      let start = indexOfRef(session, range.startRef ?? '');
      let end = indexOfRef(session, range.endRef ?? '');
      if (start < 0 || end < 0) {
        errors.push(`${label}: ref 不存在（用 status 查看当前有效 ref）`);
        continue;
      }
      if (start > end) [start, end] = [end, start];

      // turn 完整性：区间不能以孤立 tool 结果开头，也不能把 assistant(tool_calls) 与结果拆开
      if (messages[start].role === 'tool' && messages[start].toolCallId) {
        for (let i = start - 1; i >= 0; i--) {
          const candidate = messages[i];
          if (candidate.role === 'assistant' && candidate.toolCalls?.some(tc => tc.id === messages[start].toolCallId)) {
            start = i;
            break;
          }
        }
      }
      if (messages[end].role === 'assistant' && messages[end].toolCalls?.length) {
        const ids = new Set(messages[end].toolCalls!.map(tc => tc.id));
        let j = end + 1;
        while (j < messages.length && messages[j].role === 'tool' && ids.has(messages[j].toolCallId ?? '')) {
          end = j;
          j++;
        }
      }

      const region = messages.slice(start, end + 1);
      if (region.length === 0) {
        errors.push(`${label}: 区间为空`);
        continue;
      }
      if (region.some(m => m.deletedAt || m.compacted)) {
        errors.push(`${label}: 区间包含已删除或已压缩消息`);
        continue;
      }
      if (region.some(m => isProtectedMessage(m, protectedTools))) {
        errors.push(`${label}: 区间包含受保护消息（env-context / 受保护工具）`);
        continue;
      }
      if (latestUserIndex >= start && latestUserIndex <= end) {
        errors.push(`${label}: 不能折叠用户最新的原始请求`);
        continue;
      }
      const summary = (range.summary ?? '').trim();
      if (summary.length < config.compaction.minSummaryLength) {
        errors.push(`${label}: 摘要过短（${summary.length} < ${config.compaction.minSummaryLength} 字符）`);
        continue;
      }
      if (summary.length > config.compaction.maxSummaryLength) {
        errors.push(`${label}: 摘要过长（${summary.length} > ${config.compaction.maxSummaryLength} 字符）`);
        continue;
      }
      const regionTokens = estimateMessagesTokens(region);
      if (regionTokens < config.compaction.minCompressRange) {
        errors.push(`${label}: 区间过小（${regionTokens} < ${config.compaction.minCompressRange} tokens）`);
        continue;
      }
      const summaryTokens = estimateTextTokens(summary) + 8;
      if (summaryTokens > regionTokens * config.compaction.maxShrinkRatio) {
        errors.push(
          `${label}: 摘要不够小（${summaryTokens} > ${regionTokens} × ${config.compaction.maxShrinkRatio}），请压缩摘要或合并更大区间`,
        );
        continue;
      }
      resolved.push({ start, end, region, summary });
    }

    // 区间重叠检查（展开后）
    const ordered = [...resolved].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].start <= ordered[i - 1].end) {
        errors.push(`区间重叠：${ordered[i - 1].start}-${ordered[i - 1].end} 与 ${ordered[i].start}-${ordered[i].end}`);
      }
    }
    if (errors.length > 0) {
      return { ok: false, reason: 'range validation failed', errors, blockIds: [], foldedRanges: 0 };
    }

    this.compactingSessions.add(sessionId);
    try {
      const activeBefore = session.messages.filter(m => !m.deletedAt && !m.compacted);
      const beforeTokens = estimateMessagesTokens(activeBefore);
      const blockIds: string[] = [];
      for (const item of ordered) {
        const record = applyFold({
          env: this.env,
          session,
          region: item.region,
          summary: item.summary,
          summaryModel: 'model',
          trigger: 'model',
        });
        blockIds.push(record.blockId ?? record.id);
        this.compactionFailures.delete(sessionId);
      }
      ensureSessionRefs(session);
      delete session.pressureState;
      try {
        this.sessionStore?.persist(session);
      } catch (err) {
        this.logger.warn('context: persist model compaction failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const windowTokens = this.resolveWindowTokens(
        session.contextTelemetry?.lastModel ?? this.resolveMainModel(),
      );
      const afterActive = session.messages.filter(m => !m.deletedAt && !m.compacted);
      this.writeCompactionGuard(sessionId, {
        at: Date.now(),
        tokens: estimateMessagesTokens(afterActive),
        windowTokens,
      });
      this.emitWs(sessionId, {
        type: 'compaction-completed',
        sessionId,
        payload: {
          sessionId,
          compaction: session.compactions?.[session.compactions.length - 1],
        },
      });
      return {
        ok: true,
        blockIds,
        foldedRanges: blockIds.length,
        beforeTokens,
        afterTokens: estimateMessagesTokens(afterActive),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.noteCompactionOutcome(sessionId, { record: null, reason: msg });
      return { ok: false, reason: msg, blockIds: [], foldedRanges: 0 };
    } finally {
      this.compactingSessions.delete(sessionId);
    }
  }

  /** 手动压缩预览（确认对话框数据源） */
  previewCompact(sessionId: string): CompactPreview | null {
    const session = this.sessionStore?.get(sessionId);
    if (!session) return null;
    const model = session.contextTelemetry?.lastModel ?? this.resolveMainModel();
    const windowTokens = this.resolveWindowTokens(model);
    const deps = this.buildGovernorDeps(model);
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
    // 物理折叠后 session.messages 里不再有 compacted 标记，历史累计以 compactions 为准
    const compactedMessages = (session.compactions ?? []).reduce((sum, c) => sum + c.compactedCount, 0);
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
    const modelId = session.contextTelemetry?.lastModel ?? this.resolveMainModel();

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
      ...(session.contextTelemetry?.cacheLedger
        ? { cacheLedger: session.contextTelemetry.cacheLedger.slice(-20) }
        : {}),
    };
  }

  /** 压缩历史 */
  getCompactions(sessionId: string): CompactionRecord[] {
    const session = this.sessionStore?.get(sessionId);
    return session?.compactions ? [...session.compactions] : [];
  }

  /** 上下文制品 GC（归档 + 外置工具结果；只删过期制品，不动 session 主存储） */
  gcContext(olderThanDays = 365): { compactions: number; messages: number; externalized: number; files: number } {
    return gcContextStore(this.env, olderThanDays);
  }

  // ========================================================================
  // 上下文自省 / 归档检索（context 工具 status / decompress / search）
  // ========================================================================

  /** 沿 derivedFrom 父链收集会话 id（含自身；深度上限 8，带环检测） */
  private lineageSessionIds(sessionId: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = sessionId;
    for (let depth = 0; depth < 8 && current && !seen.has(current); depth++) {
      seen.add(current);
      out.push(current);
      current = this.sessionStore?.get(current)?.derivedFrom;
    }
    return out;
  }

  /** 上下文自省：占用、构成、可压缩区间、活跃块账本 */
  getStatusReport(sessionId: string): ContextStatusReport | null {
    const session = this.sessionStore?.get(sessionId);
    if (!session) return null;
    const stats = this.getStats(sessionId);
    if (!stats) return null;
    const config = this.getConfig();
    const active = session.messages.filter(m => !m.deletedAt && !m.compacted);
    const compactable: ContextStatusRange[] = [];

    const plan = planCompaction(
      active,
      stats.windowTokens,
      config.compaction.tailKeepRatio,
      config.compaction.minFoldTokens,
      config.compaction.minCompactMessages,
      config.compaction.protectedTools,
      config.compaction.preserveRecentTokens,
    );
    if (plan.ok) {
      const region = active
        .slice(plan.startIdx, plan.endIdx + 1)
        .filter(m => !isProtectedMessage(m, config.compaction.protectedTools));
      if (region.length > 0) {
        compactable.push({
          ...(region[0].ref ? { startRef: region[0].ref } : {}),
          ...(region[region.length - 1].ref ? { endRef: region[region.length - 1].ref } : {}),
          messages: region.length,
          tokens: estimateMessagesTokens(region),
        });
      }
    }

    // 额外的“单条大招”提示：模型可按 ref 精确折叠某个超大工具结果/消息。
    const singles = active
      .filter(m => !isProtectedMessage(m) && m.role !== 'user')
      .map(m => ({ m, tokens: estimateMessageTokens(m) }))
      .filter(x => x.tokens >= 2000 && x.m.ref)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5);
    for (const { m, tokens } of singles) {
      compactable.push({ startRef: m.ref, endRef: m.ref, messages: 1, tokens });
    }

    const blocks: ContextStatusBlock[] = listCompactions(this.env, sessionId, 10).map(b => ({
      id: b.id,
      tier: b.tier,
      refs: b.refs,
      tokens: Math.max(0, Math.round(b.summary.length * 0.4)),
      createdAt: b.createdAt,
      trigger: b.trigger,
    }));

    const activeSummary = session.messages.find(
      m => m.name === 'compaction-summary' && !m.compacted && !m.deletedAt,
    );
    return {
      sessionId,
      usedTokens: stats.lastUsage?.promptTokens ?? stats.breakdown.total,
      windowTokens: stats.windowTokens,
      usedPercent: stats.usedPercent,
      breakdown: stats.breakdown,
      compactable,
      blocks,
      activeSummaryTokens: activeSummary ? estimateTextTokens(activeSummary.content) : 0,
      ...(session.pressureState
        ? { pressure: { lastTokens: session.pressureState.lastTokens, lastBand: session.pressureState.lastBand } }
        : {}),
    };
  }

  /**
   * 解压归档原文：先按 blockId 查当前会话，再沿父链查；blockId 若不是块 id，
   * 则按消息 ref（mNNNNN）查找。返回的是历史原文，不是当前指令。
   */
  decompressCompaction(sessionId: string, blockIdOrRef: string, limit = 200): DecompressResult {
    const lineage = this.lineageSessionIds(sessionId);
    for (const sid of lineage) {
      const found = readCompaction(this.env, sid, blockIdOrRef, limit);
      if (found.meta) {
        return {
          ok: true,
          blockId: found.meta.id,
          tier: found.meta.tier,
          total: found.meta.count,
          messages: found.messages.map(m => ({
            ...(m.ref ? { ref: m.ref } : {}),
            index: m.index,
            role: m.role,
            ...(m.name ? { name: m.name } : {}),
            content: m.content,
            ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
            ...(m.timestamp ? { timestamp: m.timestamp } : {}),
          })),
        };
      }
    }
    if (/^m\d{1,7}$/i.test(blockIdOrRef.trim())) {
      const byRef = findArchivedByRef(this.env, lineage, blockIdOrRef.trim().toLowerCase());
      if (byRef) {
        return {
          ok: true,
          blockId: byRef.meta.id,
          tier: byRef.meta.tier,
          total: 1,
          messages: [
            {
              ...(byRef.message.ref ? { ref: byRef.message.ref } : {}),
              index: byRef.message.index,
              role: byRef.message.role,
              ...(byRef.message.name ? { name: byRef.message.name } : {}),
              content: byRef.message.content,
              ...(byRef.message.toolCallId ? { toolCallId: byRef.message.toolCallId } : {}),
              ...(byRef.message.timestamp ? { timestamp: byRef.message.timestamp } : {}),
            },
          ],
        };
      }
    }
    return { ok: false, reason: `未找到块或引用：${blockIdOrRef}`, messages: [], total: 0 };
  }

  /** 取回被外置的大工具结果（按会话及父链校验） */
  retrieveExternalized(sessionId: string, ref: string): RetrieveResult {
    const target = ref.trim().toLowerCase();
    for (const sid of this.lineageSessionIds(sessionId)) {
      const record = getExternalized(this.env, sid, target);
      if (!record) continue;
      try {
        return {
          ok: true,
          ref: record.ref,
          path: record.path,
          tokens: record.tokens,
          content: readExternalizedFile(record),
        };
      } catch (err) {
        return {
          ok: false,
          ref: record.ref,
          path: record.path,
          reason: `读取外置文件失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    return { ok: false, reason: `未找到外置内容：${ref}` };
  }

  /** 归档检索（scope=current 含父链；scope=all 全库） */
  searchContextArchive(
    sessionId: string,
    query: string,
    scope: 'current' | 'all',
    topK = 5,
    includeTool = false,
  ): ArchiveSearchResult[] {
    const ids = scope === 'all' ? listArchiveSessionIds(this.env) : this.lineageSessionIds(sessionId);
    return searchArchive(this.env, ids, query, topK, includeTool).map(h => ({
      sessionId: h.sessionId,
      blockId: h.compactionId,
      tier: h.tier,
      ...(h.ref ? { ref: h.ref } : {}),
      index: h.index,
      role: h.role,
      snippet: h.snippet,
      score: h.score,
      ...(h.timestamp ? { timestamp: h.timestamp } : {}),
      archived: true,
    }));
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
      // 会话级全量累计（设置-概览「用量」精确数据源；历史会话无此字段时按 lastRunStats 回退）
      const prevTotals = session.contextTelemetry?.usageTotals;
      // 按自然日累计：概览两张趋势图（请求次数 / 三段 tokens）的数据源
      const dayKey = localDayKey(new Date());
      const daily = { ...(session.contextTelemetry?.usageDaily ?? {}) };
      const dayUsage = daily[dayKey] ?? {
        promptTokens: 0,
        cachedTokens: 0,
        completionTokens: 0,
        requests: 0,
      };
      daily[dayKey] = {
        promptTokens: dayUsage.promptTokens + promptTokens,
        cachedTokens: dayUsage.cachedTokens + cachedTokens,
        completionTokens: dayUsage.completionTokens + completionTokens,
        requests: dayUsage.requests + 1,
      };
      const dayKeys = Object.keys(daily).sort();
      if (dayKeys.length > DAILY_USAGE_RETENTION_DAYS) {
        for (const stale of dayKeys.slice(0, dayKeys.length - DAILY_USAGE_RETENTION_DAYS)) {
          delete daily[stale];
        }
      }
      // 缓存 miss 三分账：新内容 / 压缩重付 / TTL 重付
      const ledgerSample = decomposeCacheMiss({
        input: promptTokens,
        cached: cachedTokens,
        previousInput: t.lastPromptTokens,
        compactionTriggered: t.lastCompactionTriggered,
      });
      const cacheLedger = [
        ...(session.contextTelemetry?.cacheLedger ?? []),
        {
          at: new Date().toISOString(),
          input: promptTokens,
          cached: cachedTokens,
          ...ledgerSample,
          compactionTriggered: t.lastCompactionTriggered,
        },
      ];
      if (cacheLedger.length > CACHE_LEDGER_BUFFER_SIZE) {
        cacheLedger.splice(0, cacheLedger.length - CACHE_LEDGER_BUFFER_SIZE);
      }
      session.contextTelemetry = {
        lastUsage,
        cacheHits,
        usageTotals: {
          promptTokens: (prevTotals?.promptTokens ?? 0) + promptTokens,
          completionTokens: (prevTotals?.completionTokens ?? 0) + completionTokens,
          cachedTokens: (prevTotals?.cachedTokens ?? 0) + cachedTokens,
          requests: (prevTotals?.requests ?? 0) + 1,
          since: prevTotals?.since ?? new Date().toISOString(),
        },
        usageDaily: daily,
        cacheLedger,
        lastModel: t.lastSentModel || session.contextTelemetry?.lastModel,
      };
      t.lastPromptTokens = promptTokens;
      t.lastCompactionTriggered = false;
      try {
        this.sessionStore?.persist(session);
      } catch (err) {
        this.logger.warn('context: persist telemetry failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // tokPerChar 校准（按模型分键；chars 口径：最近一次发送内容）
    this.calibrator.calibrate(t.lastSentModel || this.resolveMainModel(), promptTokens, t.lastSentChars);

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

  private buildGovernorDeps(modelKey?: string): GovernorDeps {
    const calibrationKey = modelKey || this.resolveMainModel();
    return {
      env: this.env,
      logger: this.logger,
      services: this.services,
      getConfig: () => this.getConfig(),
      getLlm: () => this.services.tryResolve<LLMRouter>(ServiceNames.LLM_ROUTER),
      getApiModels: () =>
        flattenModels(this.config.getApiConfig()).map(m => ({ id: m.id, model: m.model })),
      getImageOptimizer: () => this.imageOptimizer,
      getCompactionGuard: (sessionId: string) => this.readCompactionGuard(sessionId),
      setCompactionGuard: (
        sessionId: string,
        guard: { at: number; tokens: number; windowTokens: number },
      ) => {
        this.writeCompactionGuard(sessionId, guard);
      },
      getCompactionFailure: (sessionId: string) => this.compactionFailures.get(sessionId),
      estimateTokensForMessages: (messages) => {
        if (!this.calibrator.isCalibrated(calibrationKey)) return null;
        let chars = 0;
        for (const m of messages) {
          chars += m.content.length;
          // 视图按 provider 语义保留了 thinking（Anthropic / DeepSeek）时必须计入，
          // 否则校准比例与上下文占用会被系统性低估。
          if (m.thinking) chars += m.thinking.length;
          if (m.name) chars += m.name.length;
          if (m.toolCallId) chars += m.toolCallId.length;
          for (const tc of m.toolCalls ?? []) {
            chars += tc.id.length + tc.function.name.length + tc.function.arguments.length;
          }
        }
        return this.calibrator.estimateTokens(calibrationKey, chars);
      },
      persistSession: session => this.sessionStore?.persist(session),
      emitWs: (sessionId, message) => this.emitWs(sessionId, message),
      onCompactionFailure: (sessionId, reason) => {
        this.compactionFailures.set(sessionId, { at: Date.now(), reason });
      },
      onCompaction: sessionId => {
        this.compactionFailures.delete(sessionId);
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
        lastSentModel: '',
        lastPromptTokens: 0,
        lastCompactionTriggered: false,
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
      const cwd = session.lastCwd ?? this.lastCwd ?? process.cwd();
      const rulesSection = this.buildRulesSectionForTelemetry(cwd);
      const staticSystemPrompt = buildStaticSystemPrompt(
        this.env,
        rulesSection,
      );
      const view = buildRequestView(session, staticSystemPrompt, {
        includeThinking: this.resolveIncludeThinking(model),
        renderRefs: this.getConfig().refs.enabled,
      });
      t.lastBreakdown = view.breakdown;
      t.lastWindowTokens = this.resolveWindowTokens(model);
      t.lastSystemSections = getSystemSections(
        this.env,
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
      const text = buildRulesSection(this.env, compiled.alwaysRules);
      if (!text) return null;
      return { fingerprint: compiled.fingerprint, text };
    } catch {
      return null;
    }
  }

  /**
   * 记录压缩结果：失败写入冷却（governor 据此抑制压力提醒），成功清除。
   * 这一步是「压缩失败后模型反复重试」的止损闸门。
   */
  private noteCompactionOutcome(
    sessionId: string,
    outcome: { record: import('../types').CompactionRecord | null; reason?: string },
  ): void {
    if (outcome.record) {
      this.compactionFailures.delete(sessionId);
      return;
    }
    this.compactionFailures.set(sessionId, {
      at: Date.now(),
      reason: outcome.reason ?? 'compaction not applicable',
    });
  }

  /**
   * provider 是否会回传 thinking（决定视图是否保留、估算是否计入）：
   * - anthropic：带 thinkingSignature 时回传；
   * - DeepSeek（openai-chat）：携带 tools 的请求必须完整回传历史 reasoning_content
   *   （官方契约），因此恒为 true，与本地 thinking 开关无关；
   * - 其他 openai 兼容：仅 context.thinking.replayOpenAICompat=true。
   */
  private resolveIncludeThinking(model: string): boolean {
    try {
      const models = flattenModels(this.config.getApiConfig());
      const found = models.find(m => m.id === model || m.model === model);
      if (!found) return false;
      if (found.format === 'anthropic') return true;
      if (found.format === 'openai-chat' && isReasoningContentProvider(found)) return true;
      const app = this.config.getAppConfig() as {
        context?: { thinking?: { replayOpenAICompat?: boolean } };
      };
      return app.context?.thinking?.replayOpenAICompat === true;
    } catch {
      return false;
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

  /** 摘要模型解析（设置页/调试） */
  resolveSummaryModelId(): string {
    const config = this.getConfig();
    const main = this.resolveMainModel();
    return resolveSummaryModel(config.compaction.summaryModel, main, []).requestModel;
  }
}
