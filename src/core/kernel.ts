// src/core/kernel.ts
// Microkernel 主类：组装所有内核服务，静态编排模块生命周期。
// 模块（modules）由内核直接静态 import，按固定顺序初始化、反向销毁。

import { reloadBackendResources, setBackendLocale, t } from './i18n';
import { detectEnvironment, isDevMode } from './env';
import { startupProfiler } from './startup-profiler';
import { watch, existsSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { createRootLogger, type RootLogger } from './logger';
import { installProcessGuards } from './process-guards';
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

// 关键路径模块静态导入（必须参与健康检查/首批对话）；
// deferred 模块改为动态 import（见 MODULE_FACTORIES 的 load 字段），
// 避免 voice/browser/computer/im/file-history 等代码进入启动静态闭包。
import llm from '../modules/llm';
import tools from '../modules/tools';
import mcp from '../modules/mcp';
import server from '../modules/server';
import agentBus from '../modules/agent-bus';
import agent from '../modules/agent';
import filesys from '../modules/filesys';
import terminal from '../modules/terminal';
import safety from '../modules/safety';
import context from '../modules/context';
import rules from '../modules/rules';
import hooks from '../modules/hooks';
import memory from '../modules/memory';

const MODULE_INIT_TIMEOUT_MS = 30_000;
const MODULE_DESTROY_TIMEOUT_MS = 10_000;

/**
 * deferred 模块聚合加载：全部 11 个模块共用一个动态 import promise。
 * 单个 chunk 只打开一次文件、只求值一次模块图，避免 11 次 chunk 加载开销。
 */
type DeferredModuleName = import('../modules/deferred-bundle').DeferredModuleName;
let deferredBundlePromise: Promise<Record<DeferredModuleName, () => Module>> | null = null;

function preloadDeferredBundle(): void {
  if (deferredBundlePromise) return;
  deferredBundlePromise = import('../modules/deferred-bundle').then((mod) => mod.deferredFactories);
}

function loadDeferredModule(name: DeferredModuleName): Promise<{ default: () => Module }> {
  preloadDeferredBundle();
  return deferredBundlePromise!.then((factories) => ({ default: factories[name] }));
}

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
  /** 关键路径模块：静态导入并同步实例化 */
  create?: () => Module;
  /** deferred 模块：动态 import，代码不进入启动静态闭包 */
  load?: () => Promise<{ default: () => Module }>;
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
  { name: 'remote', load: () => loadDeferredModule('remote'), deps: ['server'], phase: 'deferred' },
  { name: 'tools', create: tools, deps: [] },
  { name: 'mcp', create: mcp, deps: [] },
  { name: 'computer', load: () => loadDeferredModule('computer'), deps: [], phase: 'deferred' },
  { name: 'browser', load: () => loadDeferredModule('browser'), deps: ['computer'], phase: 'deferred' },
  { name: 'update', load: () => loadDeferredModule('update'), deps: [], phase: 'deferred' },
  { name: 'filesys', create: filesys, deps: [] },
  { name: 'terminal', create: terminal, deps: ['filesys'] },
  { name: 'safety', create: safety, deps: [] },
  { name: 'rules', create: rules, deps: [] },
  { name: 'hooks', create: hooks, deps: [] },
  { name: 'memory', create: memory, deps: [] },
  { name: 'voice', load: () => loadDeferredModule('voice'), deps: [], phase: 'deferred' },
  { name: 'context', create: context, deps: ['llm'] },
  { name: 'agent-bus', create: agentBus, deps: [] },
  { name: 'agent', create: agent, deps: ['tools', 'filesys', 'safety', 'rules', 'hooks', 'memory', 'context', 'agent-bus'] },
  { name: 'subagent', load: () => loadDeferredModule('subagent'), deps: ['agent', 'tools', 'agent-bus'], phase: 'deferred' },
  // im → server（路由注册在初始化时完成；消息到达时 tryResolve agent 执行，不阻塞 agent 初始化）
  { name: 'im', load: () => loadDeferredModule('im'), deps: ['server'], phase: 'deferred' },
  { name: 'file-history', load: () => loadDeferredModule('file-history'), deps: ['tools', 'filesys'], phase: 'deferred' },
  { name: 'daemon', load: () => loadDeferredModule('daemon'), deps: ['server'], phase: 'deferred' },
  { name: 'automation', load: () => loadDeferredModule('automation'), deps: ['agent', 'server'], phase: 'deferred' },
  // migration → agent（会话热写入经 tryResolve 运行时解析）
  { name: 'migration', load: () => loadDeferredModule('migration'), deps: ['agent', 'server'], phase: 'deferred' },
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
  /**
   * 是否注册进程级异常兜底（常驻服务传 true）。
   * 必须在模块初始化/预热之前生效，否则启动阶段的未处理拒绝仍会让进程退出。
   */
  processGuards?: boolean;
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

    // 启动仪表：从进程启动到 ready 的阶段耗时（不引入任何 IO）
    startupProfiler.mark('kernel.start');
    startupProfiler.startLagSampling();

    // 最早开始加载 deferred 聚合 chunk：与配置/关键模块初始化并发，藏在 IO 等待间隙
    preloadDeferredBundle();

    // 1. 初始化内核服务
    this.env = detectEnvironment();
    this.rootLogger = createRootLogger(this.env, options.logLevel ?? 'info');
    // 启动阶段控制台先缓存，ready 后一次性输出（避免逐行同步输出拖慢启动）
    this.rootLogger.console.startBuffering();
    this.logger = this.rootLogger.logger;
    // 进程级兜底必须尽早安装：配置加载 / 模块初始化 / 预热阶段的未处理拒绝也不能杀死后端
    if (options.processGuards === true) {
      installProcessGuards(this.logger);
    }
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
    startupProfiler.mark('config.start');
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
    startupProfiler.mark('config.end');

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
      // deferred 模块不在此实例化：动态 import 推迟到端口可用后，代码不进启动闭包
      if ((factory.phase ?? 'critical') === 'deferred') continue;
      if (!factory.create) {
        this.logger.warn('kernel: critical module missing create factory', { name: factory.name });
        continue;
      }
      const entry: ModuleEntry = { name: factory.name, instance: factory.create(), state: 'loaded' };
      this.modules.push(entry);
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
    const deferredFactories = MODULE_FACTORIES.filter(
      (f) => (f.phase ?? 'critical') === 'deferred' && !disabled.has(f.name),
    );

    // deferred 模块的代码解析与 critical 模块初始化并发进行：
    // 解析在 server 端口绑定等异步等待间隙完成，避免全部堆到 ready 之后。
    // 初始化本身仍由 readyGate 闸住（端口/健康接口先可用）。
    let releaseDeferredGate: () => void = () => {};
    const deferredReadyGate = new Promise<void>((resolve) => {
      releaseDeferredGate = resolve;
    });
    if (deferredFactories.length > 0) {
      startupProfiler.mark('deferred.preload');
      void this.initDeferredModules(
        deferredFactories,
        depsByName,
        disabled,
        settled,
        moduleCtx,
        deferredReadyGate,
      )
        .then(() => {
          startupProfiler.mark('deferred.ready');
          this.logger?.info(t('kernel.ready'), {
            activeModules: this.modules.filter((m) => m.state === 'active').length,
            deferredCompleted: true,
          });
          this.logger?.info('startup budget (deferred)', startupProfiler.summary());
        })
        .catch((err) => {
          this.logger?.warn('kernel: deferred modules init failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    await this.initModuleWave(criticalEntries, depsByName, disabled, settled, moduleCtx);
    startupProfiler.mark('critical.ready');

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
    startupProfiler.mark('kernel.ready');
    startupProfiler.stopLagSampling();

    const activeCount = this.modules.filter((m) => m.state === 'active').length;
    this.logger.info(t('kernel.ready'), {
      activeModules: activeCount,
      services: this.services.list(),
      deferredModules: deferredFactories.length,
    });
    this.logger.info('startup budget', startupProfiler.summary());
    this.rootLogger.console.flush();

    // critical 模块的后台预热：等 ready 后 300ms 启动，避免与首条消息抢 CPU
    setTimeout(() => {
      void this.runWarmups(criticalEntries, moduleCtx);
    }, 300);

    // 端口/健康接口已可用：放行 deferred 模块初始化（代码已在启动期并发解析）
    if (deferredFactories.length > 0) {
      startupProfiler.mark('deferred.start');
      setTimeout(releaseDeferredGate, 0);
    }

    return this.makeContext();
  }

  /**
   * 加载并初始化 deferred 模块：
   * - 并行动态 import（代码不进启动闭包），随后按依赖波次初始化；
   * - 单个模块 import/构造失败只记日志，并以 error 状态出现在 /api/health；
   * - 加载期间进程若已停机则放弃后续初始化（避免 stop 之后仍有模块注册服务）。
   */
  private async initDeferredModules(
    factories: Array<{
      name: string;
      create?: () => Module;
      load?: () => Promise<{ default: () => Module }>;
      deps: string[];
    }>,
    depsByName: Map<string, string[]>,
    disabled: Set<string>,
    settled: Set<string>,
    moduleCtx: ModuleContext,
    readyGate: Promise<void>,
  ): Promise<void> {
    const loaded = await Promise.all(
      factories.map(async (factory) => {
        try {
          const mod = factory.load ? await factory.load() : null;
          const create = factory.create ?? mod?.default;
          if (!create) throw new Error('module has no factory export');
          return { name: factory.name, instance: create() };
        } catch (err) {
          moduleCtx.logger.error(t('kernel.moduleInitFailed', { name: factory.name }), {
            error: err instanceof Error ? err.message : String(err),
          });
          // 失败模块以 error 状态登记，保证 /api/health 的模块状态是真实的
          this.modules.push({
            name: factory.name,
            instance: { initialize: async () => {} },
            state: 'error',
          });
          settled.add(factory.name);
          return null;
        }
      }),
    );

    // 端口与 /api/health 就绪后再初始化（加载代码本身已并发完成）
    await readyGate;
    if (!this.started) return;

    const entries: ModuleEntry[] = [];
    for (const item of loaded) {
      if (!item) continue;
      const entry: ModuleEntry = { name: item.name, instance: item.instance, state: 'loaded' };
      this.modules.push(entry);
      entries.push(entry);
    }
    await this.initModuleWave(entries, depsByName, disabled, settled, moduleCtx);
    // deferred 模块就绪后再跑各自的后台预热
    void this.runWarmups(entries, moduleCtx);
  }

  /**
   * 运行模块的后台预热（不阻塞启动、不参与 3s 验收）。
   * 单个失败只记日志；加载期间已停机则跳过。
   */
  private async runWarmups(entries: ModuleEntry[], moduleCtx: ModuleContext): Promise<void> {
    const targets = entries.filter((e) => e.state === 'active' && typeof e.instance.warmup === 'function');
    if (targets.length === 0 || !this.started) return;
    await Promise.allSettled(
      targets.map(async (entry) => {
        const startedAt = performance.now();
        try {
          await entry.instance.warmup!(moduleCtx);
          moduleCtx.logger.debug('kernel: module warmup done', {
            name: entry.name,
            durationMs: Math.round(performance.now() - startedAt),
          });
        } catch (err) {
          moduleCtx.logger.warn('kernel: module warmup failed', {
            name: entry.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
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
          // 同步段结束时刻：initialize 是 async，调用后返回 Promise 时同步阻塞已结束
          let syncEndAt = startedAt;
          try {
            const initPromise = entry.instance.initialize(moduleCtx);
            syncEndAt = performance.now();
            await this.withTimeout(
              initPromise,
              MODULE_INIT_TIMEOUT_MS,
              `initialize(module:${entry.name})`,
            );
            entry.state = 'active';
            moduleCtx.logger.info(t('kernel.moduleActivated', { name: entry.name }), {
              durationMs: Math.round(performance.now() - startedAt),
              syncMs: Math.round(syncEndAt - startedAt),
            });
          } catch (err) {
            entry.state = 'error';
            moduleCtx.logger.error(t('kernel.moduleInitFailed', { name: entry.name }), {
              error: err instanceof Error ? err.message : String(err),
            });
          } finally {
            startupProfiler.recordModule(entry.name, startedAt, syncEndAt, performance.now());
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
    // 停机：控制台补输出 + 等待日志队列落盘（异步写不丢尾部日志）
    this.rootLogger?.console.flush();
    await this.rootLogger?.writer.flush().catch(() => {});
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
    // 生产运行不监听源码文案目录：既无意义又增加启动期 watcher 开销
    if (!isDevMode()) return;
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
