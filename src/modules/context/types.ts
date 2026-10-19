// src/modules/context/types.ts
// 上下文引擎类型契约：配置、会话快照、压缩记录、自愈结果、统计遥测。
// 本文件不 import agent/contracts（避免模块循环）：ContextSessionLike 为
// agent/session Session 的结构子集（鸭子类型注入）。

import type { UnifiedMessage } from '../llm/types';
import type { FileIndexConfig } from './file-index/types';
import { DEFAULT_FILE_INDEX_CONFIG } from './file-index/types';

// ============================================================================
// 配置（config.context，由 config-service Zod schema 校验，此处为运行时类型）
// ============================================================================

export interface CompactionConfig {
  /** 是否启用自动压缩 */
  enabled: boolean;
  /** 触发阈值：估算 token ≥ 窗口 × compactRatio 时压缩 */
  compactRatio: number;
  /** 尾部逐字保留比例（占窗口） */
  tailKeepRatio: number;
  /** 摘要输出上限 token */
  summaryMaxTokens: number;
  /** 可压缩区最小 token（低于此值不值得一次摘要调用） */
  minFoldTokens: number;
  /** 摘要模型：'inherit' = 主模型；否则为 providers 旗下模型 id */
  summaryModel: string;
  /**
   * 收缩比上限（DSH shrink check 等价）：摘要 token 必须 ≤ 可压缩区 token × 本值，
   * 否则放弃本轮压缩（拒绝“摘要≈原文”的空转，防止越压越傻）。
   */
  maxShrinkRatio: number;
  /** 可压缩区最少消息数（低于此值跳过压缩） */
  minCompactMessages: number;
  /**
   * 压缩冷却水位（token）：距离上次自动压缩不足 cooldownMs 且当前估算相较
   * 上次压缩后增长未超过本值时，跳过本次自动压缩（防止反复徒劳压缩）。
   */
  cooldownGrowthTokens: number;
  /** 压缩冷却时间窗 ms（配合 cooldownGrowthTokens 生效） */
  cooldownMs: number;
}

/** 图片发送前优化配置（TinyPNG 式压缩；减少请求体字节同时保留细节） */
export interface ImageOptimizationConfig {
  /** 是否启用发送前图片优化（关闭则原样发送原图） */
  enabled: boolean;
  /** 长边最大像素（超出则等比缩小；仅缩不放） */
  maxEdgePx: number;
  /** 有损编码质量（palette/JPEG/WebP 量化用；1-100） */
  quality: number;
  /** 输出格式：auto=按原格式择优选小，或强制 png/jpeg/webp */
  format: 'auto' | 'png' | 'jpeg' | 'webp';
  /** 是否使用无损编码（true=仅重新压缩不量化；false=TinyPNG 式量化） */
  lossless: boolean;
  /** 单张图片内联字节上限（超出则继续压缩/降级；0=不限制） */
  maxInlineBytesPerImage: number;
  /** 小于该字节数的图片跳过优化（优化无收益） */
  skipBelowBytes: number;
  /** 所有图片内联字节总量上限（引导 governor 提前淘汰；0=不限制） */
  maxTotalImageBytes: number;
}

/** 思考内容回传配置（计入估算对所有 provider 一律生效，回传按 provider 语义） */
export interface ThinkingReplayConfig {
  /**
   * OpenAI 兼容（含 DeepSeek）是否把历史 reasoning_content 回传给模型。
   * 默认 false —— DeepSeek 官方规范：多轮回写 assistant 消息只需 content，
   * 不应传入 reasoning_content。仅在自建代理确实接受时才开启。
   */
  replayOpenAICompat: boolean;
}

/** 上下文过半提醒配置（每轮注入、不持久化；占用 ≥ ratio 时提醒 AI 交接并自主压缩） */
export interface ContextPressureConfig {
  /** 是否启用（默认开） */
  enabled: boolean;
  /** 触发阈值：占用估算 ≥ 窗口 × ratio 时注入提醒（默认 0.5） */
  ratio: number;
}

export interface ToolPruningConfig {
  enabled: boolean;
  /** 工具结果超过此字符数触发中段修剪（仅发送视图，session 原文不动） */
  thresholdChars: number;
  keepHeadChars: number;
  keepTailChars: number;
}

export interface HealerConfig {
  enabled: boolean;
  /** 工具名模糊纠正（编辑距离） */
  toolNameFuzzy: boolean;
  /** 参数 schema 校验 + 自动类型修正 */
  schemaFix: boolean;
}

export interface ContextTelemetryConfig {
  enabled: boolean;
}

/** 规则引擎配置（rules 模块消费） */
export interface RulesConfig {
  enabled: boolean;
  /** always 规则段 token 预算（超出告警遥测） */
  maxAlwaysTokens: number;
  /** 单会话 paths 规则注入上限 */
  maxInjectPerSession: number;
}

/** 钩子引擎配置（hooks 模块消费） */
export interface HooksConfig {
  enabled: boolean;
  /** 默认执行超时 ms */
  defaultTimeout: number;
}

/** 记忆引擎配置（memory 模块消费） */
export interface MemoryConfig {
  enabled: boolean;
  /** 蒸馏模型：'inherit' = 主模型；否则为 providers 旗下模型 id */
  distillModel: string;
  /** 触发蒸馏的最小新增消息数 */
  distillMinMessages: number;
  /** L2/L3 召回条数 */
  recallTopK: number;
  /** 记忆段 token 预算 */
  recallTokenBudget: number;
  /** L1 关键事实重要性阈值 */
  l1ImportanceThreshold: number;
  /** L1 常驻条数上限 */
  l1MaxEntries: number;
}

export interface ContextEngineConfig {
  compaction: CompactionConfig;
  toolPruning: ToolPruningConfig;
  healer: HealerConfig;
  telemetry: ContextTelemetryConfig;
  /** 文件索引模块（三引擎，默认全关） */
  fileIndex: FileIndexConfig;
  /** 用户规则引擎（默认开） */
  rules: RulesConfig;
  /** 生命周期钩子引擎（默认开） */
  hooks: HooksConfig;
  /** 记忆引擎（默认开） */
  memory: MemoryConfig;
  /** 图片发送前优化（默认开；sharp 不可用时自动降级为不压缩） */
  imageOptimization: ImageOptimizationConfig;
  /** 思考内容回传（默认严格按 provider 语义；OpenAI 兼容默认不回传） */
  thinking: ThinkingReplayConfig;
  /** 上下文过半提醒（默认开；每轮注入、不持久化） */
  pressureReminder: ContextPressureConfig;
  /**
   * 单次 LLM 请求体字节上限（序列化后的 JSON body）。
   * 用途：token 预算看不到图片 base64 字节，服务端却按字节判 413；
   * 该值既是压缩/兜底裁剪的字节预算，也是 llm router 发送前的硬护栏。
   * 默认 8 MiB（1M token 的纯文本约 3–4 MB，小于该值 → 不牺牲纯文本上下文）。
   */
  maxRequestBytes: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  compactRatio: 0.80,
  tailKeepRatio: 0.16,
  summaryMaxTokens: 8192,
  minFoldTokens: 400,
  summaryModel: 'inherit',
  maxShrinkRatio: 0.5,
  minCompactMessages: 4,
  cooldownGrowthTokens: 2000,
  cooldownMs: 60000,
};

export const DEFAULT_IMAGE_OPTIMIZATION_CONFIG: ImageOptimizationConfig = {
  enabled: true,
  maxEdgePx: 1568,
  quality: 82,
  format: 'auto',
  lossless: false,
  maxInlineBytesPerImage: 1024 * 1024,
  skipBelowBytes: 64 * 1024,
  maxTotalImageBytes: 4 * 1024 * 1024,
};

export const DEFAULT_THINKING_REPLAY_CONFIG: ThinkingReplayConfig = {
  replayOpenAICompat: false,
};

export const DEFAULT_CONTEXT_PRESSURE_CONFIG: ContextPressureConfig = {
  enabled: true,
  ratio: 0.5,
};

export const DEFAULT_TOOL_PRUNING_CONFIG: ToolPruningConfig = {
  enabled: true,
  thresholdChars: 8192,
  keepHeadChars: 4096,
  keepTailChars: 1024,
};

export const DEFAULT_HEALER_CONFIG: HealerConfig = {
  enabled: true,
  toolNameFuzzy: true,
  schemaFix: true,
};

export const DEFAULT_CONTEXT_TELEMETRY_CONFIG: ContextTelemetryConfig = {
  enabled: true,
};

export const DEFAULT_RULES_CONFIG: RulesConfig = {
  enabled: true,
  maxAlwaysTokens: 4000,
  maxInjectPerSession: 20,
};

export const DEFAULT_HOOKS_CONFIG: HooksConfig = {
  enabled: true,
  defaultTimeout: 10000,
};

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  distillModel: 'inherit',
  distillMinMessages: 6,
  recallTopK: 5,
  recallTokenBudget: 2000,
  l1ImportanceThreshold: 0.75,
  l1MaxEntries: 20,
};

/** 请求体字节上限默认值（8 MiB）与下限（256 KiB；router 兜底降级时不会低于此值） */
export const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const MIN_MAX_REQUEST_BYTES = 256 * 1024;

export const DEFAULT_CONTEXT_CONFIG: ContextEngineConfig = {
  compaction: { ...DEFAULT_COMPACTION_CONFIG },
  toolPruning: { ...DEFAULT_TOOL_PRUNING_CONFIG },
  healer: { ...DEFAULT_HEALER_CONFIG },
  telemetry: { ...DEFAULT_CONTEXT_TELEMETRY_CONFIG },
  fileIndex: { ...DEFAULT_FILE_INDEX_CONFIG },
  rules: { ...DEFAULT_RULES_CONFIG },
  hooks: { ...DEFAULT_HOOKS_CONFIG },
  memory: { ...DEFAULT_MEMORY_CONFIG },
  imageOptimization: { ...DEFAULT_IMAGE_OPTIMIZATION_CONFIG },
  thinking: { ...DEFAULT_THINKING_REPLAY_CONFIG },
  pressureReminder: { ...DEFAULT_CONTEXT_PRESSURE_CONFIG },
  maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
};

// ============================================================================
// 会话快照（结构兼容 agent/session 的 Session / AgentMessage）
// ============================================================================

/**
 * 引擎可见的消息结构（AgentMessage 的结构子集 + compacted 标记）。
 * agent 模块的 AgentMessage 含 todoSnapshot 等额外字段，结构兼容可直接传入。
 */
export interface ContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 用户消息附带的附件绝对路径（role=user；view-builder 据此读盘编码图片） */
  attachments?: string[];
  /** 工具结果附带的图片绝对路径（role=tool；view-builder 据此读盘编码图片） */
  images?: string[];
  /**
   * 图片「已发送过」的时间（ISO 8601）。非空表示该消息的图片已在先前的请求中以
   * base64 发送过 → 本次构建视图时只留占位符（附原始路径），不再读盘内联。
   * 用途：避免历史图片 base64 每轮重发撑爆请求体（413）。由 governor 在构建最终视图后写入。
   */
  imagesSentAt?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    /** JSON 字符串 */
    arguments: string;
  }>;
  toolCallId?: string;
  thinking?: string;
  /** 思考签名（Anthropic thinking block 的 signature；回传时必须原样携带） */
  thinkingSignature?: string;
  name?: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
  timestamp?: string;
  /** 软删除标记（消息撤回）：发送视图过滤 */
  deletedAt?: string;
  /** 压缩标记：已被压缩摘要替代。发送视图排除（原文保留供前端历史展示） */
  compacted?: boolean;
}

/** 环境上下文锚定信息（会话创建时生成，append-only 保证前缀稳定） */
export interface EnvContextInfo {
  /** 生成时间 ISO 8601 */
  createdAt: string;
  /** 快照日期 YYYY-MM-DD（跨天检测依据） */
  date: string;
}

/** 压缩历史记录（持久化于 session.compactions） */
export interface CompactionRecord {
  id: string;
  at: string;
  trigger: 'auto' | 'manual';
  /** 压缩前估算 token */
  beforeTokens: number;
  /** 压缩后估算 token（含摘要消息） */
  afterTokens: number;
  /** 被压缩的消息条数 */
  compactedCount: number;
  /** 物理折叠的消息条数（新实现 = compactedCount；旧记录仅标记未折叠时缺省） */
  foldedMessageCount?: number;
  /** 摘要全文（不含 <compaction-summary> 标签） */
  summary: string;
  /** 被压缩区间末条消息 timestamp（前端卡片定位） */
  boundaryTimestamp?: string;
  /** 摘要使用的模型（id 或 model 名） */
  summaryModel: string;
  /** 摘要生成耗时 ms */
  durationMs: number;
}

/** 引擎可见的会话结构（agent Session 的结构子集；鸭子类型注入避免循环依赖） */
export interface ContextSessionLike {
  id: string;
  messages: ContextMessage[];
  envContext?: EnvContextInfo;
  compactions?: CompactionRecord[];
  /** 会话级持久化遥测（真实 usage + 命中样本；随 session 落盘，重启恢复） */
  contextTelemetry?: SessionContextTelemetry;
  /** 会话级活跃 skill（system 模式拼系统提示后；message 模式替换 skill-inject 占位） */
  activeSkill?: { name: string; mode: 'system' | 'message' };
  /** 规则引擎注入状态（paths 规则去重水位；随 session 落盘） */
  rulesState?: SessionRulesState;
  /** 记忆引擎状态（L1 注入标记 / 召回去重 / 蒸馏水位；随 session 落盘） */
  memoryState?: SessionMemoryState;
  updatedAt: string;
}

/** 规则引擎会话状态（agent Session 内嵌可选字段） */
export interface SessionRulesState {
  /** 已通过 paths 触发注入的规则 id 集合 */
  injectedRuleIds: string[];
}

/** 记忆引擎会话状态（agent Session 内嵌可选字段） */
export interface SessionMemoryState {
  /** L1 关键事实锚定消息注入时间（每会话一次） */
  l1InjectedAt?: string;
  /** 当前召回 query 键（最近 user 消息前 200 字符；切换即重置召回状态） */
  lastRecallQuery?: string;
  /** 上一条消息召回的记忆 id（当前检索的排除集，防连续消息重复注入） */
  excludeFromRecall: string[];
  /** 本条消息已召回的记忆 id（消息切换时转为排除集；同消息多轮间保持稳定注入） */
  currentRecalled: string[];
  /** 上次蒸馏到的消息水位（数组长度；新增消息从此处开始） */
  lastDistilledIndex: number;
}

/** 会话级持久化遥测（agent Session 内嵌字段；lastUsage/cacheHits 的单一真源） */
export interface SessionContextTelemetry {
  /** 最近一次请求的真实 usage（LLM 上报；无样本为 null） */
  lastUsage: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
  } | null;
  /** 缓存命中样本环形缓冲（上限 TELEMETRY_BUFFER_SIZE） */
  cacheHits: CacheHitSample[];
}

/** agent 模块注入的会话存取回调（bind 注入，保持依赖方向 agent → context） */
export interface SessionStoreBridge {
  get(sessionId: string): ContextSessionLike | null;
  persist(session: ContextSessionLike): void;
}

// ============================================================================
// 请求准备（governor 流水线输出）
// ============================================================================

/** token 构成分解 */
export interface ContextBreakdown {
  /** 系统提示词（含 skill system 模式注入） */
  system: number;
  /** 环境上下文消息 */
  env: number;
  /** 活跃压缩摘要 */
  summary: number;
  /** 历史消息（未压缩 + 工具结果修剪后） */
  history: number;
  /** paths 规则注入消息（active-rules 锚定） */
  rules: number;
  /** 记忆召回消息（memory-l1 锚定 + memory-recall 临时） */
  memory: number;
  total: number;
}

export interface PreparedRequest {
  /** 最终发送给 LLM 的消息（含 system 首条） */
  messages: UnifiedMessage[];
  estimatedTokens: number;
  /** 上下文窗口 token */
  windowTokens: number;
  /** 本轮是否触发了压缩 */
  compactionTriggered: boolean;
  breakdown: ContextBreakdown;
  /** 降级说明（fallback 触发原因；正常为 null） */
  degradedReason?: string;
  /**
   * 本轮「实际内联发送了图片」的原始 session 消息引用（有图时才有值）。
   * 调用方须在请求**成功送达后**调用 confirmImagesSent 落 imagesSentAt；
   * 请求失败则调用 discardImagesSent 丢弃——保证「图片只发一次」不会在失败时误标记。
   */
  imageMessagesToMark?: ContextMessage[];
}

// ============================================================================
// 自愈（healer）
// ============================================================================

export interface HealLogEntry {
  kind: 'args-repair' | 'tool-name' | 'schema-fix' | 'template-fallback';
  detail: string;
}

export interface HealResult {
  /** 修复后的工具名（可能被模糊纠正） */
  toolName: string;
  /** 修复后的参数 */
  args: unknown;
  /** 修复日志（空 = 无需修复；非空时合并进 tool result 供模型感知） */
  healLog: HealLogEntry[];
  /** 是否可执行（false = 修复失败，用 errorText 回传让模型自纠） */
  executable: boolean;
  /** executable=false 时可直接作为 tool result 的结构化错误文本 */
  errorText?: string;
  /** 候选工具名（纠正失败时供错误信息使用） */
  candidates?: string[];
}

// ============================================================================
// 统计与遥测
// ============================================================================

export interface CacheHitSample {
  at: string;
  promptTokens: number;
  cachedTokens: number;
  /** cached/prompt 比率（prompt=0 时为 0） */
  hitRate: number;
}

/** 系统上下文构成（前端「系统」标签页折叠栏数据源） */
export interface SystemSection {
  /** 'identity' | 'rules' | 'skill' | 'env' | 'summary' */
  id: string;
  title: string;
  tokens: number;
  content: string;
  defaultOpen?: boolean;
}

export interface ContextStats {
  sessionId: string;
  /** 当前会话模型（模型与配置摘要行数据源） */
  model: { id: string; name: string };
  breakdown: ContextBreakdown;
  windowTokens: number;
  /** 本轮发送估算 token 占窗口百分比 */
  usedPercent: number;
  /** 最近一次请求的真实 usage（LLM 上报；无样本为 null；前端实时指标栏数据源） */
  lastUsage: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
  } | null;
  compaction: {
    enabled: boolean;
    compactRatio: number;
    /** 已压缩消息条数 */
    compactedMessages: number;
    /** 活跃摘要 token */
    activeSummaryTokens: number;
    lastCompaction?: CompactionRecord;
  };
  cacheHits: CacheHitSample[];
  /** 近样本平均命中率（无样本为 null） */
  avgHitRate: number | null;
  systemSections: SystemSection[];
}

/** 遥测环形缓冲容量（每 session 保留最近样本数） */
export const TELEMETRY_BUFFER_SIZE = 50;

// ============================================================================
// WS 事件 payload（api/events 推送）
// context-stats-updated 的 payload 直接使用完整 ContextStats（见 getStats）
// ============================================================================

export interface CompactionEventPayload {
  sessionId: string;
  compaction: CompactionRecord;
}

export interface CompactionStartedEventPayload {
  sessionId: string;
  trigger: 'auto' | 'manual';
}

export interface HealedEventPayload {
  sessionId: string;
  toolCallId: string;
  healLog: HealLogEntry[];
}

export interface ContextDegradedEventPayload {
  sessionId: string;
  reason: string;
}

// ============================================================================
// 手动压缩结果
// ============================================================================

export interface ManualCompactResult {
  ok: boolean;
  /** ok=false 的原因（会话不存在/运行中/区太小/摘要失败） */
  reason?: string;
  compaction?: CompactionRecord;
}

/** 手动压缩预览（确认对话框数据源） */
export interface CompactPreview {
  sessionId: string;
  /** 将被压缩的消息条数 */
  compactableCount: number;
  /** 可压缩区估算 token */
  compactableTokens: number;
  /** 尾部将保留的消息条数 */
  tailKeepCount: number;
  /** 预计压缩后总 token（摘要按 summaryMaxTokens 上限估） */
  estimatedAfterTokens: number;
}
