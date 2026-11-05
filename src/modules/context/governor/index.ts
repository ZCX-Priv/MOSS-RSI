// src/modules/context/governor/index.ts
// 治理器：每轮 LLM 请求前的统一流水线（engine 调用点）。
//   1. ensureEnvContext（跨天环境追加 / 旧会话补建锚定）
//   1.7 记忆注入（memory 引擎）：L1 关键事实锚定（每会话一次）+ L2 召回（ephemeral 尾部）
//   1.8 规则注入（rules 引擎）：always 段入系统提示（paths 规则由 agent 工具调用后直接追加锚定消息）
//   2. 构建静态系统提示（skill system 模式注入 + always 用户规则段）
//   3. 预览视图估算 → shouldCompact → 同步执行压缩（唯一防溢出时机）
//   4. 溢出兜底：压缩后仍超窗 → view-builder 尾部裁剪（最后防线）
//   5. 最终视图 + breakdown
// 异常降级：任何环节失败 → 兜底视图（degradedReason 标注），绝不中断主循环。

import type { Environment, Logger, ServiceRegistry } from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import type { LLMRouter } from '../../contracts';
import type {
  CompactionRecord,
  ContextEngineConfig,
  ContextMessage,
  ContextSessionLike,
  PreparedRequest,
} from '../types';
import { buildStaticSystemPrompt, buildRequestView, ensureEnvContext, collectSessionImagePaths } from '../compiler';
import type { OptimizedImage, ImageOptimizer } from '../compiler';
import type { PromptExtraSection, RulesSectionInput } from '../compiler/system-prompt';
import { MEMORY_L1_MSG_NAME, MEMORY_RECALL_MSG_NAME } from '../compiler/view-builder';
import { compactSession, resolveSummaryModel } from '../compressor';
import { planCompaction } from '../compressor/planner';
import { loadPromptFile, renderTemplate } from '../prompt-loader';
import { estimateTextTokens, estimateMessagesTokens } from '../budgeter/estimator';
import { shouldCompact, needsHardCeiling, compactionActive } from './triggers';
import { buildRulesSection } from '../../rules/inject';
import type { RulesEngineServiceImpl } from '../../rules/service';
import type { MemoryEngineServiceImpl } from '../../memory/service';

/** SkillRegistry 鸭子类型（避免直接依赖 tools 模块类型） */
interface SkillRegistryLike {
  get(name: string): { prompt: string } | null;
  isEnabled(name: string): boolean;
}

export interface GovernorDeps {
  env: Environment;
  logger: Logger;
  services: ServiceRegistry;
  /** 实时读取上下文引擎配置（热更新） */
  getConfig(): ContextEngineConfig;
  /** 实时读取 LLM Router（延迟解析：llm 模块可能尚未就绪） */
  getLlm(): LLMRouter | null;
  /** 实时读取模型列表（摘要模型解析） */
  getApiModels(): Array<{ id: string; model: string }>;
  /** session 持久化回调（agent 模块 bind 注入） */
  persistSession(session: ContextSessionLike): void;
  /** WS 推送回调 */
  emitWs(sessionId: string, message: unknown): void;
  /** 压缩完成遥测回调 */
  onCompaction(sessionId: string, record: CompactionRecord): void;
  /** 自动压缩失败回调（记录冷却，抑制压力提醒） */
  onCompactionFailure?(sessionId: string, reason: string): void;
  /** 降级遥测回调 */
  onDegraded(sessionId: string, reason: string): void;
  /** 图片优化器（发送前压缩；模块未就绪返回 null → 发送原图） */
  getImageOptimizer?(): ImageOptimizer | null;
  /** 上次自动压缩水位（冷却判定）：{ at: 时间戳ms, tokens: 压缩后估算 }；无则 undefined */
  getCompactionGuard?(sessionId: string): { at: number; tokens: number } | undefined;
  /** 记录本次自动压缩水位（供冷却判定） */
  setCompactionGuard?(sessionId: string, guard: { at: number; tokens: number }): void;
  /** 按真实 usage/char 校准后的 token 估算（未校准时返回 null，回退 breakdown 估算） */
  estimateTokensForMessages?(messages: readonly import('../../llm/types').UnifiedMessage[]): number | null;
  /** 最近一次压缩失败（用于抑制压力提醒，防止模型反复重试） */
  getCompactionFailure?(sessionId: string): { at: number; reason: string } | undefined;
}

export interface PrepareRequestInput {
  session: ContextSessionLike;
  cwd: string;
  /** 主模型请求名（发送给 LLM 的 model 字段值） */
  model: string;
  modelDisplayName: string;
  /** 上下文窗口 token（调用方从模型配置解析） */
  windowTokens: number;
  /** 动态系统提示附加段（代码模式 SDK 等；由 agent 引擎每轮生成） */
  promptExtras?: PromptExtraSection[] | null;
  /** 是否把 thinking 纳入发送视图（provider 会回传 reasoning_content 时才为 true） */
  includeThinking?: boolean;
}

/** 解析 skill prompt（SkillRegistry 运行时解析；禁用/缺失返回 null） */
function resolveSkillPromptFromRegistry(
  services: ServiceRegistry,
  skillName: string | undefined,
): string | null {
  if (!skillName) return null;
  const registry = services.tryResolve<SkillRegistryLike>(ServiceNames.SKILL_REGISTRY);
  if (!registry) return null;
  const skill = registry.get(skillName);
  if (!skill || !registry.isEnabled(skillName)) return null;
  return skill.prompt;
}

/** 构建 always 用户规则段（rules 引擎可用且启用时；失败返回 null） */
function buildRulesSectionForRequest(
  deps: GovernorDeps,
  config: ContextEngineConfig,
  sessionId: string,
  cwd: string,
): RulesSectionInput | null {
  const rulesEngine = deps.services.tryResolve<RulesEngineServiceImpl>(ServiceNames.RULES_ENGINE);
  if (!rulesEngine || !config.rules.enabled) return null;
  try {
    const compiled = rulesEngine.getCompiledSet(cwd);
    const text = buildRulesSection(compiled.alwaysRules);
    if (!text) return null;
    const alwaysTokens = estimateTextTokens(text);
    if (alwaysTokens > config.rules.maxAlwaysTokens) {
      deps.logger.warn('context: always rules exceed budget', {
        sessionId,
        alwaysTokens,
        budget: config.rules.maxAlwaysTokens,
      });
      deps.onDegraded(sessionId, `always rules ${alwaysTokens} tokens exceed budget ${config.rules.maxAlwaysTokens}`);
    }
    return { fingerprint: compiled.fingerprint, text };
  } catch (err) {
    deps.logger.warn('context: rules section build failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** 上下文过半提醒消息 name（ephemeral；仅本次请求视图、不持久化） */
export const CONTEXT_PRESSURE_MSG_NAME = 'context-pressure';

/** 提醒提示词缺失时的内置兜底文本（占位符由 renderTemplate 替换） */
const PRESSURE_REMINDER_FALLBACK =
  '当前上下文占用已达 {{PERCENT}}%（约 {{USED}} / {{MAX}} tokens 的模型上下文窗口）。\n\n' +
  '处理建议：先写交接（关键结论、文件/路径、未完成事项与下一步），' +
  '再调用 context 工具（action=compact）压缩较早消息。' +
  '若压缩失败或不可用，不要反复重试，继续当前任务；上下文并未因失败而变满。';

/**
 * 构造「上下文过半提醒」文本（纯函数，便于单测）。
 * @param usedTokens 当前上下文占用估算（token）
 * @param maxTokens 模型支持的上下文窗口（token）
 * @param ratio 占用比例（used/max）
 */
export function buildContextPressureReminder(
  env: Environment,
  usedTokens: number,
  maxTokens: number,
  ratio: number,
): string {
  const template = loadPromptFile(env, 'context/pressure.md', PRESSURE_REMINDER_FALLBACK);
  // PERCENT 仅数字（模板中自带 % 号，避免渲染出 "62%%"）
  return renderTemplate(template, {
    PERCENT: String(Math.round(ratio * 100)),
    USED: String(usedTokens),
    MAX: String(maxTokens),
  });
}

/**
 * 请求准备流水线。失败降级（degradedReason 标注）而非抛错。
 */
export async function prepareRequest(
  deps: GovernorDeps,
  input: PrepareRequestInput,
): Promise<PreparedRequest> {
  const { session, cwd, model, modelDisplayName, windowTokens } = input;
  const includeThinking = input.includeThinking === true;
  const config = deps.getConfig();

  // ===== 1. 环境上下文保障（跨天追加 / 旧会话补建；模型信息随消息锚定）=====
  try {
    if (ensureEnvContext(session, deps.env, cwd, model, modelDisplayName)) {
      deps.persistSession(session);
    }
  } catch (err) {
    deps.logger.warn('context: ensureEnvContext failed', {
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ===== 1.7 记忆注入（memory 引擎；模块未启用/未注册时跳过）=====
  const memoryEngine = deps.services.tryResolve<MemoryEngineServiceImpl>(ServiceNames.MEMORY_ENGINE);
  let ephemeralMessages: Array<import('../types').ContextMessage> | undefined;
  if (memoryEngine && config.memory.enabled) {
    try {
      // L1 关键事实锚定（每会话一次；跨 run 持久）
      const memoryState = session.memoryState;
      if (!memoryState?.l1InjectedAt) {
        const l1Text = memoryEngine.buildL1Section(cwd);
        if (l1Text) {
          session.messages.push({
            role: 'user',
            name: MEMORY_L1_MSG_NAME,
            content: l1Text,
            timestamp: new Date().toISOString(),
          });
        }
        session.memoryState = {
          ...(memoryState ?? { excludeFromRecall: [], currentRecalled: [], lastDistilledIndex: 0 }),
          l1InjectedAt: new Date().toISOString(),
        };
        deps.persistSession(session);
      }

      // L2 主题召回（ephemeral 尾部消息；query = 最近一条 user 消息）。
      // 去重语义（按消息切换）：同消息多轮间注入稳定；新消息排除上一条的召回。
      const lastUser = [...session.messages].reverse().find(m => m.role === 'user' && !m.deletedAt && !m.compacted && !m.name);
      if (lastUser) {
        const recall = memoryEngine.buildRecallSection(session, lastUser.content, cwd);
        // 消息切换（新用户输入）：持久化召回状态（每条消息仅一次，避免轮次级 IO）
        if (recall.queryChanged) {
          deps.persistSession(session);
        }
        if (recall.text && recall.count > 0) {
          ephemeralMessages = [
            {
              role: 'user',
              name: MEMORY_RECALL_MSG_NAME,
              content: recall.text,
              timestamp: new Date().toISOString(),
            },
          ];
        }
      }
    } catch (err) {
      deps.logger.warn('context: memory injection failed', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ===== 1.8 always 用户规则段（rules 引擎；paths 规则由 agent 工具调用后追加锚定）=====
  const rulesSection = buildRulesSectionForRequest(deps, config, session.id, cwd);

  // ===== 2. 静态系统提示（纯文本拼接；skill system 模式注入 + always 用户规则段）=====
  const skillName = session.activeSkill?.mode === 'system' ? session.activeSkill.name : undefined;
  const skillPrompt = resolveSkillPromptFromRegistry(deps.services, skillName);
  const staticSystemPrompt = buildStaticSystemPrompt(
    deps.env,
    skillPrompt,
    rulesSection,
    input.promptExtras ?? null,
  );

  const resolveSkill = (name: string): string | null =>
    resolveSkillPromptFromRegistry(deps.services, name);

  // ===== 2.5 图片预优化（发送前压缩；失败回退原图，绝不阻断请求）=====
  let optimizedImages: Map<string, OptimizedImage> | undefined;
  if (config.imageOptimization.enabled) {
    const optimizer = deps.getImageOptimizer?.();
    if (optimizer) {
      const paths = collectSessionImagePaths(session);
      if (paths.length > 0) {
        try {
          const results = await Promise.all(
            paths.map(p =>
              optimizer
                .optimizeImage(p)
                .then(r => [p, r] as const)
                .catch(() => [p, null] as const),
            ),
          );
          const map = new Map<string, OptimizedImage>();
          for (const [p, r] of results) if (r) map.set(p, r);
          if (map.size > 0) optimizedImages = map;
        } catch (err) {
          deps.logger.warn('context: image pre-optimization failed', {
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  const buildView = (budgetTokens?: number, budgetBytes?: number) =>
    buildRequestView(session, staticSystemPrompt, {
      includeThinking,
      resolveSkillPrompt: resolveSkill,
      budgetTokens,
      budgetBytes,
      imageEviction: { enabled: true, protectUnseen: true },
      maxTotalImageBytes: config.imageOptimization.maxTotalImageBytes,
      ...(ephemeralMessages ? { ephemeralMessages } : {}),
      ...(optimizedImages ? { optimizedImages } : {}),
    });

  // ===== 3. 预览估算 → token 压缩决策（字节超限不再触发 LLM 压缩） =====
  let compactionTriggered = false;
  let degradedReason: string | undefined;

  const preview = buildView();
  const byteBudget = config.maxRequestBytes;

  // 真实 usage/char 校准后的有效占用：估算器（字节启发式）在混合中文+代码场景会偏差 1.5~2x；
  // 未校准时回退 breakdown。阈值/压力/硬上限统一使用 effectiveTotal。
  const calibratedTotal = deps.estimateTokensForMessages?.(preview.messages);
  const effectiveTotal =
    calibratedTotal !== null && calibratedTotal !== undefined && calibratedTotal > 0
      ? calibratedTotal
      : preview.breakdown.total;
  // 估算器单位 → 真实 token 的换算比例（用于把窗口预算换算回 buildView 的估算单位）
  const estimatorScale =
    effectiveTotal > 0 && preview.breakdown.total > 0
      ? preview.breakdown.total / effectiveTotal
      : 1;

  // 上下文过半提醒（每轮注入、不持久化）：仅在压缩功能可用且近期没有失败时提醒。
  // 旧实现无条件注入：compaction.enabled=false 时模型被反复要求压缩，失败后形成复读。
  const recentFailure = deps.getCompactionFailure?.(session.id);
  const failureCooldownMs = config.compaction.cooldownMs;
  const suppressedByFailure =
    recentFailure !== undefined && Date.now() - recentFailure.at < failureCooldownMs;
  if (
    config.pressureReminder.enabled &&
    compactionActive(config.compaction, windowTokens) &&
    !suppressedByFailure &&
    windowTokens > 0
  ) {
    const usedRatio = effectiveTotal / windowTokens;
    if (usedRatio >= config.pressureReminder.ratio) {
      const reminder: ContextMessage = {
        role: 'user',
        name: CONTEXT_PRESSURE_MSG_NAME,
        content: buildContextPressureReminder(
          deps.env,
          effectiveTotal,
          windowTokens,
          usedRatio,
        ),
        timestamp: new Date().toISOString(),
      };
      ephemeralMessages = [...(ephemeralMessages ?? []), reminder];
      deps.logger.debug('context: pressure reminder injected', {
        sessionId: session.id,
        usedTokens: effectiveTotal,
        windowTokens,
        ratio: Number(usedRatio.toFixed(3)),
        calibrated: calibratedTotal != null,
      });
    }
  }
  // 图片 base64 对 token 估算不可见 → 字节维度独立判定，驱动最终视图的图片淘汰/字节兜底。
  const byteOverBudget = preview.bytes > byteBudget;

  // 仅当 token 估算达阈值才触发 LLM 压缩；字节超限由「图片压缩 + 图片淘汰 + 尾部裁剪 + router 护栏」解决。
  // 同时以「规划预检 + 冷却水位」防抖：徒劳/过频压缩在这里被拦下（不再空发 compaction-started）。
  if (
    compactionActive(config.compaction, windowTokens) &&
    shouldCompact(effectiveTotal, windowTokens, config.compaction.compactRatio)
  ) {
    const activeForPlan = session.messages.filter(m => !m.deletedAt && !m.compacted);
    const plan = planCompaction(
      activeForPlan,
      windowTokens,
      config.compaction.tailKeepRatio,
      config.compaction.minFoldTokens,
      config.compaction.minCompactMessages,
    );
    const guard = deps.getCompactionGuard?.(session.id);
    const withinCooldown = guard
      ? Date.now() - guard.at < config.compaction.cooldownMs &&
        preview.breakdown.total < guard.tokens + config.compaction.cooldownGrowthTokens
      : false;

    if (!plan.ok) {
      deps.logger.debug('context: auto compaction skipped (plan invalid)', {
        sessionId: session.id,
        reason: plan.reason,
      });
    } else if (withinCooldown) {
      deps.logger.debug('context: auto compaction skipped (cooldown)', { sessionId: session.id });
    } else {
      const llm = deps.getLlm();
      if (llm) {
        const { requestModel } = resolveSummaryModel(
          config.compaction.summaryModel,
          model,
          deps.getApiModels(),
        );
        deps.emitWs(session.id, {
          type: 'compaction-started',
          sessionId: session.id,
          payload: { sessionId: session.id, trigger: 'auto' },
        });
        try {
          const outcome = await compactSession(session, {
            env: deps.env,
            config: config.compaction,
            llm,
            logger: deps.logger,
            staticSystemPrompt,
            summaryModelId: requestModel,
            summaryModelConfigured: config.compaction.summaryModel,
            windowTokens,
            trigger: 'auto',
          });
          if (outcome.record) {
            compactionTriggered = true;
            deps.persistSession(session);
            deps.onCompaction(session.id, outcome.record);
            deps.setCompactionGuard?.(session.id, {
              at: Date.now(),
              tokens: outcome.record.afterTokens,
            });
            deps.emitWs(session.id, {
              type: 'compaction-completed',
              sessionId: session.id,
              payload: { sessionId: session.id, compaction: outcome.record },
            });
          } else if (outcome.reason) {
            // 区太小/摘要失败/收缩比不达标：不算降级（下轮再试），记录失败冷却防复读
            deps.logger.debug('context: auto compaction skipped', {
              sessionId: session.id,
              reason: outcome.reason,
            });
            deps.onCompactionFailure?.(session.id, outcome.reason);
          }
        } catch (err) {
          degradedReason = `compaction threw: ${err instanceof Error ? err.message : String(err)}`;
          deps.onDegraded(session.id, degradedReason);
          deps.onCompactionFailure?.(session.id, degradedReason);
        }
      } else {
        degradedReason = 'llm router unavailable for compaction';
        deps.onDegraded(session.id, degradedReason);
      }
    }
  }

  // ===== 4. 最终视图（溢出兜底：压缩后仍超窗 → 尾部裁剪；字节超限 → 同步启用字节预算）=====
  // buildView 内部按估算器单位记账：窗口预算需乘 estimatorScale 换算回估算单位，
  // 否则已校准的 effectiveTotal 与内部估算差异会让裁剪过早/过晚。
  const final = buildView(
    needsHardCeiling(effectiveTotal, windowTokens) || compactionTriggered
      ? Math.round(windowTokens * estimatorScale)
      : undefined,
    byteOverBudget ? byteBudget : undefined,
  );

  if (final.tailDropped > 0) {
    degradedReason = degradedReason ?? `hard ceiling: dropped ${final.tailDropped} head messages`;
    deps.onDegraded(session.id, `tail window dropped ${final.tailDropped} messages`);
  }
  // 字节兜底后仍超上限（锚定消息/单条巨消息本身过大）：显式降级（llm router 还有末位护栏兜底）
  if (final.bytes > byteBudget) {
    degradedReason = degradedReason ?? `request body ${final.bytes}B exceeds cap ${byteBudget}B`;
    deps.onDegraded(session.id, `request body over byte cap: ${final.bytes}/${byteBudget}`);
  }

  // ===== 4.5 图片「已看过」标记：把本轮真正内联发送的图片消息引用交给调用方 =====
  // 调用方在请求**成功送达后**调用 confirmImagesSent 落 imagesSentAt（此后该图视为「已看过」，
  // 在字节超预算时优先被淘汰为占位符）；请求失败则 discardImagesSent 丢弃 →
  // 下次仍会重新发送该图（保证模型至少看过一次）。
  return {
    messages: final.messages,
    // 对外报告真实口径（估算器单位 / 换算比例），与面板/压力阈值同源
    estimatedTokens: Math.round(final.breakdown.total / (estimatorScale > 0 ? estimatorScale : 1)),
    windowTokens,
    compactionTriggered,
    breakdown: final.breakdown,
    ...(final.imageMessagesToMark.length > 0
      ? { imageMessagesToMark: final.imageMessagesToMark }
      : {}),
    ...(degradedReason ? { degradedReason } : {}),
  };
}

/**
 * 手动压缩（空闲时）：复用 compactSession，focus 为用户附加焦点。
 */
export async function manualCompact(
  deps: GovernorDeps,
  input: PrepareRequestInput & { focus?: string },
): Promise<{ record: CompactionRecord | null; reason?: string }> {
  const config = deps.getConfig();
  const llm = deps.getLlm();
  if (!llm) return { record: null, reason: 'llm router unavailable' };

  const { requestModel } = resolveSummaryModel(
    config.compaction.summaryModel,
    input.model,
    deps.getApiModels(),
  );

  // 静态系统提示（cache-aligned 摘要前缀；含 always 用户规则段）
  const skillName = input.session.activeSkill?.mode === 'system' ? input.session.activeSkill.name : undefined;
  const staticSystemPrompt = buildStaticSystemPrompt(
    deps.env,
    resolveSkillPromptFromRegistry(deps.services, skillName),
    buildRulesSectionForRequest(deps, config, input.session.id, input.cwd),
  );

  deps.emitWs(input.session.id, {
    type: 'compaction-started',
    sessionId: input.session.id,
    payload: { sessionId: input.session.id, trigger: 'manual' },
  });

  const outcome = await compactSession(input.session, {
    env: deps.env,
    config: config.compaction,
    llm,
    logger: deps.logger,
    staticSystemPrompt,
    summaryModelId: requestModel,
    summaryModelConfigured: config.compaction.summaryModel,
    windowTokens: input.windowTokens,
    trigger: 'manual',
    ...(input.focus ? { focus: input.focus } : {}),
  });

  if (outcome.record) {
    deps.persistSession(input.session);
    deps.onCompaction(input.session.id, outcome.record);
    deps.emitWs(input.session.id, {
      type: 'compaction-completed',
      sessionId: input.session.id,
      payload: { sessionId: input.session.id, compaction: outcome.record },
    });
  }
  return outcome;
}

/**
 * 手动压缩预览（确认对话框数据）：估算可压缩区与保留尾部。
 */
export function previewCompact(
  deps: GovernorDeps,
  session: ContextSessionLike,
  windowTokens: number,
): {
  compactableCount: number;
  compactableTokens: number;
  tailKeepCount: number;
  estimatedAfterTokens: number;
} {
  const config = deps.getConfig();
  const active = session.messages.filter(m => !m.deletedAt && !m.compacted);
  // 与 planner 同口径的快速估算：尾部预算之外即视为可压缩区
  let head = 0;
  if (active.length > 0 && active[0].name === 'env-context') head = 1;

  const tailBudget = Math.max(1, Math.floor(windowTokens * config.compaction.tailKeepRatio));
  let start = active.length;
  let acc = 0;
  for (let i = active.length - 1; i > head; i--) {
    const t = estimateTextTokens(active[i].content) + 4;
    if (active.length - i > 2 && acc + t > tailBudget) break;
    acc += t;
    start = i;
  }
  while (start > head && start < active.length && active[start].role === 'tool') start--;

  const region = active.slice(head, start);
  const compactableTokens = estimateMessagesTokens(region);
  const envTokens = head > 0 ? estimateMessagesTokens(active.slice(0, head)) : 0;
  const tailTokens = estimateMessagesTokens(active.slice(start));
  return {
    compactableCount: region.length,
    compactableTokens,
    tailKeepCount: active.length - start,
    estimatedAfterTokens: envTokens + tailTokens + config.compaction.summaryMaxTokens,
  };
}
