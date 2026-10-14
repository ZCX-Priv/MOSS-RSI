// src/modules/context/file-index/service.ts
// FileIndexService：三引擎生命周期编排。
//   - 多项目实例（Map<cwd, ProjectRuntime>，LRU≤3，淘汰时停 watcher 保数据）
//   - 配置热重载响应（开关变化 → 引擎启停）
//   - 状态聚合 + WS 广播（节流 500ms）
//   - 对外：status/rebuild/queryFiles/listFiles/impactHint/projectOverview/search

import { Glob } from 'bun';
import type { ConfigService, Environment, Logger, ServiceRegistry } from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import type { LLMRouter } from '../../contracts';
import type { Environment as EnvType } from '../../../core/types';
import { IndexEngine } from './index-engine/engine';
import type { FileQuery, FileQueryResult } from './index-engine/query';
import { GraphEngine } from './graph-engine/engine';
import { queryImpact, renderImpactText } from './graph-engine/impact';
import { SagEngine } from './sag-engine/engine';
import { IgnoreGlobs } from './shared/ignore';
import { SYSTEM_SCOPE, ensureProjectDirs } from './shared/store';
import type {
  FileEntry,
  FileIndexConfig,
  FileIndexStatus,
  SagSearchResult,
} from './types';
import { normalizeFileIndexConfig } from './types';

/** 项目运行时（三引擎实例集合） */
interface ProjectRuntime {
  cwd: string;
  indexEngine: IndexEngine;
  graphEngine: GraphEngine | null;
  sagEngine: SagEngine | null;
  /** LRU 时间戳（最近访问） */
  lastUsed: number;
  /** 生成序号（防旧启停任务竞态） */
  generation: number;
}

const MAX_ACTIVE_PROJECTS = 3;
const BROADCAST_THROTTLE_MS = 500;

export interface FileIndexServiceDeps {
  env: Environment;
  config: ConfigService;
  services: ServiceRegistry;
  logger: Logger;
}

export class FileIndexService {
  private readonly env: EnvType;
  private readonly config: ConfigService;
  private readonly services: ServiceRegistry;
  private readonly logger: Logger;
  private readonly projects = new Map<string, ProjectRuntime>();
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(deps: FileIndexServiceDeps) {
    this.env = deps.env;
    this.config = deps.config;
    this.services = deps.services;
    this.logger = deps.logger;
  }

  // ==========================================================================
  // 配置
  // ==========================================================================

  /** 实时读取文件索引配置（含依赖联动规格化） */
  getConfig(): FileIndexConfig {
    const app = this.config.getAppConfig() as { context?: { fileIndex?: unknown } };
    return normalizeFileIndexConfig(app.context?.fileIndex);
  }

  /**
   * 配置热重载入口（config:changed 时由 api/service 调用）：
   * 对已激活项目按新配置启停引擎。
   */
  async applyConfigChange(): Promise<void> {
    const cfg = this.getConfig();
    for (const runtime of this.projects.values()) {
      await this.syncRuntimeEngines(runtime, cfg);
    }
  }

  // ==========================================================================
  // 项目管理
  // ==========================================================================

  /** 确保 cwd 的项目索引运行时存在并按配置启动（后台，不阻塞） */
  async ensureProject(cwd: string): Promise<ProjectRuntime | null> {
    if (!cwd || cwd === SYSTEM_SCOPE) return null; // 系统作用域无单一项目根 → 不建索引
    const cfg = this.getConfig();
    if (!cfg.indexing.enabled) return null; // 索引引擎关闭 → 整个模块不激活
    const existing = this.projects.get(cwd);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    await this.evictIfNeeded();
    return this.createRuntime(cwd, cfg);
  }

  private async createRuntime(cwd: string, cfg: FileIndexConfig): Promise<ProjectRuntime> {
    const dirs = ensureProjectDirs(cwd);
    const customIgnore = IgnoreGlobs.compile(cfg.ignore);
    const runtime: ProjectRuntime = {
      cwd,
      indexEngine: new IndexEngine(cwd, dirs.indexList, customIgnore, {
        env: this.env,
        logger: this.logger,
        onStatusChange: () => this.scheduleBroadcast(),
      }),
      graphEngine: null,
      sagEngine: null,
      lastUsed: Date.now(),
      generation: 0,
    };
    this.projects.set(cwd, runtime);
    await this.syncRuntimeEngines(runtime, cfg);
    return runtime;
  }

  /** 按配置同步项目引擎启停（幂等；generation 防竞态） */
  private async syncRuntimeEngines(runtime: ProjectRuntime, cfg: FileIndexConfig): Promise<void> {
    const gen = ++runtime.generation;
    const isStale = (): boolean => gen !== runtime.generation || this.disposed;

    if (!cfg.indexing.enabled) {
      // 总开关关闭：全部停用（保数据）
      await runtime.indexEngine.stop();
      if (runtime.graphEngine) {
        await runtime.graphEngine.stop();
        runtime.graphEngine = null;
      }
      if (runtime.sagEngine) {
        await runtime.sagEngine.stop();
        runtime.sagEngine = null;
      }
      this.scheduleBroadcast();
      return;
    }

    // 索引引擎：确保启动
    await runtime.indexEngine.start();

    // 图谱引擎
    if (cfg.graph.enabled && !runtime.graphEngine) {
      const dirs = ensureProjectDirs(runtime.cwd);
      runtime.graphEngine = new GraphEngine(runtime.cwd, dirs.graph, runtime.indexEngine, {
        env: this.env,
        logger: this.logger,
        onStatusChange: () => this.scheduleBroadcast(),
      });
      void runtime.graphEngine.start().catch(err => {
        this.logger.warn('file-index: graph engine start failed', {
          cwd: runtime.cwd,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    } else if (!cfg.graph.enabled && runtime.graphEngine) {
      await runtime.graphEngine.stop();
      runtime.graphEngine = null;
    }

    // SAG 引擎
    if (cfg.sag.enabled && !runtime.sagEngine) {
      const dirs = ensureProjectDirs(runtime.cwd);
      runtime.sagEngine = new SagEngine(
        runtime.cwd,
        dirs.sag,
        cfg.sag,
        runtime.indexEngine,
        runtime.graphEngine,
        this.services.tryResolve<LLMRouter>(ServiceNames.LLM_ROUTER),
        () => this.resolveMainModel(),
        { env: this.env, logger: this.logger, onStatusChange: () => this.scheduleBroadcast() },
      );
      void runtime.sagEngine.start().catch(err => {
        this.logger.warn('file-index: sag engine start failed', {
          cwd: runtime.cwd,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    } else if (!cfg.sag.enabled && runtime.sagEngine) {
      await runtime.sagEngine.stop();
      runtime.sagEngine = null;
    } else if (cfg.sag.enabled && runtime.sagEngine && !isStale()) {
      // 配置可能变化（预算/模型）——预算热更新在运行中生效（下一次批次读取）
    }
    this.scheduleBroadcast();
  }

  /** LRU 淘汰（超出上限时停最久未用的项目；数据保留） */
  private async evictIfNeeded(): Promise<void> {
    while (this.projects.size >= MAX_ACTIVE_PROJECTS) {
      let oldest: ProjectRuntime | null = null;
      for (const r of this.projects.values()) {
        if (!oldest || r.lastUsed < oldest.lastUsed) oldest = r;
      }
      if (!oldest) return;
      await this.stopRuntime(oldest);
      this.projects.delete(oldest.cwd);
      this.logger.info('file-index: LRU 淘汰项目索引实例', { cwd: oldest.cwd });
    }
  }

  private async stopRuntime(runtime: ProjectRuntime): Promise<void> {
    runtime.generation++;
    if (runtime.sagEngine) await runtime.sagEngine.stop();
    if (runtime.graphEngine) await runtime.graphEngine.stop();
    await runtime.indexEngine.stop();
  }

  /** 关闭全部（模块 destroy 时） */
  async stopAll(): Promise<void> {
    this.disposed = true;
    for (const runtime of this.projects.values()) {
      await this.stopRuntime(runtime);
    }
    this.projects.clear();
  }

  // ==========================================================================
  // 状态与重建
  // ==========================================================================

  /** 聚合项目状态（无运行时 → disabled 占位） */
  async status(cwd: string): Promise<FileIndexStatus> {
    const cfg = this.getConfig();
    const runtime = this.projects.get(cwd) ?? null;
    if (!runtime) {
      return {
        projectRoot: cwd,
        indexing: {
          enabled: cfg.indexing.enabled,
          state: 'disabled',
          progress: null,
          fileCount: 0,
          dirCount: 0,
          storeBytes: 0,
          error: null,
        },
        graph: {
          enabled: cfg.graph.enabled,
          state: 'disabled',
          progress: null,
          fileCount: 0,
          symbolCount: 0,
          edgeCount: 0,
          storeBytes: 0,
          error: null,
        },
        sag: {
          enabled: cfg.sag.enabled,
          state: 'disabled',
          progress: null,
          chunkCount: 0,
          eventCount: 0,
          entityCount: 0,
          llmExtracted: 0,
          llmBudget: cfg.sag.llmMaxChunks,
          storeBytes: 0,
          error: null,
        },
      };
    }
    const idx = runtime.indexEngine.status;
    const graph = runtime.graphEngine?.status ?? {
      enabled: cfg.graph.enabled,
      state: 'disabled' as const,
      progress: null,
      fileCount: 0,
      symbolCount: 0,
      edgeCount: 0,
      storeBytes: 0,
      error: null,
    };
    const sag = runtime.sagEngine?.status ?? {
      enabled: cfg.sag.enabled,
      state: 'disabled' as const,
      progress: null,
      chunkCount: 0,
      eventCount: 0,
      entityCount: 0,
      llmExtracted: 0,
      llmBudget: cfg.sag.llmMaxChunks,
      storeBytes: 0,
      error: null,
    };
    return { projectRoot: cwd, indexing: { ...idx }, graph, sag };
  }

  /** 手动重建（清空数据重新构建，后台执行） */
  async rebuild(cwd: string, engines: Array<'indexing' | 'graph' | 'sag'>): Promise<boolean> {
    const runtime = this.projects.get(cwd) ?? (await this.ensureProject(cwd));
    if (!runtime) return false;
    // 重建顺序：索引 → 图谱 → SAG（后两者依赖前者文件列表）
    if (engines.includes('indexing')) {
      await runtime.indexEngine.stop();
      await runtime.indexEngine.start();
    }
    if (engines.includes('graph') && runtime.graphEngine) {
      await runtime.graphEngine.rebuild();
    }
    if (engines.includes('sag') && runtime.sagEngine) {
      await runtime.sagEngine.rebuild();
    }
    return true;
  }

  // ==========================================================================
  // 查询接口（glob/grep 工具 / 上下文注入）
  // ==========================================================================

  /** glob 查询（索引引擎 ready 时可用） */
  async queryFiles(cwd: string, q: FileQuery): Promise<FileQueryResult | null> {
    const runtime = this.projects.get(cwd);
    if (!runtime || !runtime.indexEngine.ready) return null;
    return runtime.indexEngine.query(q);
  }

  /** 文本文件枚举（grep 加速） */
  async listTextFiles(cwd: string): Promise<FileEntry[] | null> {
    const runtime = this.projects.get(cwd);
    if (!runtime || !runtime.indexEngine.ready) return null;
    const out: FileEntry[] = [];
    for (const e of runtime.indexEngine.entries.values()) {
      if (e.isDir || e.kind === 'binary') continue;
      out.push(e);
    }
    return out;
  }

  /** 影响面文本（edit/write 工具结果附加段；图谱未就绪返回 null） */
  async impactHint(cwd: string, relPath: string): Promise<string | null> {
    const runtime = this.projects.get(cwd);
    if (!runtime?.graphEngine?.ready) return null;
    const store = runtime.graphEngine.graphStore;
    if (!store) return null;
    const key = relPath.toLowerCase();
    const impact = queryImpact(store, key);
    return renderImpactText(impact);
  }

  /** SAG 检索（多跳语义关联） */
  async search(cwd: string, query: string, topK?: number): Promise<SagSearchResult[]> {
    const runtime = this.projects.get(cwd);
    if (!runtime?.sagEngine?.ready) return [];
    return runtime.sagEngine.search(query, topK);
  }

  /** 项目概要文本（会话锚定消息注入；索引未就绪返回占位） */
  async projectOverview(cwd: string): Promise<string | null> {
    const cfg = this.getConfig();
    if (!cfg.indexing.enabled) return null;
    const runtime = this.projects.get(cwd) ?? (await this.ensureProject(cwd));
    if (!runtime) return null;
    const idx = runtime.indexEngine.status;
    const graph = runtime.graphEngine;
    const sag = runtime.sagEngine;

    const lines: string[] = ['[项目概要]'];
    if (idx.state !== 'ready') {
      lines.push('文件索引构建中，本轮暂无项目结构概要。');
      return lines.join('\n');
    }
    lines.push(`结构：${idx.fileCount} 个文件 / ${idx.dirCount} 个目录。`);

    if (graph?.ready) {
      const store = graph.graphStore;
      if (store) {
        const hubs = store.hubFiles(5);
        if (hubs.length > 0) {
          lines.push(`核心模块（被依赖最多）：${hubs.map(h => `${h.rel}(${h.importers})`).join('、')}。`);
        }
      }
    }
    if (sag?.ready) {
      const top = sag.topEntities(10);
      if (top.length > 0) {
        lines.push(`核心概念：${top.map(e => e.name).join('、')}。`);
      }
    }
    const text = lines.join('\n');
    // ≤600 token 近似（中文 1 字 ≈ 0.6 token；保守按字符 1200 截断）
    return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
  }

  /** 模块整体是否激活（任一引擎开启） */
  isModuleActive(): boolean {
    return this.getConfig().indexing.enabled;
  }

  // ==========================================================================
  // 内部
  // ==========================================================================

  private resolveMainModel(): string {
    try {
      return this.config.getAppConfig().agent.defaultModel || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** WS 广播（节流 500ms；广播所有激活项目的状态） */
  private scheduleBroadcast(): void {
    if (this.disposed || this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      void this.broadcastStatuses();
    }, BROADCAST_THROTTLE_MS);
  }

  private async broadcastStatuses(): Promise<void> {
    const server = this.services.tryResolve<{
      broadcastWS: (msg: unknown) => void;
    }>(ServiceNames.SERVER_INSTANCE);
    if (!server) return;
    for (const runtime of this.projects.values()) {
      try {
        const status = await this.status(runtime.cwd);
        server.broadcastWS({
          type: 'file-index.progress',
          payload: status,
        });
      } catch {
        // 单项目状态异常不阻断
      }
    }
  }
}

/** Glob 编译辅助（工具层复用） */
export function compileGlobs(patterns: readonly string[]): { positive: Glob[]; negative: Glob[] } | null {
  const positive: Glob[] = [];
  const negative: Glob[] = [];
  for (const p of patterns) {
    try {
      if (p.startsWith('!')) negative.push(new Glob(p.slice(1)));
      else positive.push(new Glob(p));
    } catch {
      return null;
    }
  }
  return { positive, negative };
}
