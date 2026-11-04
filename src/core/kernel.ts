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
import subagent from '../modules/subagent';
import update from '../modules/update';
import agent from '../modules/agent';
import im from '../modules/im';
import filesys from '../modules/filesys';
import terminal from '../modules/terminal';
import computer from '../modules/computer';
import browser from '../modules/browser';
import safety from '../modules/safety';
import fileHistory from '../modules/file-history';
import daemon from '../modules/daemon';
import automation from '../modules/automation';
import context from '../modules/context';
import rules from '../modules/rules';
import hooks from '../modules/hooks';
import memory from '../modules/memory';
import voice from '../modules/voice';
import migration from '../modules/migration';

const MODULE_INIT_TIMEOUT_MS = 30_000;
const MODULE_DESTROY_TIMEOUT_MS = 10_000;

/**
 * 模块依赖声明（name → 必须先 active 的模块）。
 * 初始化按拓扑波次并行执行：同波模块互不依赖，可同时初始化；
 * 依赖失败/超时的模块仍会初始化（由各模块 tryResolve 降级），避免一处失败拖死全链路。
 *
 * 关键路径：server 无依赖 → 第一波立即监听端口；tools/filesys 等同波并行；
 * agent 只依赖真正需要的服务模块，不再被 voice/browser/im 等慢模块串行拖累。
 */
const MODULE_FACTORIES: Array<{
  name: string;
  create: () => Module;
  deps: string[];
  /**
   * 初始化档位：
   * - critical（缺省）：阻塞 `kernel.start()`，健康接口/对话核心依赖它们；
   * - deferred：critical 就绪、端口可用之后再空闲初始化，不拖慢启动。
   * critical 模块若依赖 deferred，依赖闭包会自动把它提升为 critical。
   */
  phase?: 'critical' | 'deferred';
}> = [
  { name: 'llm', create: llm, deps: [] },
  { name: 'server', create: server, deps: [] },
  { name: 'remote', create: remote, deps: ['server'], phase: 'deferred' },
  { name: 'tools', create: tools, deps: [] },
  { name: 'mcp', create: mcp, deps: [] },
  { name: 'computer', create: computer, deps: [], phase: 'deferred' },
  { name: 'browser', create: browser, deps: ['computer'], phase: 'deferred' },
  { name: 'update', create: update, deps: [], phase: 'deferred' },
  { name: 'filesys', create: filesys, deps: [] },
  { name: 'terminal', create: terminal, deps: ['filesys'] },
  { name: 'safety', create: safety, deps: [] },
  { name: 'rules', create: rules, deps: [] },
  { name: 'hooks', create: hooks, deps: [] },
  { name: 'memory', create: memory, deps: [] },
  { name: 'voice', create: voice, deps: [], phase: 'deferred' },
  { name: 'context', create: context, deps: ['llm'] },
  { name: 'agent', create: agent, deps: ['tools', 'filesys', 'safety', 'rules', 'hooks', 'memory', 'context'] },
  { name: 'subagent', create: subagent, deps: ['agent', 'tools'], phase: 'deferred' },
  // im → server（路由注册在初始化时完成；消息到达时 tryResolve agent 执行，不阻塞 agent 初始化）
  { name: 'im', create: im, deps: ['server'], phase: 'deferred' },
  { name: 'file-history', create: fileHistory, deps: ['tools', 'filesys'], phase: 'deferred' },
  { name: 'daemon', create: daemon, deps: ['server'], phase: 'deferred' },
  { name: 'automation', create: automation, deps: ['agent', 'server'], phase: 'deferred' },
  // migration → agent（会话热写入经 tryResolve 运行时解析）
  { name: 'migration', create: migration, deps: ['agent', 'server'], phase: 'deferred' },
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
      // 过期日志清理（文件扫描/删除）延后到端口可用后，不阻塞启动
      const removed = 0;
      this.logger.info(t('kernel.configLoaded'), { logLevel: logsCfg.level, expiredLogsRemoved: removed });
      setTimeout(() => {
        try {
          this.rootLogger?.writer.cleanupNow();
        } catch {
          // 清理失败不影响运行
        }
      }, 100);
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

    // 拓扑波次并行初始化：同波模块无相互依赖，可同时初始化。
    // 先初始化 critical 档（端口/对话核心），deferred 档在返回后再空闲初始化。
    // settled 同时包含 active 与 error（失败模块视为“已结算”，避免依赖方永远等待）。
    const depsByName = new Map(MODULE_FACTORIES.map((f) => [f.name, f.deps]));
    const settled = new Set<string>();

    // critical 依赖闭包：critical 模块若依赖 deferred 模块，把该依赖一并提升为 critical，
    // 保证「启动返回时核心链路所需服务都已注册」。
    const criticalNames = new Set(
      MODULE_FACTORIES.filter((f) => (f.phase ?? 'critical') === 'critical').map((f) => f.name),
    );
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const name of Array.from(criticalNames)) {
        for (const dep of depsByName.get(name) ?? []) {
          if (!criticalNames.has(dep) && !disabled.has(dep) && depsByName.has(dep)) {
            criticalNames.add(dep);
            expanded = true;
          }
        }
      }
    }

    const criticalEntries = this.modules.filter((m) => criticalNames.has(m.name));
    const deferredEntries = this.modules.filter((m) => !criticalNames.has(m.name));
    await this.initModuleWave(criticalEntries, depsByName, disabled, settled, moduleCtx);

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
      deferredModules: deferredEntries.length,
    });

    // deferred 档在端口可用、启动返回后再初始化（不阻塞 /api/health 与首屏）。
    // 失败只记日志，不影响已就绪的核心功能；各模块自身对缺失服务有 tryResolve 降级。
    if (deferredEntries.length > 0) {
      setTimeout(() => {
        void this.initModuleWave(deferredEntries, depsByName, disabled, settled, moduleCtx)
          .then(() => {
            this.logger?.info(t('kernel.ready'), {
              activeModules: this.modules.filter((m) => m.state === 'active').length,
              deferredCompleted: true,
            });
          })
          .catch((err) => {
            this.logger?.warn('kernel: deferred modules init failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }, 50);
    }

    return this.makeContext();
  }

  /**
   * 按拓扑波次并行初始化一组模块。
   * settled 跨批次共享：deferred 批次能看到 critical 已结算的模块，不必重复等待。
   */
  private async initModuleWave(
    entries: ModuleEntry[],
    depsByName: Map<string, string[]>,
    disabled: Set<string>,
    settled: Set<string>,
    moduleCtx: ModuleContext,
  ): Promise<void> {
    const pending = [...entries];
    while (pending.length > 0) {
      const ready = pending.filter((entry) => {
        const deps = depsByName.get(entry.name) ?? [];
        return deps.every((dep) => disabled.has(dep) || !depsByName.has(dep) || settled.has(dep));
      });
      // 依赖成环/声明错误时兜底：剩余模块一次性并行初始化，绝不阻塞启动。
      const wave = ready.length > 0 ? ready : pending.splice(0, pending.length);
      if (ready.length > 0) {
        for (const entry of ready) pending.splice(pending.indexOf(entry), 1);
      }
      await Promise.all(
        wave.map(async (entry) => {
          entry.state = 'initializing';
          const startedAt = performance.now();
          try {
            await this.withTimeout(
              entry.instance.initialize(moduleCtx),
              MODULE_INIT_TIMEOUT_MS,
              `initialize(module:${entry.name})`,
            );
            entry.state = 'active';
            moduleCtx.logger.info(t('kernel.moduleActivated', { name: entry.name }), {
              durationMs: Math.round(performance.now() - startedAt),
            });
          } catch (err) {
            entry.state = 'error';
            moduleCtx.logger.error(t('kernel.moduleInitFailed', { name: entry.name }), {
              error: err instanceof Error ? err.message : String(err),
            });
          } finally {
            settled.add(entry.name);
          }
        }),
      );
    }
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
