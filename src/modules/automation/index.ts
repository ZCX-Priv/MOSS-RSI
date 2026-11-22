// src/modules/automation/index.ts
// Automation 模块入口：实现 AutomationService，注册 automation.service 服务。
// 持久化：~/.moss/automations.json + ~/.moss/automations-history.json
// 调度：scheduleType='cron' 周期任务（cron-parser 解析 + setTimeout 调度循环）；
//       scheduleType='once' 一次性定时任务（runAt 到点执行一次，之后标记 completed 保留）。
// 触发：调用 agent.engine.run({临时 sessionId, userMessage: prompt})，通过 server.instance.broadcastWS 推送事件

import { t } from '../../core/i18n';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import cronParser from 'cron-parser';
import type { Module, ModuleContext, Environment, Logger, ServiceRegistry, EventBus } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { AgentEngine, AgentEvent } from '../contracts';
import type { ServerInstanceLike } from '../contracts';
import { SYSTEM_SCOPE } from '../filesys/roots';

// ============================================================================
// 类型定义（与前端 webui/src/types/api.ts 对齐）
// ============================================================================

export interface AutomationItem {
  id: string;
  title: string;
  description?: string;
  /** lucide 图标名（kebab-case，如 'calendar-clock'；缺省前端回退首字母） */
  icon?: string;
  /** 调度类型：cron=周期循环；once=指定时间执行一次（旧数据 load 迁移时补 'cron'） */
  scheduleType: 'cron' | 'once';
  /** scheduleType='cron' 时的 5 字段 cron 表达式 */
  cron?: string;
  /** scheduleType='once' 时的执行时间（ISO 字符串，须未来） */
  runAt?: string;
  /** once 任务被调度器执行后标记 true；调度器不再调度；编辑改 runAt 时重置 */
  completed?: boolean;
  /** 执行工作目录（绝对路径，或 '__system__' 表示本机全盘访问；旧数据迁移补 __system__） */
  cwd: string;
  prompt: string;
  agentId?: string;
  enabled: boolean;
  paused: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  /** 本次运行创建的真实任务 id（task.id 即 sessionId；前端跳转 /task/:taskId 用） */
  taskId?: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'success' | 'failed' | 'timeout';
  finishReason?: string;
  finalText?: string;
  error?: string;
}

interface AutomationsStoreData {
  version: number;
  automations: AutomationItem[];
}

interface HistoryStoreData {
  version: number;
  /** 按 automationId 索引的运行记录（最近 50 条） */
  history: Record<string, AutomationRun[]>;
}

// ============================================================================
// AutomationService 实现
// ============================================================================

/** 运行时间戳（本地时间 MM-dd HH:mm），用于生成真实任务标题 */
function formatRunStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface AutomationService {
  list(): AutomationItem[];
  get(id: string): AutomationItem | null;
  create(data: {
    title: string;
    prompt: string;
    cwd: string;
    description?: string;
    icon?: string;
    agentId?: string;
    scheduleType?: 'cron' | 'once';
    cron?: string;
    runAt?: string;
  }): AutomationItem;
  update(id: string, patch: Partial<AutomationItem>): AutomationItem | null;
  remove(id: string): boolean;
  trigger(id: string): { runId: string };
  pause(id: string): boolean;
  resume(id: string): boolean;
  getHistory(id: string): AutomationRun[];
}

class AutomationServiceImpl implements AutomationService {
  private readonly storePath: string;
  private readonly historyPath: string;
  private readonly logger: Logger;
  private readonly services: ServiceRegistry;
  private readonly eventBus: EventBus;
  private data: AutomationsStoreData;
  private history: HistoryStoreData;
  /** 调度定时器索引：automationId -> timer */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 正在运行的 automation：runId -> { automationId, startedAt, controller } */
  private readonly running = new Map<string, {
    automationId: string;
    startedAt: string;
    controller: AbortController;
  }>();

  constructor(deps: {
    env: Environment;
    logger: Logger;
    services: ServiceRegistry;
    eventBus: EventBus;
  }) {
    this.logger = deps.logger;
    this.services = deps.services;
    this.eventBus = deps.eventBus;
    this.storePath = join(deps.env.dataDir, 'automations.json');
    this.historyPath = join(deps.env.dataDir, 'automations-history.json');
    this.data = this.load();
    this.history = this.loadHistory();
  }

  /** 启动调度器（在模块 initialize 后调用）：先迁移旧数据，再为每个任务安排调度 */
  startScheduler(): void {
    this.migrate();
    for (const a of this.data.automations) {
      this.scheduleNext(a);
    }
    this.logger.info(t('automation.schedulerStarted'), {
      scheduled: this.data.automations.filter(a => a.enabled && !a.paused && !a.completed).length,
    });
  }

  /**
   * 旧数据迁移：无 scheduleType 的条目补 'cron'；无 cwd 补本机作用域（__system__）；
   * once 任务 runAt 已过期且未执行 → 标记 completed（跳过不补跑）。
   */
  private migrate(): void {
    let dirty = false;
    const now = Date.now();
    for (const a of this.data.automations) {
      if (a.scheduleType !== 'cron' && a.scheduleType !== 'once') {
        a.scheduleType = 'cron';
        dirty = true;
      }
      if (typeof a.cwd !== 'string' || a.cwd.trim() === '') {
        a.cwd = SYSTEM_SCOPE;
        dirty = true;
      }
      if (
        a.scheduleType === 'once' &&
        !a.completed &&
        a.runAt &&
        !Number.isNaN(Date.parse(a.runAt)) &&
        Date.parse(a.runAt) <= now
      ) {
        a.completed = true;
        a.nextRunAt = undefined;
        dirty = true;
        this.logger.info(t('automation.onceSkippedExpired', { id: a.id }), { runAt: a.runAt });
      }
    }
    if (dirty) this.save();
  }

  /** 停止所有调度 */
  stopScheduler(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    // 中断正在运行的 automation
    for (const r of this.running.values()) {
      r.controller.abort();
    }
    this.logger.info(t('automation.schedulerStopped'));
  }

  // ========================================================================
  // 持久化
  // ========================================================================

  private load(): AutomationsStoreData {
    try {
      const raw = readFileSync(this.storePath, 'utf8');
      const parsed = JSON.parse(raw) as AutomationsStoreData;
      if (!parsed.automations || !Array.isArray(parsed.automations)) {
        return { version: 1, automations: [] };
      }
      return parsed;
    } catch {
      return { version: 1, automations: [] };
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      this.logger.error(t('automation.saveFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private loadHistory(): HistoryStoreData {
    try {
      const raw = readFileSync(this.historyPath, 'utf8');
      const parsed = JSON.parse(raw) as HistoryStoreData;
      if (!parsed.history || typeof parsed.history !== 'object') {
        return { version: 1, history: {} };
      }
      return parsed;
    } catch {
      return { version: 1, history: {} };
    }
  }

  private saveHistory(): void {
    try {
      mkdirSync(dirname(this.historyPath), { recursive: true });
      writeFileSync(this.historyPath, JSON.stringify(this.history, null, 2), 'utf8');
    } catch (err) {
      this.logger.error(t('automation.saveHistoryFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ========================================================================
  // CRUD
  // ========================================================================

  list(): AutomationItem[] {
    return this.data.automations.map(a => ({ ...a }));
  }

  get(id: string): AutomationItem | null {
    const a = this.data.automations.find(x => x.id === id);
    return a ? { ...a } : null;
  }

  create(data: {
    title: string;
    prompt: string;
    cwd: string;
    description?: string;
    icon?: string;
    agentId?: string;
    scheduleType?: 'cron' | 'once';
    cron?: string;
    runAt?: string;
  }): AutomationItem {
    const scheduleType = data.scheduleType ?? 'cron';
    if (!data.cwd || typeof data.cwd !== 'string' || data.cwd.trim() === '') {
      throw new Error(t('automation.cwdRequiredThrow'));
    }
    let cron: string | undefined;
    let runAt: string | undefined;

    if (scheduleType === 'cron') {
      if (!data.cron) {
        throw new Error(t('automation.cronRequiredThrow'));
      }
      this.validateCron(data.cron);
      cron = data.cron;
    } else {
      if (!data.runAt) {
        throw new Error(t('automation.onceRunAtRequiredThrow'));
      }
      const ts = Date.parse(data.runAt);
      if (Number.isNaN(ts)) {
        throw new Error(t('automation.onceRunAtInvalidThrow', { runAt: data.runAt }));
      }
      if (ts <= Date.now()) {
        throw new Error(t('automation.onceRunAtPastThrow', { runAt: data.runAt }));
      }
      runAt = new Date(ts).toISOString();
    }

    const now = new Date().toISOString();
    const item: AutomationItem = {
      id: `auto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: data.title,
      description: data.description,
      icon: data.icon,
      scheduleType,
      cron,
      runAt,
      cwd: data.cwd,
      prompt: data.prompt,
      agentId: data.agentId,
      enabled: true,
      paused: false,
      createdAt: now,
    };
    this.data.automations.push(item);
    this.save();
    this.scheduleNext(item);
    this.logger.info(t('automation.created', { id: item.id, title: item.title }));
    return { ...item };
  }

  update(id: string, patch: Partial<AutomationItem>): AutomationItem | null {
    const idx = this.data.automations.findIndex(a => a.id === id);
    if (idx < 0) return null;
    const current = this.data.automations[idx];

    // 不允许通过 patch 修改 id / createdAt
    const { id: _omitId, createdAt: _omitCreatedAt, ...allowedPatch } = patch;

    // cwd 如提供必须为非空字符串
    if (
      allowedPatch.cwd !== undefined &&
      (typeof allowedPatch.cwd !== 'string' || allowedPatch.cwd.trim() === '')
    ) {
      throw new Error(t('automation.cwdRequiredThrow'));
    }

    // 仅当调度相关字段发生变化时才校验（纯改标题等不应被旧 runAt 阻塞）
    const scheduleTouched =
      allowedPatch.scheduleType !== undefined ||
      allowedPatch.cron !== undefined ||
      allowedPatch.runAt !== undefined ||
      allowedPatch.completed !== undefined;
    if (scheduleTouched) {
      const nextType = allowedPatch.scheduleType ?? current.scheduleType;
      if (nextType === 'cron') {
        const nextCron = allowedPatch.cron !== undefined ? allowedPatch.cron : current.cron;
        if (!nextCron) {
          throw new Error(t('automation.cronRequiredThrow'));
        }
        this.validateCron(nextCron);
      } else {
        const nextRunAt = allowedPatch.runAt !== undefined ? allowedPatch.runAt : current.runAt;
        if (!nextRunAt) {
          throw new Error(t('automation.onceRunAtRequiredThrow'));
        }
        const ts = Date.parse(nextRunAt);
        if (Number.isNaN(ts)) {
          throw new Error(t('automation.onceRunAtInvalidThrow', { runAt: nextRunAt }));
        }
        if (ts <= Date.now()) {
          throw new Error(t('automation.onceRunAtPastThrow', { runAt: nextRunAt }));
        }
      }
    }

    const updated = { ...current, ...allowedPatch };
    // once 任务 runAt 变化 → 重置完成状态（重新启用语义）
    if (
      updated.scheduleType === 'once' &&
      allowedPatch.runAt !== undefined &&
      allowedPatch.runAt !== current.runAt
    ) {
      updated.completed = false;
    }
    this.data.automations[idx] = updated;
    this.save();
    // 重新调度（completed 任务由 scheduleNext 内部跳过）
    this.cancelSchedule(id);
    if (updated.enabled && !updated.paused && !updated.completed) {
      this.scheduleNext(updated);
    }
    this.logger.info(t('automation.updated', { id }));
    return { ...updated };
  }

  remove(id: string): boolean {
    const idx = this.data.automations.findIndex(a => a.id === id);
    if (idx < 0) return false;
    this.cancelSchedule(id);
    this.data.automations.splice(idx, 1);
    this.save();
    // 历史保留（可后续清理）
    this.logger.info(t('automation.removed', { id }));
    return true;
  }

  // ========================================================================
  // 触发 / 暂停 / 恢复
  // ========================================================================

  trigger(id: string): { runId: string } {
    const item = this.data.automations.find(a => a.id === id);
    if (!item) {
      throw new Error(t('automation.notFoundThrow', { id }));
    }
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // 异步执行，不阻塞
    void this.executeRun(item, runId);
    return { runId };
  }

  pause(id: string): boolean {
    const idx = this.data.automations.findIndex(a => a.id === id);
    if (idx < 0) return false;
    if (this.data.automations[idx].paused) return true;
    this.data.automations[idx].paused = true;
    this.save();
    this.cancelSchedule(id);
    this.logger.info(t('automation.paused', { id }));
    return true;
  }

  resume(id: string): boolean {
    const idx = this.data.automations.findIndex(a => a.id === id);
    if (idx < 0) return false;
    if (!this.data.automations[idx].paused) return true;
    this.data.automations[idx].paused = false;
    this.save();
    if (this.data.automations[idx].enabled) {
      this.scheduleNext(this.data.automations[idx]);
    }
    this.logger.info(t('automation.resumed', { id }));
    return true;
  }

  getHistory(id: string): AutomationRun[] {
    return (this.history.history[id] ?? []).map(r => ({ ...r }));
  }

  // ========================================================================
  // 调度
  // ========================================================================

  private validateCron(cron: string): void {
    try {
      cronParser.parse(cron);
    } catch {
      throw new Error(t('automation.invalidCronThrow', { cron }));
    }
  }

  private cancelSchedule(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private scheduleNext(item: AutomationItem): void {
    if (!item.enabled || item.paused || item.completed) return;
    this.cancelSchedule(item.id);

    let next: Date;
    if (item.scheduleType === 'once') {
      const ts = item.runAt ? Date.parse(item.runAt) : NaN;
      if (Number.isNaN(ts)) {
        this.logger.warn(t('automation.onceRunAtInvalid', { id: item.id }), { runAt: item.runAt });
        return;
      }
      if (ts <= Date.now()) {
        // 防御：过期 once 任务标记完成，不补跑
        this.markCompleted(item.id);
        return;
      }
      next = new Date(ts);
    } else {
      if (!item.cron) return;
      try {
        const interval = cronParser.parse(item.cron);
        next = interval.next().toDate();
      } catch (err) {
        this.logger.warn(t('automation.cronParseFailed', { id: item.id }), {
          cron: item.cron,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }

    const delay = next.getTime() - Date.now();
    // 更新 nextRunAt
    const idx = this.data.automations.findIndex(a => a.id === item.id);
    if (idx >= 0) {
      this.data.automations[idx].nextRunAt = next.toISOString();
      this.save();
    }

    // setTimeout 上限约为 24.8 天，超大 delay 需分段
    const MAX_TIMEOUT = 2_000_000_000;
    const scheduleFn = () => {
      const timer = setTimeout(() => {
        this.timers.delete(item.id);
        // once 任务由调度器触发，执行后标记完成（手动 trigger 不标记）
        const markCompleted = item.scheduleType === 'once';
        void this.executeRun(item, `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, { markCompleted })
          .catch(err => {
            this.logger.error(t('automation.runFailed', { id: item.id }), {
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            // 调度下一次（once 任务已标记 completed，scheduleNext 内部跳过）
            const current = this.data.automations.find(a => a.id === item.id);
            if (current && current.enabled && !current.paused) {
              this.scheduleNext(current);
            }
          });
      }, Math.min(delay, MAX_TIMEOUT));
      this.timers.set(item.id, timer);
    };

    if (delay > MAX_TIMEOUT) {
      // 分段等待：先等待 MAX_TIMEOUT，再重新计算
      const timer = setTimeout(() => {
        this.timers.delete(item.id);
        const current = this.data.automations.find(a => a.id === item.id);
        if (current && current.enabled && !current.paused) {
          this.scheduleNext(current);
        }
      }, MAX_TIMEOUT);
      this.timers.set(item.id, timer);
    } else {
      scheduleFn();
    }
  }

  /** once 任务标记完成：completed=true、清除 nextRunAt 并落盘 */
  private markCompleted(id: string): void {
    const idx = this.data.automations.findIndex(a => a.id === id);
    if (idx < 0) return;
    if (this.data.automations[idx].completed) return;
    this.data.automations[idx].completed = true;
    this.data.automations[idx].nextRunAt = undefined;
    this.save();
    this.logger.info(t('automation.onceCompleted', { id }));
  }

  // ========================================================================
  // 执行
  // ========================================================================

  private async executeRun(
    item: AutomationItem,
    runId: string,
    opts?: { markCompleted?: boolean },
  ): Promise<void> {
    const agent = this.services.tryResolve<AgentEngine>(ServiceNames.AGENT_ENGINE);
    const server = this.services.tryResolve<ServerInstanceLike>(ServiceNames.SERVER_INSTANCE);

    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    this.running.set(runId, { automationId: item.id, startedAt, controller });
    /** 本次运行创建的真实任务 id（agent 不可用等失败于创建任务前时保持 undefined） */
    let taskId: string | undefined;
    /** 注册进 server 活跃 run 表的 session（注销时用；未注册时为 undefined） */
    let registeredSessionId: string | undefined;

    // 更新 lastRunAt
    const idx = this.data.automations.findIndex(a => a.id === item.id);
    if (idx >= 0) {
      this.data.automations[idx].lastRunAt = startedAt;
      this.save();
    }

    // 记录运行开始（taskId 在创建真实任务成功后补写）
    const run: AutomationRun = {
      id: runId,
      automationId: item.id,
      startedAt,
      status: 'running',
    };
    this.addHistory(item.id, run);

    /** 本次 run 的 sessionId（创建真实任务后回填；供事件转发到该 session 的订阅者） */
    let runSessionId: string | undefined;

    // 事件转发到 WS：
    // - error/done → automation.event 广播（自动化页历史/通知）
    // - 全量 → sendAgentEvent 到 session 订阅者（任务页实时消息流，与 webui 发送 / MCP 派发同构；
    //   ask/confirm 转发后用户可在打开的会话页应答）
    const onEvent = (event: AgentEvent): void => {
      if (event.type === 'error' || event.type === 'done') {
        server?.broadcastWS({
          type: 'automation.event',
          payload: { automationId: item.id, runId, event },
        });
      }
      if (runSessionId) {
        try {
          server?.sendAgentEvent(runSessionId, event);
        } catch {
          // 转发失败不影响运行
        }
      }
    };

    try {
      if (!agent) {
        throw new Error(t('automation.agentEngineUnavailableThrow'));
      }
      // 按工作目录派生文件夹分组（与前端发消息的分组规则一致）：本机 → "本机"组；路径 → 目录名组；
      // 大小写不敏感查找，无则新建 folder 分组（空组由 task-store 自动销毁）
      const scopeCwd = item.cwd || SYSTEM_SCOPE;
      const groupName = scopeCwd === SYSTEM_SCOPE
        ? t('automation.systemGroup')
        : (scopeCwd.split(/[\\/]/).filter(Boolean).pop() ?? scopeCwd);
      let group = agent.listTaskGroups().find(g =>
        scopeCwd === SYSTEM_SCOPE
          ? ['本机', 'system'].includes(g.name.toLowerCase())
          : g.name.toLowerCase() === groupName.toLowerCase(),
      );
      if (!group) group = agent.createTaskGroup(groupName, 'folder');

      // 创建真实任务（侧边栏可见，task.id 即 sessionId）
      const task = agent.createTask(`[自动化] ${item.title} · ${formatRunStamp(new Date())}`, group.id);
      this.updateHistoryRun(item.id, runId, { taskId: task.id });

      const sessionId = task.sessionId ?? task.id;
      taskId = task.id;
      runSessionId = sessionId;
      // 注册外部活跃 run：task.switch/session.subscribe 的 running 判定包含该 session，
      // 用户在该任务页点击停止（task.abort）可中断本次自动化运行
      server?.registerExternalRun(sessionId, controller);
      registeredSessionId = sessionId;

      // 推送 automation.started（含 taskId：前端据此立即把侧边栏任务标记为运行中）
      server?.broadcastWS({
        type: 'automation.started',
        payload: { automationId: item.id, runId, startedAt, taskId: task.id },
      });
      this.eventBus.broadcast('automation:started', { automationId: item.id, runId }).catch(() => {});

      this.logger.info(t('automation.runStarted', { id: item.id, runId }));

      // 广播任务创建（携带分组供侧边栏即时渲染新任务行）
      server?.broadcastWS({ type: 'task.created', payload: { task, group } });

      const result = await agent.run({
        sessionId,
        userMessage: item.prompt,
        agentId: item.agentId,
        cwd: scopeCwd,
        onEvent,
        signal: controller.signal,
      });

      const finishedAt = new Date().toISOString();
      const status: AutomationRun['status'] =
        result.finishReason === 'error' ? 'failed' :
        result.finishReason === 'aborted' ? 'failed' :
        result.finishReason === 'length' ? 'timeout' : 'success';

      this.updateHistoryRun(item.id, runId, {
        finishedAt,
        status,
        finishReason: result.finishReason,
        finalText: result.finalText,
      });

      server?.broadcastWS({
        type: 'automation.finished',
        payload: {
          automationId: item.id,
          runId,
          startedAt,
          finishedAt,
          status,
          finishReason: result.finishReason,
          finalText: result.finalText,
          taskId,
        },
      });
      this.eventBus.broadcast('automation:finished', {
        automationId: item.id,
        runId,
        status,
      }).catch(() => {});

      this.logger.info(t('automation.runFinished', { id: item.id, runId }), {
        status,
        finishReason: result.finishReason,
      });
    } catch (err) {
      const finishedAt = new Date().toISOString();
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.updateHistoryRun(item.id, runId, {
        finishedAt,
        status: 'failed',
        error: errorMsg,
      });
      server?.broadcastWS({
        type: 'automation.finished',
        payload: {
          automationId: item.id,
          runId,
          startedAt,
          finishedAt,
          status: 'failed',
          error: errorMsg,
          taskId,
        },
      });
      this.logger.error(t('automation.runFailedWithRun', { id: item.id, runId }), { error: errorMsg });
    } finally {
      this.running.delete(runId);
      // 注销外部活跃 run（run 结束后 session.subscribe/task.switch 不再报告 running）
      if (server && registeredSessionId) {
        server.unregisterExternalRun(registeredSessionId, controller);
      }
      // once 任务由调度器触发（markCompleted）：无论成败都标记完成并保留
      if (opts?.markCompleted && item.scheduleType === 'once') {
        this.markCompleted(item.id);
      }
    }
  }

  private addHistory(automationId: string, run: AutomationRun): void {
    if (!this.history.history[automationId]) {
      this.history.history[automationId] = [];
    }
    this.history.history[automationId].unshift(run);
    // 限制 50 条
    if (this.history.history[automationId].length > 50) {
      this.history.history[automationId] = this.history.history[automationId].slice(0, 50);
    }
    this.saveHistory();
  }

  private updateHistoryRun(automationId: string, runId: string, patch: Partial<AutomationRun>): void {
    const list = this.history.history[automationId];
    if (!list) return;
    const idx = list.findIndex(r => r.id === runId);
    if (idx < 0) return;
    list[idx] = { ...list[idx], ...patch };
    this.saveHistory();
  }
}

// ============================================================================
// Module 入口
// ============================================================================

class AutomationModule implements Module {
  private service: AutomationServiceImpl | null = null;

  async initialize(ctx: ModuleContext): Promise<void> {
    this.service = new AutomationServiceImpl({
      env: ctx.env,
      logger: ctx.logger,
      services: ctx.services,
      eventBus: ctx.eventBus,
    });
    ctx.services.register(ServiceNames.AUTOMATION_SERVICE, this.service, {
      scope: 'automation',
    });
    // stdio MCP 入口（`moss mcp`）由客户端按需拉起，可能与本机常驻 MOSS 同时存在：
    // 服务照常注册（外部 Agent 需要 create/list/update/trigger 等能力），但**不启动调度器**，
    // 否则同一批定时任务会被两个进程各跑一遍。
    if (process.env.MOSS_STDIO_MCP === '1') {
      ctx.logger.info(t('automation.moduleInitialized'), {
        automationCount: this.service.list().length,
        scheduler: 'disabled (stdio mcp mode)',
      });
      return;
    }
    this.service.startScheduler();
    ctx.logger.info(t('automation.moduleInitialized'), {
      automationCount: this.service.list().length,
    });
  }

  async destroy(): Promise<void> {
    this.service?.stopScheduler();
  }
}

export default (): Module => new AutomationModule();
