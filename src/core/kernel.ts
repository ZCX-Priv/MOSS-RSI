// src/core/kernel.ts
// Microkernel 主类：组装所有内核服务，静态编排模块生命周期。
// 模块（modules）由内核直接静态 import，按固定顺序初始化、反向销毁。

import { reloadBackendResources, setBackendLocale, t } from './i18n';
import { detectEnvironment } from './env';
import { watch, existsSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { createRootLogger, type RootLogger } from './logger';
import { createEventBus } from './event-bus';
import { createServiceRegistry } from './service-registry';
import { createConfigService } from './config-service';
import { ServiceNames } from './types';
import type {
  AppConfig,
  KernelContext,
  Logger,
  EventBus,
  ServiceRegistry,
  ConfigService,
  Environment,
  Module,
  ModuleContext,
  LogLevel,
} from './types';

import llm from '../modules/llm';
import tools from '../modules/tools';
import mcp from '../modules/mcp';
import server from '../modules/server';
import remote from '../modules/remote';
import agenteam from '../modules/agenteam';
import update from '../modules/update';
import agent from '../modules/agent';
import filesys from '../modules/filesys';
import terminal from '../modules/terminal';
import safety from '../modules/safety';
import fileHistory from '../modules/file-history';
import daemon from '../modules/daemon';
import automation from '../modules/automation';
import context from '../modules/context';
import rules from '../modules/rules';
import hooks from '../modules/hooks';
import memory from '../modules/memory';
import voice from '../modules/voice';

const MODULE_INIT_TIMEOUT_MS = 30_000;
const MODULE_DESTROY_TIMEOUT_MS = 10_000;

/**
 * 静态模块注册表：固定初始化顺序满足依赖关系（被依赖者在前）。
 * - llm / server / update：无依赖。server 前移到第 2 位：其全部路由
 *   handler 均为请求时 tryResolve（运行时解析），health/静态页可秒级就绪，
 *   不必等待 tools 动态加载与 MCP 连接（启动性能关键路径）。
 * - remote → server（注入请求门卫 + 注册 /api/remote/* 路由 + 热重绑句柄；
 *   门卫未注入时 server 零开销直通，不阻塞端口可用）
 * - tools / mcp：加载与连接较慢（工具动态 import / MCP 子进程握手），
 *   排在 server 之后不阻塞端口可用；MCP 连接本身已后台化。
 * - filesys → 无服务依赖（agent 构造时订阅其事件总线，须先于 agent 注册）
 * - terminal → filesys（cwd 边界由调用方校验）；无其他依赖，须先于 agent/tools 使用前注册
 * - safety → 无服务依赖（agent 执行工具前统一权限决策，须先于 agent 注册）
 * - rules / hooks / memory → 无服务依赖（context/agent 经 tryResolve 消费，须先于二者注册）
 * - context → llm（压缩摘要调用 LLMRouter；agent 每轮请求经其流水线，须先于 agent 注册）
 * - agent → llm, tools, filesys, safety, context, rules, hooks, memory
 * - agenteam → agent（编排服务复用 AgentEngine 派发成员任务；registry 部分无依赖，
 *   但模块整体须后于 agent 注册；server 的 /api/agenteams 路由为请求时 tryResolve，不受影响）
 * - file-history → tools, filesys（终端快照回填运行时 tryResolve）
 * - daemon → server
 * - automation → agent, server
 */
const MODULE_FACTORIES: Array<{ name: string; create: () => Module }> = [
  { name: 'llm', create: llm },
  { name: 'server', create: server },
  { name: 'remote', create: remote },
  { name: 'tools', create: tools },
  { name: 'mcp', create: mcp },
  { name: 'update', create: update },
  { name: 'filesys', create: filesys },
  { name: 'terminal', create: terminal },
  { name: 'safety', create: safety },
  { name: 'rules', create: rules },
  { name: 'hooks', create: hooks },
  { name: 'memory', create: memory },
  { name: 'voice', create: voice },
  { name: 'context', create: context },
  { name: 'agent', create: agent },
  { name: 'agenteam', create: agenteam },
  { name: 'file-history', create: fileHistory },
  { name: 'daemon', create: daemon },
  { name: 'automation', create: automation },
];

type ModuleState = 'loaded' | 'initializing' | 'active' | 'destroying' | 'shutdown' | 'error';

interface ModuleEntry {
  name: string;
  instance: Module;
  state: ModuleState;
}

export interface KernelStartOptions {
  /** 前台运行（不 detach） */
  foreground?: boolean;
  /** 初始日志级别 */
  logLevel?: LogLevel;
  /**
   * 需要跳过的模块名（MODULE_FACTORIES 中的 name）。
   * 用于无 HTTP 服务的轻量入口，如 `moss mcp`（stdio MCP 服务器）：
   * 不能起 server/remote（会与常驻 MOSS 抢端口），也不需要 daemon/automation/update。
   */
  disabledModules?: string[];
}

export class Microkernel {
  private env: Environment | null = null;
  private logger: Logger | null = null;
  private rootLogger: RootLogger | null = null;
  private eventBus: EventBus | null = null;
  private services: ServiceRegistry | null = null;
  private config: ConfigService | null = null;
  private readonly modules: ModuleEntry[] = [];
  private i18nWatcher?: FSWatcher;
  private started = false;

  async start(options: KernelStartOptions = {}): Promise<KernelContext> {
    if (this.started) {
      throw new Error(t('kernel.alreadyStarted'));
    }

    // 1. 初始化内核服务
    this.env = detectEnvironment();
    this.rootLogger = createRootLogger(this.env, options.logLevel ?? 'info');
    this.logger = this.rootLogger.logger;
    this.logger.info(t('kernel.starting'), {
      platform: this.env.platform,
      arch: this.env.arch,
      bunVersion: this.env.runtimeVersion,
      pid: this.env.pid,
      dataDir: this.env.dataDir,
    });

    this.eventBus = createEventBus(this.logger);
    this.services = createServiceRegistry(this.logger);

    // 2. 加载配置
    this.config = createConfigService(this.env, this.eventBus, this.logger);
    try {
      await this.config.load();
      setBackendLocale(this.config.getAppConfig().server.locale === 'en' ? 'en' : 'zh');
      // 启动 i18n 资源目录 watcher，实现运行期文案就地热重载
      this.startBackendI18nWatcher();
      // 应用配置中的日志级别与文件策略，并清理一次过期日志
      const logsCfg = this.config.getAppConfig().logs;
      this.applyLogsConfig(logsCfg);
      const removed = this.rootLogger.writer.cleanupNow();
      this.logger.info(t('kernel.configLoaded'), { logLevel: logsCfg.level, expiredLogsRemoved: removed });
    } catch (err) {
      this.logger.error(t('kernel.configLoadFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
      // 真正回退到默认配置，避免后续所有模块因 "Config not loaded" 连锁失败
      this.config.loadDefaults();
      this.applyLogsConfig(this.config.getAppConfig().logs);
    }

    // 订阅 config:changed：日志级别/文件策略热更新（无需重启）
    this.eventBus.onAction('config:changed', (data) => {
      const which = (data as { which?: string } | null)?.which;
      if (which && which !== 'app') return;
      this.applyLogsConfig(this.config!.getAppConfig().logs);
    });

    // 3. 构建模块上下文（完整能力）
    const moduleCtx: ModuleContext = {
      logger: this.logger,
      config: this.config,
      eventBus: this.eventBus,
      services: this.services,
      env: this.env,
    };

    // 注册配置服务（工具运行时读取 config.json/api.json，如 web 工具解析搜索服务商）
    this.services.register(ServiceNames.CONFIG_SERVICE, this.config, { scope: 'kernel' });

    // 4. 静态实例化并按序初始化模块（失败记日志并继续，与原拓扑编排韧性一致）
    const disabled = new Set(options.disabledModules ?? []);
    for (const factory of MODULE_FACTORIES) {
      if (disabled.has(factory.name)) {
        this.logger.debug('module disabled by start options', { name: factory.name });
        continue;
      }
      this.modules.push({ name: factory.name, instance: factory.create(), state: 'loaded' });
    }

    for (const entry of this.modules) {
      entry.state = 'initializing';
      try {
        await this.withTimeout(
          entry.instance.initialize(moduleCtx),
          MODULE_INIT_TIMEOUT_MS,
          `initialize(module:${entry.name})`,
        );
        entry.state = 'active';
        this.logger.info(t('kernel.moduleActivated', { name: entry.name }));
      } catch (err) {
        entry.state = 'error';
        this.logger.error(t('kernel.moduleInitFailed', { name: entry.name }), {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 暴露模块状态服务（供 health 路由使用）
    this.services.register(
      'kernel.modules',
      {
        getList: (): Array<{ name: string; state: ModuleState }> =>
          this.modules.map((m) => ({ name: m.name, state: m.state })),
      },
      { scope: 'kernel' },
    );

    // 暴露日志服务（供 /api/logs 路由使用：文件枚举 / 查询过滤 / 清理 / 级别调整）
    this.services.register(ServiceNames.LOGGER, this.rootLogger.service, { scope: 'kernel' });

    this.started = true;
    await this.eventBus.broadcast('kernel:ready', { pid: this.env.pid });

    const activeCount = this.modules.filter((m) => m.state === 'active').length;
    this.logger.info(t('kernel.ready'), {
      activeModules: activeCount,
      services: this.services.list(),
    });

    return this.makeContext();
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.logger?.info(t('kernel.stopping'));
    await this.eventBus?.broadcast('kernel:shutdown', {});

    // 反向顺序销毁
    for (const entry of [...this.modules].reverse()) {
      if (entry.state !== 'active') continue;
      entry.state = 'destroying';
      try {
        if (entry.instance.destroy) {
          await this.withTimeout(
            entry.instance.destroy(),
            MODULE_DESTROY_TIMEOUT_MS,
            `destroy(module:${entry.name})`,
          );
        }
        this.services?.unregisterScope(entry.name);
        this.eventBus?.offAll(entry.name);
        entry.state = 'shutdown';
        this.logger?.info(t('kernel.moduleDestroyed', { name: entry.name }));
      } catch (err) {
        entry.state = 'error';
        this.logger?.error(t('kernel.moduleDestroyFailed', { name: entry.name }), {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.i18nWatcher?.close();
    this.i18nWatcher = undefined;
    this.started = false;
    this.logger?.info(t('kernel.stopped'));
  }

  isStarted(): boolean {
    return this.started;
  }

  /** 应用 config.logs（级别 + 文件策略）到根日志器（启动与 config:changed 热更新共用） */
  private applyLogsConfig(logsCfg: AppConfig['logs']): void {
    if (!this.logger || !this.rootLogger) return;
    if (this.logger.getLevel() !== logsCfg.level) {
      this.logger.setLevel(logsCfg.level);
    }
    this.rootLogger.writer.setPolicy({
      maxFileBytes: Math.round(logsCfg.maxFileMb * 1024 * 1024),
      retentionDays: logsCfg.retentionDays,
    });
  }

  /**
   * 启动对后端 i18n 资源目录（src/core/i18n/locales/）的防抖 watcher。
   * 变更时调用 reloadBackendResources() 就地重载，让运行中的 t() 立即反映磁盘文案改动。
   * 仅当目录存在（开发/未打包场景）时生效；失败仅记日志，不阻断启动。
   */
  private startBackendI18nWatcher(): void {
    if (!this.env || !this.logger) return;
    const dir = join(this.env.packageRoot, 'src', 'core', 'i18n', 'locales');
    if (!existsSync(dir)) {
      this.logger.debug('i18n locale dir not found, skipping watcher', { dir });
      return;
    }
    let debounce: ReturnType<typeof setTimeout> | null = null;
    try {
      this.i18nWatcher = watch(dir, { recursive: true }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          reloadBackendResources().catch(err => {
            this.logger?.warn('i18n reload failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, 300);
      });
      this.logger.debug('i18n locale watcher started', { dir });
    } catch (err) {
      this.logger.warn('i18n locale watcher start failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Operation "${label}" timed out after ${ms}ms`)),
        ms,
      );
    });
    try {
      return Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private makeContext(): KernelContext {
    if (!this.logger || !this.config || !this.eventBus || !this.services || !this.env) {
      throw new Error(t('kernel.notInitialized'));
    }
    return {
      logger: this.logger,
      config: this.config,
      eventBus: this.eventBus,
      services: this.services,
      env: this.env,
      kernel: {
        stop: () => this.stop(),
      },
    };
  }
}
