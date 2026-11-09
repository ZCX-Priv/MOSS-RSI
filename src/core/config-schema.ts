// src/core/config-schema.ts
// 配置 zod schema 的独立模块（只在需要校验时动态 import）。
//
// 为什么独立：zod v4 打包后约 729KB，若被 config-service 静态 import，会进入
// 启动静态闭包，在 0.8GHz 单核机器上是数百毫秒到秒级的解析/求值成本。
// config-service 启动期走「快速默认值合并」路径，本模块只在配置文件变更、
// 后台校验、PATCH 写入时按需加载。

import { z } from 'zod';
import { toolConfigEntries } from '../modules/tools/manifest';
import type { ToolConfigManifest } from '../modules/tools/types';

/** zod v4 的 ZodRawShape 是只读映射，内部构建/校验用可写别名 */
type ZodShape = Record<string, z.ZodTypeAny>;

// ============================================================================
// 工具配置 schema（从 tool.json 的 config 段构建）
// ============================================================================

/**
 * 从 tool.json 的 config 段构建 zod shape。
 * - enabled 字段自动注入 boolean（所有工具都有）
 * - 其他字段从 config.schema 获取约束，或从 defaults 值类型推断
 * - 所有字段带 .default(默认值)：旧 config.json 缺新增字段时自动补全
 */
export function buildConfigShape(config: ToolConfigManifest): ZodShape {
  const shape: ZodShape = {};
  shape.enabled = z.boolean().default(true);
  for (const [key, val] of Object.entries(config.defaults)) {
    if (key === 'enabled') continue;
    const fieldSchema = config.schema?.[key];
    if (fieldSchema) {
      shape[key] = buildZodField(fieldSchema).default(val);
    } else {
      shape[key] = inferZodFromValue(val).default(val);
    }
  }
  // 通用行为字段：未在工具 config 中声明时也注入 optional，避免 PATCH 写入被 strip
  if (!('requireConfirmation' in shape)) {
    shape.requireConfirmation = z.boolean().optional();
  }
  return shape;
}

function buildZodField(field: { type: string; min?: number; max?: number }): z.ZodTypeAny {
  switch (field.type) {
    case 'boolean':
      return z.boolean();
    case 'integer': {
      let s = z.number().int();
      if (field.min !== undefined) s = s.min(field.min);
      if (field.max !== undefined) s = s.max(field.max);
      return s;
    }
    case 'string':
      return z.string();
    default:
      return z.unknown();
  }
}

function inferZodFromValue(val: unknown): z.ZodTypeAny {
  if (typeof val === 'boolean') return z.boolean();
  if (typeof val === 'number') return z.number();
  if (typeof val === 'string') return z.string();
  return z.unknown();
}

/**
 * 校验工具 config 补丁（PATCH /api/tools/:name 的 config 字段用）。
 * 字段 key 必须在 shape 声明集合内，未知字段报错；值类型用对应 zod 字段校验。
 */
export function validateToolConfigPatch(
  shape: ZodShape,
  patch: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'requireConfirmation' && !(key in shape)) {
      if (typeof value !== 'boolean') {
        return { ok: false, error: 'Invalid value for field "requireConfirmation": expected boolean' };
      }
      continue;
    }
    const field = shape[key];
    if (!field) {
      return { ok: false, error: `Unknown config field "${key}"` };
    }
    const r = field.safeParse(value);
    if (!r.success) {
      const issue = r.error.issues[0];
      return { ok: false, error: `Invalid value for field "${key}": ${issue?.message ?? 'invalid'}` };
    }
  }
  return { ok: true };
}

/** 构建 tools Zod schema（每个工具字段 .default() + passthrough 允许多余字段） */
export function buildToolsSchema() {
  const shape: ZodShape = {};
  for (const { name, config } of toolConfigEntries()) {
    if (!config) {
      shape[name] = z.unknown().optional();
      continue;
    }
    const spec = z.object(buildConfigShape(config));
    shape[name] = spec.default({ ...config.defaults });
  }
  return z.object(shape).passthrough();
}

// ============================================================================
// 应用配置 schema
// ============================================================================

const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'fatal']);

const thinkingLevelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  effort: z.string().min(1),
});

const providerThinkingSchema = z.object({
  enabled: z.boolean(),
  effort: z.string().optional(),
  label: z.string().optional(),
  budgetTokens: z.number().int().positive().optional(),
});

const providerModelConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  model: z.string(),
  thinking: providerThinkingSchema,
  contextWindow: z.string().optional(),
  inputTokens: z.number().int().positive().optional(),
  outputTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().min(0).max(100).optional(),
  thinkingLevels: z.array(thinkingLevelSchema).optional(),
});

const providerServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.literal('file-storage'),
  endpoint: z.string(),
  apiKey: z.string(),
  maxQuota: z.number().positive().optional(),
  quotaUnit: z.enum(['MB', 'GB', 'TB']).optional(),
});

const providerConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    /** 服务商类型：model（默认/缺省）= 模型服务商；voice = 语音服务商 */
    kind: z.enum(['model', 'voice']).optional(),
    format: z.enum(['openai-chat', 'openai-responses', 'anthropic', 'gemini', 'voice']),
    /** 语音引擎类型（kind='voice' 时必填）：openai-transcriptions（OpenAI 兼容整段转写） */
    voiceEngine: z.enum(['openai-transcriptions']).optional(),
    /** 语音模型名（kind='voice' 时使用，如 'whisper-1'） */
    voiceModel: z.string().optional(),
    endpoint: z.string(),
    apiKey: z.string(),
    balanceUrl: z.string().optional(),
    modelsUrl: z.string().optional(),
    icon: z.string().optional(),
    services: z.array(providerServiceSchema).optional(),
    models: z.array(providerModelConfigSchema).default([]),
  })
  .superRefine((p, ctx) => {
    if (p.kind === 'voice') {
      if (!p.voiceEngine) {
        ctx.addIssue({
          code: 'custom',
          message: "voice provider requires 'voiceEngine' (openai-transcriptions)",
        });
      }
      if (p.format !== 'voice') {
        ctx.addIssue({
          code: 'custom',
          message: "voice provider format must be 'voice'",
        });
      }
      if (p.models.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'voice provider must not carry models',
        });
      }
    } else if (p.voiceEngine !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: "voiceEngine is only allowed on kind='voice' providers",
      });
    }
  });

const fileHistorySchema = z.object({
  enabled: z.boolean(),
  maxBackupsPerFile: z.number().int().min(1).max(100),
  transcriptEnabled: z.boolean(),
  backupRetentionDays: z.number().int().min(0).max(365),
});

// filesys：内层字段全部 .default() —— 旧 config.json 缺失时自动补全而非整体校验失败
const filesysSchema = z.object({
  roots: z.array(z.string()).default([]),
  cacheMaxBytes: z.number().int().positive().default(64 * 1024 * 1024),
  cacheMaxEntries: z.number().int().positive().default(2048),
  cacheMaxFileBytes: z.number().int().positive().default(4 * 1024 * 1024),
  terminalWatch: z
    .object({
      enabled: z.boolean().default(true),
      maxFiles: z.number().int().positive().default(4000),
      timeoutMs: z.number().int().positive().default(3000),
      totalTimeoutMs: z.number().int().positive().default(600),
    })
    .prefault({}),
});

// safety：统一权限决策配置（内层全 .default() 自愈，旧 config.json 缺字段自动补全）
const safetySchema = z.object({
  defaultMode: z.enum(['ask', 'auto', 'skip']).default('ask'),
  confirmTimeoutMinutes: z.number().int().min(0).max(1440).default(5),
  blockDangerousCommands: z.boolean().default(true),
  cautionPolicy: z.enum(['ask', 'deny']).default('ask'),
  rules: z
    .object({
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
      ask: z.array(z.string()).default([]),
    })
    .prefault({}),
  protectedPaths: z.array(z.string()).default(['~/.ssh', '~/.gnupg', '~/.aws']),
  // 自动审查（auto 档的第二模型审查）：内层全默认自愈
  review: z
    .object({
      enabled: z.boolean().default(true),
      model: z.string().default(''),
      reasoningEffort: z.enum(['off', 'low', 'max']).default('off'),
      timeoutMs: z.number().int().min(1000).max(300000).default(30000),
      onReviewFailure: z.enum(['ask', 'deny']).default('ask'),
      cacheTtlMs: z.number().int().min(0).max(3600000).default(60000),
      maxIntentChars: z.number().int().min(200).max(20000).default(4000),
    })
    .prefault({}),
});

// logs：日志系统配置（内层全 .default() 自愈；外层 .prefault({}) 使旧 config.json 缺段自动补全）
const logsSchema = z.object({
  level: logLevelSchema.default('info'),
  retentionDays: z.number().int().min(1).max(365).default(14),
  maxFileMb: z.number().min(1).max(100).default(10),
});

// context：上下文引擎配置（压缩/自愈/遥测）
const contextSchema = z.object({
  compaction: z
    .object({
      enabled: z.boolean().default(true),
      compactRatio: z.number().min(0.5).max(0.95).default(0.80),
      tailKeepRatio: z.number().min(0.05).max(0.5).default(0.16),
      summaryMaxTokens: z.number().int().positive().default(8192),
      minFoldTokens: z.number().int().positive().default(400),
      summaryModel: z.string().default('inherit'),
      maxShrinkRatio: z.number().min(0.1).max(0.95).default(0.5),
      minCompactMessages: z.number().int().min(2).max(100).default(4),
      cooldownGrowthTokens: z.number().int().min(0).default(2000),
      cooldownMs: z.number().int().min(0).default(60000),
    })
    .prefault({}),
  healer: z
    .object({
      enabled: z.boolean().default(true),
      toolNameFuzzy: z.boolean().default(true),
      schemaFix: z.boolean().default(true),
    })
    .prefault({}),
  telemetry: z
    .object({
      enabled: z.boolean().default(true),
    })
    .prefault({}),
  rules: z
    .object({
      enabled: z.boolean().default(true),
      maxAlwaysTokens: z.number().int().positive().default(4000),
      maxInjectPerSession: z.number().int().positive().min(1).max(100).default(20),
    })
    .prefault({}),
  hooks: z
    .object({
      enabled: z.boolean().default(true),
      defaultTimeout: z.number().int().positive().default(10000),
    })
    .prefault({}),
  memory: z
    .object({
      enabled: z.boolean().default(true),
      distillModel: z.string().default('inherit'),
      distillMinMessages: z.number().int().min(1).max(100).default(6),
      recallTopK: z.number().int().min(1).max(50).default(5),
      recallTokenBudget: z.number().int().positive().default(2000),
      l1ImportanceThreshold: z.number().min(0).max(1).default(0.75),
      l1MaxEntries: z.number().int().min(1).max(100).default(20),
      recallInsightWeight: z.number().min(0).max(10).default(2.0),
      recallTagWeight: z.number().min(0).max(10).default(1.5),
      recallVerbatimWeight: z.number().min(0).max(10).default(1.0),
      recallRecencyHalfLifeDays: z.number().min(1).max(3650).default(30),
      recallPinnedBoost: z.number().min(1).max(10).default(1.15),
      recallDedupThreshold: z.number().min(0).max(1).default(0.8),
      recallMinScoreRatio: z.number().min(0).max(1).default(0.25),
      recallMaxPerRoom: z.number().int().min(0).max(100).default(0),
    })
    .prefault({}),
  imageOptimization: z
    .object({
      enabled: z.boolean().default(true),
      maxEdgePx: z.number().int().min(256).max(8192).default(1568),
      quality: z.number().int().min(1).max(100).default(82),
      format: z.enum(['auto', 'png', 'jpeg', 'webp']).default('auto'),
      lossless: z.boolean().default(false),
      maxInlineBytesPerImage: z.number().int().min(0).default(1024 * 1024),
      skipBelowBytes: z.number().int().min(0).default(64 * 1024),
      maxTotalImageBytes: z.number().int().min(0).default(4 * 1024 * 1024),
    })
    .prefault({}),
  thinking: z
    .object({
      replayOpenAICompat: z.boolean().default(false),
    })
    .prefault({}),
  pressureReminder: z
    .object({
      enabled: z.boolean().default(true),
      ratio: z.number().min(0.1).max(0.95).default(0.5),
    })
    .prefault({}),
  maxRequestBytes: z
    .number()
    .int()
    .min(262144)
    .max(67108864)
    .default(8 * 1024 * 1024),
});

/** 代码模式（PTC + Intelligent UI）配置 */
const codeModeSchema = z.object({
  enabled: z.boolean().default(true),
  uiEnabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  maxCodeChars: z.number().int().min(1_000).max(200_000).default(20_000),
  maxParallelSubCalls: z.number().int().min(1).max(32).default(10),
});

export const appConfigSchema = z.object({
  version: z.number().int().positive(),
  server: z.object({
    host: z.string(),
    port: z.number().int().min(1).max(65535),
    autoPort: z.boolean(),
    locale: z.string().optional(),
  }),
  daemon: z.object({
    enabled: z.boolean(),
  }),
  /** 电源策略：preventSleep=true 阻止系统睡眠（缺省关闭；旧配置缺此段时按默认值补齐） */
  power: z
    .object({
      preventSleep: z.boolean().default(false),
    })
    .prefault({}),
  logs: logsSchema.prefault({}),
  update: z.object({
    autoCheck: z.boolean(),
    channel: z.enum(['stable', 'beta']),
    checkIntervalHours: z.number().int().min(1),
  }),
  agent: z.object({
    defaultModel: z.string(),
    maxTokens: z.number().int().positive(),
    maxTurns: z.number().int().min(0),
    llmStreamIdleTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional(),
    workingDirectory: z.string(),
    /** 同轮只读工具最大并行数（1 = 串行；缺省 4） */
    maxParallelTools: z.number().int().min(1).max(8).default(4),
    /** 同时运行的 agent run 上限（缺省按内存自适应） */
    maxConcurrentRuns: z.number().int().min(1).max(16).optional(),
    /** 同轮并发子代理上限（缺省 4） */
    maxConcurrentSubagents: z.number().int().min(1).max(8).default(4),
    codeMode: codeModeSchema.default({
      enabled: true,
      uiEnabled: true,
      timeoutMs: 120_000,
      maxCodeChars: 20_000,
      maxParallelSubCalls: 10,
    }),
  }),
  tools: buildToolsSchema(),
  mcpServers: z.record(z.string(), z.unknown()),
  mcp: z
    .object({
      callTimeoutMs: z.number().int().positive().optional(),
      allowSampling: z.boolean().optional(),
    })
    .optional(),
  mcpServer: z
    .object({
      enabled: z.boolean(),
      allowedTools: z.array(z.string()),
      responseMode: z.enum(['json', 'sse']).default('sse'),
      exposeInternalTools: z.boolean().default(false),
      trackSummary: z.boolean().default(true),
    })
    .optional(),
  skills: z.record(z.string(), z.object({ enabled: z.boolean().optional() })).optional(),
  commands: z.record(z.string(), z.object({ enabled: z.boolean().optional() })).optional(),
  security: z.object({
    authToken: z.string(),
    bindLocalhostOnly: z.boolean(),
  }),
  remote: z
    .object({
      enabled: z.boolean().default(false),
      lanEnabled: z.boolean().default(true),
      lanPasswordEnabled: z.boolean().default(true),
      lanIpOverride: z.string().default(''),
    })
    .prefault({}),
  fileHistory: fileHistorySchema.optional(),
  filesys: filesysSchema.optional(),
  safety: safetySchema.optional(),
  context: contextSchema.optional(),
  voice: z
    .object({
      enabled: z.boolean().default(false),
      providerId: z.string().default(''),
      localModel: z.string().default(''),
      language: z.string().default('auto'),
    })
    .prefault({}),
});

/** 旧版搜索服务商（已彻底移除）：加载时过滤，避免整份 api.json 校验失败 */
function isLegacySearchProvider(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as { kind?: unknown; format?: unknown };
  return record.kind === 'search' || record.format === 'search';
}

export const apiConfigSchema = z.object({
  version: z.number().int().positive(),
  providers: z.preprocess(
    (value) => (Array.isArray(value) ? value.filter((item) => !isLegacySearchProvider(item)) : value),
    z.array(providerConfigSchema),
  ),
});
