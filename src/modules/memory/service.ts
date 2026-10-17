// src/modules/memory/service.ts
// 记忆引擎服务实现：L1/L2 召回（governor 消费）、异步蒸馏调度（agent Stop 挂载）、
// 检索直通（memory_* 工具与 REST 路由消费）。

import type { ConfigService, Environment, Logger, ServiceRegistry } from '../../core/types';
import { ServiceNames } from '../../core/types';
import { flattenModels } from '../../core/provider-utils';
import { DEFAULT_MEMORY_CONFIG } from '../context/types';
import type { ContextSessionLike } from '../context/types';
import type { LLMRouter } from '../contracts';
import { resolveSummaryModel } from '../context/compressor';
import { MemoryRetriever, type RecallFilter } from './retriever';
import { distillSession } from './distiller';
import {
  buildMemoryRecord,
  buildPalaceTree,
  findMemoryAnywhere,
  globalMemoryRoot,
  isSystemScope,
  listAllMemories,
  memoryRoots,
  projectMemoryRoot,
  projectWing,
  removeMemoryFile,
  rewriteMemory,
  writeMemory,
} from './storage';
import { tokenize } from './tokenizer';
import type {
  MemoryHall,
  MemoryPalaceTree,
  MemoryRecallSection,
  MemoryScope,
  MemoryUpsertInput,
  ScopedMemoryRecord,
} from './types';
import type { SessionMemoryState } from '../context/types';

export interface MemoryEngineServiceDeps {
  env: Environment;
  config: ConfigService;
  services: ServiceRegistry;
  logger: Logger;
}

/** L1 锚定消息 name 标识 */
export const MEMORY_L1_MSG_NAME = 'memory-l1';
/** L2 召回临时消息 name 标识（非持久，仅本次请求视图） */
export const MEMORY_RECALL_MSG_NAME = 'memory-recall';

export class MemoryEngineServiceImpl {
  private readonly env: Environment;
  private readonly config: ConfigService;
  private readonly services: ServiceRegistry;
  private readonly logger: Logger;
  private readonly retriever: MemoryRetriever;
  /** 蒸馏防重入（session 内存集合） */
  private readonly distilling = new Set<string>();

  constructor(deps: MemoryEngineServiceDeps) {
    this.env = deps.env;
    this.config = deps.config;
    this.services = deps.services;
    this.logger = deps.logger;
    this.retriever = new MemoryRetriever(deps.env);
  }

  /** 实时读取记忆引擎配置 */
  getConfig() {
    const app = this.config.getAppConfig();
    const ctx = (app as { context?: { memory?: Partial<typeof DEFAULT_MEMORY_CONFIG> } }).context;
    return { ...DEFAULT_MEMORY_CONFIG, ...(ctx?.memory ?? {}) };
  }

  // ========================================================================
  // L1 / L2 召回（governor 消费）
  // ========================================================================

  /**
   * L1 关键事实注入文本（每会话一次；无关键事实返回 null）。
   * 内容 = pinned/高重要性记忆紧凑索引（来源 wing + insight）。
   */
  buildL1Section(cwd: string): string | null {
    const cfg = this.getConfig();
    const facts = this.retriever.getL1Facts(cwd, {
      importanceThreshold: cfg.l1ImportanceThreshold,
      maxEntries: cfg.l1MaxEntries,
    });
    if (facts.length === 0) return null;
    const lines = facts.map(
      f => `- [${f.wing}/${f.room}] ${f.insight}${f.pinned ? ' 📌' : ''}`,
    );
    return `[记忆 | 关键事实]\n以下是与本用户/项目相关的长期关键事实（跨会话持久）：\n${lines.join('\n')}`;
  }

  /**
   * L2 主题召回：以 query（最近 user 消息）检索当前项目 wing + user wing + Tunnel 关联记忆。
   * 去重语义（按消息切换）：
   * - 同一消息的多轮工具循环：exclude 恒为"上一条消息的召回"→ 每轮检索结果相同 → 注入稳定
   * - 新消息：上一条消息的召回（currentRecalled）转为排除集 → 避免连续消息重复注入同一记忆
   * @returns 注入文本与召回 id 集合（count=0 时 text=null）；queryChanged 表示消息发生切换（调用方持久化）
   */
  buildRecallSection(
    session: ContextSessionLike,
    query: string,
    cwd: string,
  ): MemoryRecallSection {
    const cfg = this.getConfig();
    const state: SessionMemoryState =
      session.memoryState ?? { excludeFromRecall: [], currentRecalled: [], lastDistilledIndex: 0 };
    session.memoryState = state;

    // query 键（截断防膨胀）；切换即：本消息召回 → 排除集基础，重置本消息召回
    const queryKey = query.slice(0, 200);
    const isNewQuery = state.lastRecallQuery !== queryKey;
    let queryChanged = false;
    if (isNewQuery) {
      state.excludeFromRecall = [...state.currentRecalled];
      state.currentRecalled = [];
      state.lastRecallQuery = queryKey;
      queryChanged = true;
    }

    const exclude = new Set<string>(state.excludeFromRecall);

    const hits = this.retriever.recallWithTunnel(cwd, query, {
      topK: cfg.recallTopK,
      excludeIds: exclude,
    });
    if (hits.length === 0) {
      return { text: null, count: 0, recalledIds: [], queryChanged };
    }

    // token 预算：超出截断
    const budget = cfg.recallTokenBudget;
    const parts: string[] = [];
    let used = 0;
    const included: ScopedMemoryRecord[] = [];
    for (const m of hits) {
      const line = `- [${m.wing}/${m.room}/${m.hall}] ${m.insight}`;
      const cost = Math.ceil(line.length * 0.4);
      if (used + cost > budget && included.length > 0) break;
      parts.push(line);
      used += cost;
      included.push(m);
    }

    // 本消息召回集合登记（消息切换时转为排除集；不单独持久化——丢失仅致重启后多注入一次，无害）
    state.currentRecalled = included.map(m => m.id);

    // touch（召回计数）：仅新消息的首次召回执行一次（避免轮次级 IO；不阻塞）
    if (isNewQuery) {
      void this.touchMemories(cwd, included.map(m => m.id));
    }

    return {
      text: `[记忆 | 相关记忆]\n以下是与当前任务相关的历史记忆：\n${parts.join('\n')}`,
      count: included.length,
      recalledIds: included.map(m => m.id),
      queryChanged,
    };
  }

  // ========================================================================
  // 蒸馏调度（agent Stop 挂载；手动触发）
  // ========================================================================

  /**
   * 调度异步蒸馏（run 结束后调用；不阻塞、防重入）。
   * LLM Router 不可用/引擎禁用/消息不足时静默跳过。
   */
  scheduleDistill(session: ContextSessionLike, cwd: string): void {
    const cfg = this.getConfig();
    if (!cfg.enabled || this.distilling.has(session.id)) return;

    const llm = this.services.tryResolve<LLMRouter>(ServiceNames.LLM_ROUTER);
    if (!llm) return;

    // 水位检查：无新增可蒸馏消息直接跳过（不进入异步任务）
    const state = session.memoryState ?? { excludeFromRecall: [], currentRecalled: [], lastDistilledIndex: 0 };
    const region = session.messages.slice(state.lastDistilledIndex).filter(
      m => !m.deletedAt && !m.compacted && !m.name && (m.role === 'user' || m.role === 'assistant'),
    );
    if (region.length < cfg.distillMinMessages) return;

    this.distilling.add(session.id);
    void (async () => {
      try {
        const mainModel = this.resolveMainModel();
        const { requestModel } = resolveSummaryModel(
          cfg.distillModel,
          mainModel,
          flattenModels(this.config.getApiConfig()).map(m => ({ id: m.id, model: m.model })),
        );
        const result = await distillSession(session, cwd, {
          logger: this.logger,
          env: this.env,
          llm,
          distillModelId: requestModel,
          minMessages: cfg.distillMinMessages,
          projectRoot: isSystemScope(cwd) ? null : projectMemoryRoot(cwd),
          globalRoot: globalMemoryRoot(this.env),
        });
        if (result.skipped) {
          this.logger.debug('memory: distillation skipped', {
            sessionId: session.id,
            reason: result.reason,
          });
        }
        this.retriever.invalidate();
      } catch (err) {
        this.logger.warn('memory: distillation failed', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.distilling.delete(session.id);
      }
    })();
  }

  /** 手动蒸馏（REST 路由：POST /api/memory/distill；等待完成返回结果） */
  async distillNow(session: ContextSessionLike, cwd: string): Promise<{ created: number; merged: number; skipped: boolean; reason?: string }> {
    const cfg = this.getConfig();
    const llm = this.services.tryResolve<LLMRouter>(ServiceNames.LLM_ROUTER);
    if (!llm) return { created: 0, merged: 0, skipped: true, reason: 'llm router unavailable' };

    const mainModel = this.resolveMainModel();
    const { requestModel } = resolveSummaryModel(
      cfg.distillModel,
      mainModel,
      flattenModels(this.config.getApiConfig()).map(m => ({ id: m.id, model: m.model })),
    );
    try {
      const result = await distillSession(session, cwd, {
        logger: this.logger,
        env: this.env,
        llm,
        distillModelId: requestModel,
        minMessages: 1,
        projectRoot: isSystemScope(cwd) ? null : projectMemoryRoot(cwd),
        globalRoot: globalMemoryRoot(this.env),
      });
      this.retriever.invalidate();
      return result;
    } catch (err) {
      return {
        created: 0,
        merged: 0,
        skipped: true,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ========================================================================
  // 检索与 CRUD 直通（memory 工具与 REST 路由消费）
  // ========================================================================

  /** 检索（memory 工具 action=search） */
  search(
    cwd: string,
    query: string,
    filter?: RecallFilter,
    topK?: number,
  ): ScopedMemoryRecord[] {
    return this.retriever.recall(cwd, query, { filter, topK: topK ?? 10 });
  }

  /**
   * 列表枚举（REST 无查询 q 时的全量数据源，替代不可用的 BM25 空查询）：
   * 全局 ∪ 项目（系统作用域仅全局），元数据过滤后按 updatedAt 降序截断。
   */
  listMemories(
    cwd: string,
    filter?: { wing?: string; room?: string; hall?: MemoryHall; pinned?: boolean },
    limit = 200,
  ): ScopedMemoryRecord[] {
    const { global: globalRoot, project } = memoryRoots(this.env, cwd);
    const all = [
      ...listAllMemories(globalRoot, 'global'),
      ...(project ? listAllMemories(project, 'project') : []),
    ];
    return all
      .filter(
        m =>
          (!filter?.wing || m.wing === filter.wing) &&
          (!filter?.room || m.room === filter.room) &&
          (!filter?.hall || m.hall === filter.hall) &&
          (filter?.pinned === undefined || m.pinned === filter.pinned),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, limit));
  }

  /** 关键词包含搜索（REST q= 参数：BM25 无结果时回退） */
  searchContains(cwd: string, q: string): ScopedMemoryRecord[] {
    const needle = q.toLowerCase();
    const { global: globalRoot, project } = memoryRoots(this.env, cwd);
    return [
      ...listAllMemories(globalRoot, 'global'),
      ...(project ? listAllMemories(project, 'project') : []),
    ].filter(
      m =>
        m.insight.toLowerCase().includes(needle) ||
        m.verbatim.toLowerCase().includes(needle) ||
        m.tags.some(t => t.toLowerCase().includes(needle)),
    );
  }

  /** 宫殿树 */
  palaceTree(cwd: string): MemoryPalaceTree {
    return buildPalaceTree(this.env, cwd);
  }

  /** 创建记忆（memory 工具 action=save / REST） */
  save(cwd: string, input: MemoryUpsertInput): ScopedMemoryRecord {
    const record = buildMemoryRecord(input);
    // preference/suggestion → 全局 user wing；其余 → 当前项目 wing。
    // 系统作用域（__system__）无项目根 → 项目翼记忆也归档到全局（避免相对路径写入进程目录）。
    const toGlobal = record.wing === 'user' || isSystemScope(cwd);
    const root = toGlobal ? globalMemoryRoot(this.env) : projectMemoryRoot(cwd);
    const scope: MemoryScope = toGlobal ? 'global' : 'project';
    writeMemory(root, record);
    this.retriever.invalidate();
    return { ...record, scope };
  }

  /** 按 id 读取 */
  get(cwd: string, id: string): ScopedMemoryRecord | null {
    return findMemoryAnywhere(this.env, cwd, id)?.record ?? null;
  }

  /** 更新（REST PATCH） */
  update(cwd: string, id: string, patch: Partial<MemoryUpsertInput>): ScopedMemoryRecord | null {
    const found = findMemoryAnywhere(this.env, cwd, id);
    if (!found) return null;
    const updated = {
      ...found.record,
      ...(patch.room !== undefined ? { room: patch.room } : {}),
      ...(patch.hall !== undefined ? { hall: patch.hall } : {}),
      ...(patch.verbatim !== undefined ? { verbatim: patch.verbatim } : {}),
      ...(patch.insight !== undefined ? { insight: patch.insight } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.importance !== undefined
        ? { importance: Math.min(1, Math.max(0, patch.importance)) }
        : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      updatedAt: new Date().toISOString(),
    };
    const result = rewriteMemory(found.file, updated, found.record.scope);
    this.retriever.invalidate();
    return result;
  }

  /** 删除 */
  delete(cwd: string, id: string): boolean {
    const found = findMemoryAnywhere(this.env, cwd, id);
    if (!found) return false;
    const ok = removeMemoryFile(found.file);
    if (ok) this.retriever.invalidate();
    return ok;
  }

  /** 当前项目 wing 名（工具展示用） */
  currentWing(cwd: string): string {
    return projectWing(cwd);
  }

  // ========================================================================
  // 内部
  // ========================================================================

  /**
   * touch（召回计数落盘）：读-改-写更新 accessCount + lastAccessedAt。
   * 调用时机：仅新消息的首次召回（每条消息 ≤ topK 次读-改-写，避免轮次级 IO）。
   * 不调用 retriever.invalidate()：重写文件不更新 wing/room 目录 mtime，
   * 索引指纹天然不失效；索引中 accessCount 落后仅影响显示，无正确性风险。
   */
  private async touchMemories(cwd: string, ids: readonly string[]): Promise<void> {
    const now = new Date().toISOString();
    for (const id of ids) {
      try {
        const found = findMemoryAnywhere(this.env, cwd, id);
        if (!found) continue;
        rewriteMemory(
          found.file,
          {
            ...found.record,
            accessCount: found.record.accessCount + 1,
            lastAccessedAt: now,
          },
          found.record.scope,
        );
      } catch {
        // 单条失败静默（touch 是尽力而为的统计）
      }
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

  /** 供 distiller 的 token 工具导出复用（测试用） */
  static tokenize = tokenize;
}
