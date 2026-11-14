// src/core/config-service.ts
// 配置服务：加载 config.json + api.json，校验，热重载，分发。
//
// 启动性能关键路径（0.8GHz 单核低配机）：
// - 启动期不再静态加载 zod（zod v4 约 729KB，进入启动闭包会带来数百毫秒到秒级开销）；
// - 启动期走「JSON.parse + 旧字段迁移 + 默认值深合并」快速路径，立即可用；
// - 完整 zod 校验延后到后台（且仅在配置文件指纹变化时执行），失败回退默认配置；
// - 配置文件的 watch 也延后启动，不占启动关键路径。

import { setBackendLocale, t } from './i18n';
import { migrateLegacyApiConfig, stripRemovedProviders } from './provider-utils';
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
import { buildToolsDefaults } from '../modules/tools/manifest';
import { DEFAULT_FILE_HISTORY_CONFIG } from '../modules/file-history/types';
import { DEFAULT_FILESYS_CONFIG } from '../modules/filesys/types';
import { DEFAULT_CONTEXT_CONFIG } from '../modules/context/types';

/** 校验指纹文件（记录最近一次 zod 校验成功时的文件 mtime+size） */
const VALIDATED_MARKER = '.validated.json';
/** 后台校验延迟：等内核就绪后再做，避免与首条消息抢 CPU */
const BACKGROUND_VALIDATION_DELAY_MS = 800;
/** 配置 watcher 启动延迟 */
const WATCHER_DELAY_MS = 300;

// ============================================================================
// 默认配置模板（首次运行使用）
// ============================================================================

export function defaultAppConfig(): AppConfig {
  return {
    version: 1,
    server: { host: '127.0.0.1', port: 7766, autoPort: true, locale: 'zh' },
    daemon: { enabled: true },
    power: { preventSleep: false },
    logs: { level: 'info', retentionDays: 14, maxFileMb: 10 },
    update: { autoCheck: true, channel: 'stable', checkIntervalHours: 24 },
    agent: {
      defaultModel: '',
      maxTokens: 8192,
      maxTurns: 0,
      maxConcurrentSubagents: 4,
      maxSubagentDepth: 2,
      llmStreamIdleTimeoutMs: 900_000,
      workingDirectory: '',
      codeMode: {
        enabled: true,
        uiEnabled: true,
        timeoutMs: 120_000,
        maxCodeChars: 20_000,
        maxParallelSubCalls: 10,
      },
    },
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
      healer: { ...DEFAULT_CONTEXT_CONFIG.healer },
      telemetry: { ...DEFAULT_CONTEXT_CONFIG.telemetry },
      rules: { ...DEFAULT_CONTEXT_CONFIG.rules },
      hooks: { ...DEFAULT_CONTEXT_CONFIG.hooks },
      memory: { ...DEFAULT_CONTEXT_CONFIG.memory },
      imageOptimization: { ...DEFAULT_CONTEXT_CONFIG.imageOptimization },
      thinking: { ...DEFAULT_CONTEXT_CONFIG.thinking },
      pressureReminder: { ...DEFAULT_CONTEXT_CONFIG.pressureReminder },
      maxRequestBytes: DEFAULT_CONTEXT_CONFIG.maxRequestBytes,
    },
    safety: {
      defaultMode: 'ask',
      confirmTimeoutMinutes: 5,
      blockDangerousCommands: true,
      cautionPolicy: 'ask',
      rules: { allow: [], deny: [], ask: [] },
      protectedPaths: ['~/.ssh', '~/.gnupg', '~/.aws'],
      review: {
        enabled: true,
        model: '',
        reasoningEffort: 'off',
        sensitivity: 'medium',
        timeoutMs: 30000,
        onReviewFailure: 'ask',
        cacheTtlMs: 60000,
        maxIntentChars: 4000,
      },
    },
    voice: { enabled: false, localModel: '', language: 'auto', languageExplicit: false },
    appearance: { accentColor: '#2563EB' },
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

interface FileStamp {
  mtimeMs: number;
  size: number;
}

interface FsOps {
  exists(path: string): boolean;
  readText(path: string): string;
  writeText(path: string, content: string): void;
  mkdirRecursive(path: string): void;
  copyFile(src: string, dest: string): void;
  stat(path: string): FileStamp | null;
}

class ConfigServiceImpl implements ConfigService {
  private appConfig: AppConfig | null = null;
  private apiConfig: ApiConfig | null = null;
  /** 对外只读视图：每次配置变更只克隆/冻结一次，避免每次 get 深拷贝 */
  private appView: AppConfig | null = null;
  private apiView: ApiConfig | null = null;
  private readonly env: Environment;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly fs: FsOps;
  private readonly changeHandlers: Array<(which: 'app' | 'api') => void> = [];
  private watcherStarted = false;

  constructor(env: Environment, eventBus: EventBus, logger: Logger, fs: FsOps) {
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

    // 3. 快速路径：JSON.parse + 迁移 + 默认值合并（不加载 zod）
    this.setAppConfig(this.readAppFast(appPath));
    this.setApiConfig(this.readApiFast(apiPath));

    // 4. 后台完整校验（仅在指纹变化时执行）
    this.scheduleBackgroundValidation(appPath, apiPath);

    // 5. 文件 watcher 延后启动（不占启动关键路径）
    if (!this.watcherStarted) {
      this.watcherStarted = true;
      setTimeout(() => this.startWatcher(appPath, apiPath), WATCHER_DELAY_MS);
    }
  }

  /**
   * 配置加载失败时回退到默认配置（降级运行）。
   * 仅在 load() 抛错时由 kernel 调用，保证后续 getAppConfig()/getApiConfig() 可用。
   */
  loadDefaults(): void {
    this.setAppConfig(defaultAppConfig());
    this.setApiConfig(defaultApiConfig());
    this.logger.warn(t('config.fallbackToDefaults'));
  }

  getAppConfig(): AppConfig {
    if (!this.appView) throw new Error(t('config.notLoadedCallFirst'));
    return this.appView;
  }

  getApiConfig(): ApiConfig {
    if (!this.apiView) throw new Error(t('config.notLoadedCallFirst'));
    return this.apiView;
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
    // 写入路径必须完整校验（安全边界；此时 zod 动态加载已被缓存）
    const { appConfigSchema } = await import('./config-schema');
    const parsed = appConfigSchema.parse(merged);
    // 幂等守卫：patch 未带来任何实际变化时不写盘、不广播（重复提交的第二次请求在此被拦下）
    if (JSON.stringify(parsed) === JSON.stringify(this.appConfig)) {
      this.logger.debug(t('config.appConfigUnchanged'), { keys: Object.keys(patch) });
      return;
    }
    this.setAppConfig(parsed as AppConfig);
    this.logger.info(t('config.appConfigUpdated', { keys: Object.keys(patch).join(', ') }), {
      keys: Object.keys(patch),
    });
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
    const { apiConfigSchema } = await import('./config-schema');
    const parsed = apiConfigSchema.parse(merged);
    this.setApiConfig(parsed as ApiConfig);
    this.fs.writeText(join(this.env.configDir, 'api.json'), JSON.stringify(parsed, null, 2));
    await this.eventBus.broadcast('config:changed', { which: 'api' });
    this.notifyChange('api');
  }

  async reload(): Promise<void> {
    const appPath = join(this.env.configDir, 'config.json');
    const apiPath = join(this.env.configDir, 'api.json');
    // 变更路径完整校验（zod 已动态加载并缓存）
    const newApp = await this.readAndValidateApp(appPath);
    const newApi = await this.readAndValidateApi(apiPath);
    // 内容对比守卫：与内存中配置逐字对比，未变化的文件跳过通知。
    const appChanged = this.appConfig === null || JSON.stringify(newApp) !== JSON.stringify(this.appConfig);
    const apiChanged = this.apiConfig === null || JSON.stringify(newApi) !== JSON.stringify(this.apiConfig);
    this.setAppConfig(newApp);
    this.setApiConfig(newApi);
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

  // ========================================================================
  // 内部：配置写入与只读视图
  // ========================================================================

  private setAppConfig(config: AppConfig): void {
    this.appConfig = config;
    // 对外视图：冻结副本，避免调用方意外修改内存配置；只克隆一次而非每次 get
    this.appView = deepFreeze(deepClone(config));
  }

  private setApiConfig(config: ApiConfig): void {
    this.apiConfig = config;
    this.apiView = deepFreeze(deepClone(config));
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

  // ========================================================================
  // 内部：快速读取（启动路径，不加载 zod）
  // ========================================================================

  private readAppFast(path: string): AppConfig {
    const text = this.fs.readText(path);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(t('config.configJsonInvalid', { error: err instanceof Error ? err.message : String(err) }));
    }
    const record = raw as Record<string, unknown>;
    migrateLegacyLogLevel(record);
    migrateLegacyShellNaming(record);
    // 缺失字段用默认值补齐（等价于 zod 各层 .default/.prefault 的常规路径）
    return deepMerge(defaultAppConfig(), record) as AppConfig;
  }

  private readApiFast(path: string): ApiConfig {
    const text = this.fs.readText(path);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(t('config.apiJsonInvalid', { error: err instanceof Error ? err.message : String(err) }));
    }
    let dirty = false;
    if (migrateLegacyApiConfig(raw as Record<string, unknown>)) {
      this.logger.info(t('config.apiConfigMigrated'));
      dirty = true;
    }
    // 已移除的服务商类型（语音 / 旧搜索）：快速路径同步剔除并落盘，
    // 避免旧条目在 UI 上短暂出现，也确保「彻底删除」不依赖后续完整校验。
    if (stripRemovedProviders(raw as Record<string, unknown>)) dirty = true;
    if (dirty) {
      this.fs.writeText(path, JSON.stringify(raw, null, 2));
    }
    return deepMerge(defaultApiConfig(), raw) as ApiConfig;
  }

  // ========================================================================
  // 内部：完整校验（变更/后台路径，动态加载 zod）
  // ========================================================================

  private async readAndValidateApp(path: string): Promise<AppConfig> {
    const text = this.fs.readText(path);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(t('config.configJsonInvalid', { error: err instanceof Error ? err.message : String(err) }));
    }
    migrateLegacyLogLevel(raw as Record<string, unknown>);
    migrateLegacyShellNaming(raw as Record<string, unknown>);
    const { appConfigSchema } = await import('./config-schema');
    const result = appConfigSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map(i => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(t('config.configJsonValidationFailed', { issues }));
    }
    return result.data as AppConfig;
  }

  private async readAndValidateApi(path: string): Promise<ApiConfig> {
    const text = this.fs.readText(path);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(t('config.apiJsonInvalid', { error: err instanceof Error ? err.message : String(err) }));
    }
    if (migrateLegacyApiConfig(raw as Record<string, unknown>)) {
      this.logger.info(t('config.apiConfigMigrated'));
      this.fs.writeText(path, JSON.stringify(raw, null, 2));
    }
    const { apiConfigSchema } = await import('./config-schema');
    const result = apiConfigSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map(i => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(t('config.apiJsonValidationFailed', { issues }));
    }
    return result.data as ApiConfig;
  }

  /**
   * 后台完整校验：指纹未变化的配置跳过（启动只做一次 JSON.parse + 默认值合并）。
   * 校验失败 → 回退默认配置并广播 config:changed（与 loadDefaults 行为一致）。
   */
  private scheduleBackgroundValidation(appPath: string, apiPath: string): void {
    if (this.isFingerprintFresh(appPath, apiPath)) return;
    setTimeout(() => {
      void this.validateInBackground(appPath, apiPath);
    }, BACKGROUND_VALIDATION_DELAY_MS);
  }

  private markerPath(): string {
    return join(this.env.configDir, VALIDATED_MARKER);
  }

  private isFingerprintFresh(appPath: string, apiPath: string): boolean {
    try {
      const marker = JSON.parse(this.fs.readText(this.markerPath())) as {
        version?: number;
        app?: FileStamp;
        api?: FileStamp;
      };
      if (marker.version !== 1 || !marker.app || !marker.api) return false;
      const app = this.fs.stat(appPath);
      const api = this.fs.stat(apiPath);
      if (!app || !api) return false;
      return (
        app.mtimeMs === marker.app.mtimeMs &&
        app.size === marker.app.size &&
        api.mtimeMs === marker.api.mtimeMs &&
        api.size === marker.api.size
      );
    } catch {
      return false;
    }
  }

  private writeFingerprint(appPath: string, apiPath: string): void {
    const app = this.fs.stat(appPath);
    const api = this.fs.stat(apiPath);
    if (!app || !api) return;
    try {
      this.fs.writeText(
        this.markerPath(),
        JSON.stringify({ version: 1, app, api }, null, 2),
      );
    } catch {
      // 指纹写失败只影响下次启动是否重复校验，不影响运行
    }
  }

  private async validateInBackground(appPath: string, apiPath: string): Promise<void> {
    try {
      const [app, api] = await Promise.all([
        this.readAndValidateApp(appPath),
        this.readAndValidateApi(apiPath),
      ]);
      // 校验通过：以完整校验结果为准（与 zod 规范化语义一致）
      this.setAppConfig(app);
      this.setApiConfig(api);
      this.applyLocale();
      this.writeFingerprint(appPath, apiPath);
      this.logger.debug(t('config.backgroundValidationPassed'));
    } catch (err) {
      this.logger.error(t('config.backgroundValidationFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
      // 非法配置：回退默认，避免运行期出现半合法状态
      this.loadDefaults();
      this.applyLocale();
      await this.eventBus.broadcast('config:changed', { which: 'app' }).catch(() => {});
      this.notifyChange('app');
    }
  }

  // ========================================================================
  // 内部：文件监听
  // ========================================================================

  private startWatcher(appPath: string, apiPath: string): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { basename } = require('node:path');
      // 监听目录而非单个文件：编辑器/同步盘的原子替换（写临时文件后 rename）会让
      // fs.watch(file) 丢失后续事件，目录监听不受影响
      const watchDir = this.env.configDir;
      const appName = String(basename(appPath)).toLowerCase();
      const apiName = String(basename(apiPath)).toLowerCase();
      const pending = new Set<'app' | 'api'>();
      let debounce: ReturnType<typeof setTimeout> | null = null;
      const flush = (): void => {
        debounce = null;
        const which = Array.from(pending).join(',') || 'unknown';
        pending.clear();
        this.logger.debug(t('config.fileChangedReloading', { which }));
        this.reload().catch(err => {
          this.logger.error(t('config.reloadFailed'), {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      };
      const enqueue = (which: 'app' | 'api'): void => {
        pending.add(which);
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(flush, 300);
      };
      const watcher: { on(event: 'error', handler: (err: Error) => void): void } = fs.watch(
        watchDir,
        (_eventType: string, filename: string | null) => {
          if (!filename) return;
          const name = String(filename).toLowerCase();
          if (name === appName) enqueue('app');
          else if (name === apiName) enqueue('api');
        },
      );
      watcher.on('error', (err: Error) => {
        this.logger.warn(t('config.watcherStartFailed'), { error: err.message });
      });
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

/** 深度冻结：对外配置视图只读，防止调用方误改内存配置 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
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

  const tools = raw.tools as Record<string, unknown> | undefined;
  if (tools && typeof tools === 'object' && 'shell' in tools && !('terminal' in tools)) {
    tools.terminal = tools.shell;
    delete tools.shell;
  }

  const filesys = raw.filesys as Record<string, unknown> | undefined;
  if (filesys && typeof filesys === 'object' && 'shellWatch' in filesys && !('terminalWatch' in filesys)) {
    filesys.terminalWatch = filesys.shellWatch;
    delete filesys.shellWatch;
  }

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
    stat: (p: string) => {
      try {
        const st = fs.statSync(p);
        return { mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
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

export type { FsOps };
export type { LogLevel };
