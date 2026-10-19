// src/core/config-service.ts
// 配置服务：加载 config.json + api.json，Zod 校验，热重载，分发。

import { setBackendLocale, t } from './i18n';
import { migrateLegacyApiConfig } from './provider-utils';
import { z } from 'zod';
import { join } from 'node:path';
import { atomicWriteFile } from '../utils/fs-atomic';
import type {
  AppConfig,
  ApiConfig,
  ConfigService,
  Environment,
  EventBus,
  EventBusSubscription,
  Logger,
  LogLevel,
} from './types';
import { buildToolsSchema, buildToolsDefaults } from '../modules/tools/manifest';
import { DEFAULT_FILE_HISTORY_CONFIG } from '../modules/file-history/types';
import { DEFAULT_FILESYS_CONFIG } from '../modules/filesys/types';
import { DEFAULT_CONTEXT_CONFIG } from '../modules/context/types';

// ============================================================================
// Zod Schemas
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
    /** 服务商类型：model（默认/缺省）= 模型服务商；search = 搜索服务商；voice = 语音服务商 */
    kind: z.enum(['model', 'search', 'voice']).optional(),
    format: z.enum(['openai-chat', 'openai-responses', 'anthropic', 'gemini', 'search', 'voice']),
    /** 搜索引擎类型（kind='search' 时必填）：zhipu / bocha / tavily */
    searchEngine: z.enum(['zhipu', 'bocha', 'tavily']).optional(),
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
    // kind='search'：必须带 searchEngine、format 固定 'search'、无模型
    if (p.kind === 'search') {
      if (!p.searchEngine) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "search provider requires 'searchEngine' (zhipu/bocha/tavily)",
        });
      }
      if (p.format !== 'search') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "search provider format must be 'search'",
        });
      }
      if (p.models.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'search provider must not carry models',
        });
      }
    } else if (p.kind === 'voice') {
      // kind='voice'：必须带 voiceEngine、format 固定 'voice'、无模型
      if (!p.voiceEngine) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "voice provider requires 'voiceEngine' (openai-transcriptions)",
        });
      }
      if (p.format !== 'voice') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "voice provider format must be 'voice'",
        });
      }
      if (p.models.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'voice provider must not carry models',
        });
      }
      if (p.searchEngine !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "searchEngine is only allowed on kind='search' providers",
        });
      }
    } else {
      // 模型服务商（kind='model' 或缺省）：不得携带 searchEngine / voiceEngine
      if (p.searchEngine !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "searchEngine is only allowed on kind='search' providers",
        });
      }
      if (p.voiceEngine !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "voiceEngine is only allowed on kind='voice' providers",
        });
      }
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
      maxFiles: z.number().int().positive().default(20_000),
      timeoutMs: z.number().int().positive().default(3000),
    })
    .default({}),
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
    .default({}),
  protectedPaths: z.array(z.string()).default(['~/.ssh', '~/.gnupg', '~/.aws']),
});

// logs：日志系统配置（内层全 .default() 自愈；外层 .default({}) 使旧 config.json 缺段自动补全）
const logsSchema = z.object({
  level: logLevelSchema.default('info'),
  retentionDays: z.number().int().min(1).max(365).default(14),
  maxFileMb: z.number().min(1).max(100).default(10),
});

// context：上下文引擎配置（压缩/工具结果修剪/自愈/遥测；内层全 .default() 自愈，
// 旧 config.json 缺段自动补全，热更新经 config:changed 实时生效）
const contextSchema = z.object({
  compaction: z
    .object({
      enabled: z.boolean().default(true),
      compactRatio: z.number().min(0.5).max(0.95).default(0.80),
      tailKeepRatio: z.number().min(0.05).max(0.5).default(0.16),
      summaryMaxTokens: z.number().int().positive().default(8192),
      minFoldTokens: z.number().int().positive().default(400),
      summaryModel: z.string().default('inherit'),
      // 收缩比上限（摘要必须 ≤ 可压缩区 × 本值，否则放弃本轮）
      maxShrinkRatio: z.number().min(0.1).max(0.95).default(0.5),
      minCompactMessages: z.number().int().min(2).max(100).default(4),
      // 冷却水位（token）与冷却时间窗（ms）
      cooldownGrowthTokens: z.number().int().min(0).default(2000),
      cooldownMs: z.number().int().min(0).default(60000),
    })
    .default({}),
  toolPruning: z
    .object({
      enabled: z.boolean().default(true),
      thresholdChars: z.number().int().positive().default(8192),
      keepHeadChars: z.number().int().positive().default(4096),
      keepTailChars: z.number().int().positive().default(1024),
    })
    .default({}),
  healer: z
    .object({
      enabled: z.boolean().default(true),
      toolNameFuzzy: z.boolean().default(true),
      schemaFix: z.boolean().default(true),
    })
    .default({}),
  telemetry: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
  // 文件索引模块（三引擎，默认全关；图谱/SAG 依赖索引引擎，开启时联动）
  fileIndex: z
    .object({
      indexing: z
        .object({
          enabled: z.boolean().default(false),
        })
        .default({}),
      graph: z
        .object({
          enabled: z.boolean().default(false),
        })
        .default({}),
      sag: z
        .object({
          enabled: z.boolean().default(false),
          llmModel: z.string().default('inherit'),
          llmMaxChunks: z.number().int().min(0).max(100000).default(2000),
        })
        .default({}),
      ignore: z.array(z.string()).default([]),
    })
    .default({}),
  // 用户规则引擎（always/paths 双加载模式）
  rules: z
    .object({
      enabled: z.boolean().default(true),
      maxAlwaysTokens: z.number().int().positive().default(4000),
      maxInjectPerSession: z.number().int().positive().min(1).max(100).default(20),
    })
    .default({}),
  // 生命周期钩子引擎（终端命令 + TS 模块）
  hooks: z
    .object({
      enabled: z.boolean().default(true),
      defaultTimeout: z.number().int().positive().default(10000),
    })
    .default({}),
  // 记忆引擎（记忆宫殿 + verbatim/蒸馏混合 + BM25 检索）
  memory: z
    .object({
      enabled: z.boolean().default(true),
      distillModel: z.string().default('inherit'),
      distillMinMessages: z.number().int().min(1).max(100).default(6),
      recallTopK: z.number().int().min(1).max(50).default(5),
      recallTokenBudget: z.number().int().positive().default(2000),
      l1ImportanceThreshold: z.number().min(0).max(1).default(0.75),
      l1MaxEntries: z.number().int().min(1).max(100).default(20),
    })
    .default({}),
  // 图片发送前优化（TinyPNG 式；sharp 不可用时自动降级为不压缩发送原图）
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
    .default({}),
  // 思考内容回传（计入估算对所有 provider 生效；回传按 provider 语义）
  thinking: z
    .object({
      replayOpenAICompat: z.boolean().default(false),
    })
    .default({}),
  // 单次请求体字节上限（256 KiB–64 MiB；默认 8 MiB）。
  // 旧 config.json 缺该字段时由 .default() 自动补全；热更新经 config:changed 生效。
  maxRequestBytes: z
    .number()
    .int()
    .min(262144)
    .max(67108864)
    .default(8 * 1024 * 1024),
});

const appConfigSchema = z.object({
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
  // 日志系统配置（缺段时自动补全默认值；旧版 daemon.logLevel 在读取前迁移）
  logs: logsSchema.default({}),
  update: z.object({
    autoCheck: z.boolean(),
    channel: z.enum(['stable', 'beta']),
    checkIntervalHours: z.number().int().min(1),
  }),
  agent: z.object({
    defaultModel: z.string(),
    maxTokens: z.number().int().positive(),
    // 0 = 不限制（无限轮）；1-199 仍合法（向后兼容存量配置，UI 侧最小 200）
    maxTurns: z.number().int().min(0),
    // SSE 流空闲超时（ms）：可选，缺省由 parseSSEStream 用内置默认（15 分钟）兜底。
    // 存量 config.json 无此字段不会校验失败；上下限防止极端值把弱网半开连接挂死。
    llmStreamIdleTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional(),
    workingDirectory: z.string(),
  }),
  // tools schema 从 manifest 自动构建（单一真相源），新增工具无需手动改此文件
  tools: buildToolsSchema(),
  mcpServers: z.record(z.string(), z.unknown()),
  // MCP 客户端配置（可选，向后兼容旧配置）
  mcp: z
    .object({
      callTimeoutMs: z.number().int().positive().optional(),
      allowSampling: z.boolean().optional(),
    })
    .optional(),
  // 对外 MCP Server 暴露（/mcp 端点，可选）
  mcpServer: z
    .object({
      enabled: z.boolean(),
      allowedTools: z.array(z.string()),
      // 缺省 'sse'：SDK 默认响应模式，长任务有 keep-alive 保护（见 types.ts 注释）
      responseMode: z.enum(['json', 'sse']).default('sse'),
      // 缺省 false：/mcp 只暴露 agent 级工具（moss_*），不暴露 MOSS 内部工具
      exposeInternalTools: z.boolean().default(false),
      // 缺省 true：moss_task_status 附带 LLM 轨迹摘要（失败自动降级）
      trackSummary: z.boolean().default(true),
    })
    .optional(),
  // Skill 启停（可选）
  skills: z.record(z.string(), z.object({ enabled: z.boolean().optional() })).optional(),
  // 自定义斜杠命令启停（~/.moss/commands/<name>.md；缺省启用）
  commands: z.record(z.string(), z.object({ enabled: z.boolean().optional() })).optional(),
  security: z.object({
    authToken: z.string(),
    bindLocalhostOnly: z.boolean(),
  }),
  // 远程访问（remote 模块：局域网/公网隧道控制 webui；内层全 .default() 自愈补全）
  remote: z
    .object({
      enabled: z.boolean().default(false),
      lanEnabled: z.boolean().default(true),
      lanPasswordEnabled: z.boolean().default(true),
      lanIpOverride: z.string().default(''),
    })
    .default({}),
  // fileHistory 可选，缺失时用默认值（向后兼容旧配置）
  fileHistory: fileHistorySchema.optional(),
  // filesys 可选，内层全 .default() 自愈补全（向后兼容旧配置）
  filesys: filesysSchema.optional(),
  // safety 可选，内层全 .default() 自愈补全（向后兼容旧配置）
  safety: safetySchema.optional(),
  // context 可选，内层全 .default() 自愈补全（向后兼容旧配置）
  context: contextSchema.optional(),
  // web 可选（联网搜索默认引擎；内层 .default() 自愈补全，旧配置缺段自动补 {searchProviderId: ''}）
  web: z
    .object({
      searchProviderId: z.string().default(''),
    })
    .default({}),
  // voice 可选（语音输入总开关/服务商/本地模型；内层全 .default() 自愈补全，默认关闭）
  voice: z
    .object({
      enabled: z.boolean().default(false),
      providerId: z.string().default(''),
      localModel: z.string().default(''),
      language: z.string().default('auto'),
    })
    .default({}),
});

const apiConfigSchema = z.object({
  version: z.number().int().positive(),
  providers: z.array(providerConfigSchema),
});

// ============================================================================
// 默认配置模板（首次运行使用）
// ============================================================================

export function defaultAppConfig(): AppConfig {
  return {
    version: 1,
    server: { host: '127.0.0.1', port: 7766, autoPort: true, locale: 'zh' },
    daemon: { enabled: true },
    logs: { level: 'info', retentionDays: 14, maxFileMb: 10 },
    update: { autoCheck: true, channel: 'stable', checkIntervalHours: 24 },
    agent: {
      defaultModel: '',
      maxTokens: 8192,
      maxTurns: 0,
      // 15 分钟：长程任务/推理型模型长思考的空闲容忍度
      llmStreamIdleTimeoutMs: 900_000,
      workingDirectory: '',
    },
    // tools 默认值从 manifest 自动构建（单一真相源）
    tools: buildToolsDefaults() as AppConfig['tools'],
    mcpServers: {},
    mcp: { callTimeoutMs: 120000, allowSampling: true },
    mcpServer: { enabled: false, allowedTools: [], responseMode: 'sse', exposeInternalTools: false, trackSummary: true },
    skills: {},
    security: { authToken: '', bindLocalhostOnly: true },
    remote: { enabled: false, lanEnabled: true, lanPasswordEnabled: true, lanIpOverride: '' },
    fileHistory: { ...DEFAULT_FILE_HISTORY_CONFIG },
    filesys: { ...DEFAULT_FILESYS_CONFIG },
    context: {
      compaction: { ...DEFAULT_CONTEXT_CONFIG.compaction },
      toolPruning: { ...DEFAULT_CONTEXT_CONFIG.toolPruning },
      healer: { ...DEFAULT_CONTEXT_CONFIG.healer },
      telemetry: { ...DEFAULT_CONTEXT_CONFIG.telemetry },
      fileIndex: { ...DEFAULT_CONTEXT_CONFIG.fileIndex },
      rules: { ...DEFAULT_CONTEXT_CONFIG.rules },
      hooks: { ...DEFAULT_CONTEXT_CONFIG.hooks },
      memory: { ...DEFAULT_CONTEXT_CONFIG.memory },
      imageOptimization: { ...DEFAULT_CONTEXT_CONFIG.imageOptimization },
      thinking: { ...DEFAULT_CONTEXT_CONFIG.thinking },
      maxRequestBytes: DEFAULT_CONTEXT_CONFIG.maxRequestBytes,
    },
    safety: {
      defaultMode: 'ask',
      confirmTimeoutMinutes: 5,
      blockDangerousCommands: true,
      cautionPolicy: 'ask',
      rules: { allow: [], deny: [], ask: [] },
      protectedPaths: ['~/.ssh', '~/.gnupg', '~/.aws'],
    },
    web: { searchProviderId: '' },
    voice: { enabled: false, providerId: '', localModel: '', language: 'auto' },
  };
}

export function defaultApiConfig(): ApiConfig {
  return {
    version: 2,
    providers: [],
  };
}

// ============================================================================
// ConfigService 实现
// ============================================================================

interface FsOps {
  exists(path: string): boolean;
  readText(path: string): string;
  writeText(path: string, content: string): void;
  mkdirRecursive(path: string): void;
  copyFile(src: string, dest: string): void;
}

class ConfigServiceImpl implements ConfigService {
  private appConfig: AppConfig | null = null;
  private apiConfig: ApiConfig | null = null;
  private readonly env: Environment;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly fs: FsOps;
  private readonly changeHandlers: Array<(which: 'app' | 'api') => void> = [];
  private watcherStarted = false;

  constructor(
    env: Environment,
    eventBus: EventBus,
    logger: Logger,
    fs: FsOps,
  ) {
    this.env = env;
    this.eventBus = eventBus;
    this.logger = logger;
    this.fs = fs;
  }

  async load(): Promise<void> {
    // 1. 确保配置目录存在
    this.fs.mkdirRecursive(this.env.configDir);

    const appPath = join(this.env.configDir, 'config.json');
    const apiPath = join(this.env.configDir, 'api.json');

    // 2. 首次运行：从包内模板复制（若存在）；否则写入默认模板
    const pkgAppTemplate = join(this.env.packageRoot, 'config', 'config.json');
    const pkgApiTemplate = join(this.env.packageRoot, 'config', 'api.json');

    if (!this.fs.exists(appPath)) {
      if (this.fs.exists(pkgAppTemplate)) {
        this.fs.copyFile(pkgAppTemplate, appPath);
        this.logger.info(t('config.copiedAppTemplate'));
      } else {
        this.fs.writeText(appPath, JSON.stringify(defaultAppConfig(), null, 2));
        this.logger.info(t('config.createdDefaultApp'));
      }
    }
    if (!this.fs.exists(apiPath)) {
      if (this.fs.exists(pkgApiTemplate)) {
        this.fs.copyFile(pkgApiTemplate, apiPath);
        this.logger.info(t('config.copiedApiTemplate'));
      } else {
        this.fs.writeText(apiPath, JSON.stringify(defaultApiConfig(), null, 2));
        this.logger.info(t('config.createdDefaultApi'));
      }
    }

    // 3. 读取并校验
    this.appConfig = this.readAndValidateApp(appPath);
    this.apiConfig = this.readAndValidateApi(apiPath);

    // 4. 启动文件 watcher（仅一次）
    if (!this.watcherStarted) {
      this.startWatcher(appPath, apiPath);
      this.watcherStarted = true;
    }
  }

  /**
   * 配置加载失败时回退到默认配置（降级运行）。
   * 仅在 load() 抛错时由 kernel 调用，保证后续 getAppConfig()/getApiConfig() 可用。
   */
  loadDefaults(): void {
    this.appConfig = defaultAppConfig();
    this.apiConfig = defaultApiConfig();
    this.logger.warn(t('config.fallbackToDefaults'));
  }

  getAppConfig(): AppConfig {
    if (!this.appConfig) throw new Error(t('config.notLoadedCallFirst'));
    // 返回深拷贝避免外部意外修改
    return deepClone(this.appConfig);
  }

  getApiConfig(): ApiConfig {
    if (!this.apiConfig) throw new Error(t('config.notLoadedCallFirst'));
    return deepClone(this.apiConfig);
  }

  async updateAppConfig(patch: Partial<AppConfig>): Promise<void> {
    if (!this.appConfig) throw new Error(t('config.notLoaded'));
    // 空 authToken 视为不修改（GET 已脱敏，避免前端 round-trip 清空令牌）
    const clean = { ...patch } as Record<string, unknown>;
    const sec = clean.security as Record<string, unknown> | undefined;
    if (sec && typeof sec === 'object' && sec.authToken === '') {
      delete sec.authToken;
    }
    const merged = deepMerge(this.appConfig, clean) as AppConfig;
    const parsed = appConfigSchema.parse(merged);
    this.appConfig = parsed;
    this.logger.info(t('config.appConfigUpdated'), { keys: Object.keys(patch) });
    this.fs.writeText(join(this.env.configDir, 'config.json'), JSON.stringify(parsed, null, 2));
    this.applyLocale();
    await this.eventBus.broadcast('config:changed', { which: 'app' });
    this.notifyChange('app');
  }

  async updateApiConfig(patch: Partial<ApiConfig>): Promise<void> {
    if (!this.apiConfig) throw new Error(t('config.notLoaded'));
    const merged = deepMerge(this.apiConfig, patch) as ApiConfig;
    // 空 apiKey 视为不修改（GET 已脱敏），按 provider id 回填原值，避免 round-trip 清空密钥
    for (const p of merged.providers) {
      if (!p.apiKey) {
        const existing = this.apiConfig.providers.find((x) => x.id === p.id);
        if (existing) p.apiKey = existing.apiKey;
      }
    }
    const parsed = apiConfigSchema.parse(merged);
    this.apiConfig = parsed;
    this.fs.writeText(join(this.env.configDir, 'api.json'), JSON.stringify(parsed, null, 2));
    await this.eventBus.broadcast('config:changed', { which: 'api' });
    this.notifyChange('api');
  }

  async reload(): Promise<void> {
    const appPath = join(this.env.configDir, 'config.json');
    const apiPath = join(this.env.configDir, 'api.json');
    const newApp = this.readAndValidateApp(appPath);
    const newApi = this.readAndValidateApi(apiPath);
    // 内容对比守卫：与内存中配置逐字对比，未变化的文件跳过通知。
    // 防止 updateAppConfig 写盘后 watcher 二次触发的重复通知，以及
    // 外部程序反复写相同内容（touch 噪音）被放大为 MCP 全量重载循环。
    const appChanged = this.appConfig === null || JSON.stringify(newApp) !== JSON.stringify(this.appConfig);
    const apiChanged = this.apiConfig === null || JSON.stringify(newApi) !== JSON.stringify(this.apiConfig);
    this.appConfig = newApp;
    this.apiConfig = newApi;
    this.applyLocale();
    if (appChanged) {
      await this.eventBus.broadcast('config:changed', { which: 'app' });
      this.notifyChange('app');
    }
    if (apiChanged) {
      await this.eventBus.broadcast('config:changed', { which: 'api' });
      this.notifyChange('api');
    }
    if (appChanged || apiChanged) {
      this.logger.info(t('config.reloadedFromDisk'), { appChanged, apiChanged });
    } else {
      this.logger.debug(t('config.reloadedFromDisk'));
    }
  }

  onChange(handler: (which: 'app' | 'api') => void): EventBusSubscription {
    this.changeHandlers.push(handler);
    return {
      unsubscribe: () => {
        const idx = this.changeHandlers.indexOf(handler);
        if (idx >= 0) this.changeHandlers.splice(idx, 1);
      },
    };
  }

  /** 重新应用后端语言（server.locale 变更时后端 t() 实时同步） */
  private applyLocale(): void {
    if (!this.appConfig) return;
    setBackendLocale(this.appConfig.server.locale === 'en' ? 'en' : 'zh');
  }

  private notifyChange(which: 'app' | 'api'): void {
    for (const h of this.changeHandlers) {
      try {
        h(which);
      } catch (err) {
        this.logger.warn(t('config.changeHandlerFailed'), {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private readAndValidateApp(path: string): AppConfig {
    const text = this.fs.readText(path);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(t('config.configJsonInvalid', { error: err instanceof Error ? err.message : String(err) }));
    }
    // 一次性迁移：旧版 daemon.logLevel → logs.level（仅当 logs.level 未显式设置时）；
    // 迁移后删除旧字段，下次写盘自然落盘为新结构
    migrateLegacyLogLevel(raw as Record<string, unknown>);
    // 一次性迁移：旧 shell 命名 → terminal 命名（tools.shell / filesys.shellWatch / safety 规则前缀 shell(）
    migrateLegacyShellNaming(raw as Record<string, unknown>);
    const result = appConfigSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map(i => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(t('config.configJsonValidationFailed', { issues }));
    }
    return result.data as AppConfig;
  }

  private readAndValidateApi(path: string): ApiConfig {
    const text = this.fs.readText(path);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(t('config.apiJsonInvalid', { error: err instanceof Error ? err.message : String(err) }));
    }
    // 一次性迁移：旧版扁平 models（version 1）→ providers 结构（version 2）；
    // 迁移成功后立即写回磁盘，防止仅内存迁移
    if (migrateLegacyApiConfig(raw as Record<string, unknown>)) {
      this.logger.info(t('config.apiConfigMigrated'));
      this.fs.writeText(path, JSON.stringify(raw, null, 2));
    }
    const result = apiConfigSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map(i => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(t('config.apiJsonValidationFailed', { issues }));
    }
    return result.data as ApiConfig;
  }

  private startWatcher(appPath: string, apiPath: string): void {
    // Bun 原生支持 fs.watch
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fs = require('node:fs');
      let debounce: ReturnType<typeof setTimeout> | null = null;
      const handle = (which: 'app' | 'api') => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          this.logger.info(t('config.fileChangedReloading', { which }));
          this.reload().catch(err => {
            this.logger.error(t('config.reloadFailed'), {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, 300);
      };
      fs.watch(appPath, () => handle('app'));
      fs.watch(apiPath, () => handle('api'));
      this.logger.debug(t('config.watcherStarted'));
    } catch (err) {
      this.logger.warn(t('config.watcherStartFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ============================================================================
// 工具函数
// ============================================================================

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

/** 旧版 daemon.logLevel → logs.level 迁移（原地修改 raw 对象） */
function migrateLegacyLogLevel(raw: Record<string, unknown> | null): void {
  if (!raw || typeof raw !== 'object') return;
  const daemon = raw.daemon as Record<string, unknown> | undefined;
  if (!daemon || typeof daemon.logLevel !== 'string') return;
  const logs = (raw.logs as Record<string, unknown> | undefined) ?? {};
  if (logs.level === undefined) {
    logs.level = daemon.logLevel;
    raw.logs = logs;
  }
  delete daemon.logLevel;
}

/**
 * 旧 shell 命名 → terminal 命名迁移（原地修改 raw 对象；幂等，失败静默）：
 * - tools.shell → tools.terminal（保留用户 enabled/timeout/requireConfirmation 等设置）
 * - filesys.shellWatch → filesys.terminalWatch
 * - safety.rules.{allow,deny,ask} 中规则 content 前缀 `shell(` → `terminal(`
 */
function migrateLegacyShellNaming(raw: Record<string, unknown> | null): void {
  if (!raw || typeof raw !== 'object') return;

  // tools.shell → tools.terminal
  const tools = raw.tools as Record<string, unknown> | undefined;
  if (tools && typeof tools === 'object' && 'shell' in tools && !('terminal' in tools)) {
    tools.terminal = tools.shell;
    delete tools.shell;
  }

  // filesys.shellWatch → filesys.terminalWatch
  const filesys = raw.filesys as Record<string, unknown> | undefined;
  if (filesys && typeof filesys === 'object' && 'shellWatch' in filesys && !('terminalWatch' in filesys)) {
    filesys.terminalWatch = filesys.shellWatch;
    delete filesys.shellWatch;
  }

  // safety.rules 前缀 shell( → terminal(
  const safety = raw.safety as Record<string, unknown> | undefined;
  const rules = safety?.rules as Record<string, unknown> | undefined;
  if (rules && typeof rules === 'object') {
    for (const key of ['allow', 'deny', 'ask'] as const) {
      const list = rules[key];
      if (Array.isArray(list)) {
        rules[key] = list.map((item) =>
          typeof item === 'string' && item.startsWith('shell(')
            ? `terminal(${item.slice('shell('.length)}`
            : item,
        );
      }
    }
  }
}

function deepMerge(target: unknown, patch: unknown): unknown {
  if (patch === null || patch === undefined) return target;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    return patch;
  }
  const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    result[k] = deepMerge((target as Record<string, unknown>)[k], v);
  }
  return result;
}

// ============================================================================
// FsOps 默认实现（基于 node:fs）
// ============================================================================

function createNodeFsOps(): FsOps {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  return {
    exists: (p: string) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    },
    readText: (p: string) => fs.readFileSync(p, 'utf8'),
    writeText: (p: string, content: string) => {
      // 原子写（tmp+fsync+rename）：配置文件写一半进程崩溃不再损坏 config.json/api.json
      fs.mkdirSync(path.dirname(p), { recursive: true });
      atomicWriteFile(p, content, { fsync: true });
    },
    mkdirRecursive: (p: string) => fs.mkdirSync(p, { recursive: true }),
    copyFile: (src: string, dest: string) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    },
  };
}

export function createConfigService(
  env: Environment,
  eventBus: EventBus,
  logger: Logger,
): ConfigService {
  return new ConfigServiceImpl(env, eventBus, logger, createNodeFsOps());
}

// 导出 schema 供外部校验使用
export { appConfigSchema, apiConfigSchema };
export type { FsOps };
export type { LogLevel };
