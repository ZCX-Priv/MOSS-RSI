// src/modules/mcp/task-registry.ts
// MCP 对外派发的任务注册表：让外部 Agent 能「给 MOSS 派活并轮询进度」。
//
// 定位：/mcp 是 agent 级接口（不是 MOSS 内部工具代理）。派发 = engine.run 异步执行，
// 立即返回 taskId；进度/结果通过 moss_task_status 轮询。
//
// 关键设计：
// 1. 所有状态活在内存（进程级），不做持久化：MOSS 重启后注册表清空，调用方可用
//    moss_read_session 按 sessionId 读历史兜底（错误文案里已说明）。
// 2. onEvent 只做纯内存记账，绝不抛异常、绝不 await —— 轨迹采集不能影响 agent run。
// 3. confirm / ask 事件必须自动应答：外部客户端没有前端确认 UI，不应答会让 run 永久挂起。
//    策略是安全默认「拒绝/取消」，并记一条 notice 轨迹（调用方传 permissionMode:'skip'
//    可显式放弃该保护）。
// 4. 摘要（可选，默认开）走 LLM，带缓存 + 超时 + 全量降级：摘要失败只影响 summary 字段。

import type { ConfigService, Environment, Logger, ServiceRegistry } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type {
  AgentEngine,
  AgentEvent,
  AgentMessage,
  AgentRunResult,
  LLMRouter,
  RunStats,
} from '../contracts';
import type { TaskGroup, TaskItem } from '../agent/task-store';
import type { PermissionMode } from '../safety/types';
import { flattenModels } from '../../core/provider-utils';
import { resolveSummaryModel } from '../context/compressor';
import { getSessionTodoPath, readSessionTodoStore, type TodoItem } from '../tools/todo/shared/store';
import { isMossAccessAllowed, SYSTEM_SCOPE } from '../filesys/roots';
import { loadPromptFileOrNull } from '../context/prompt-loader';
import { t } from '../../core/i18n';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';

/** 轨迹环形缓冲上限 */
const MAX_EVENTS = 80;
/** 注册表任务上限（超出淘汰最旧终态任务） */
const MAX_TASKS = 100;
/** 累积的「当前步骤」文本上限 */
const MAX_ASSISTANT_BUFFER = 2000;
/** 单条轨迹字段（参数/结果摘要）上限 */
const MAX_FIELD_CHARS = 400;
/** 终态结果文本上限 */
const MAX_FINAL_TEXT = 20_000;
/** 文本轨迹节流（避免逐 token 刷屏） */
const TEXT_STEP_THROTTLE_MS = 800;
/** 摘要结果缓存时长 */
const SUMMARY_CACHE_MS = 20_000;
/** 摘要 LLM 调用超时 */
const SUMMARY_TIMEOUT_MS = 20_000;
/** 摘要输入总字符上限（控 token） */
const SUMMARY_INPUT_CHARS = 6000;
/** 摘要输出 token 上限 */
const SUMMARY_MAX_TOKENS = 400;
/** 派发会话的标题前缀（与自动化的 `[自动化] ` 同一约定，便于在侧边栏区分来源） */
const MCP_TITLE_PREFIX = '[MCP] ';
/** 标题正文长度上限（与前端新建会话的 title.slice(0,50) 口径一致） */
const MCP_TITLE_MAX = 50;

export type McpTaskStatus = 'running' | 'aborting' | 'done' | 'error' | 'aborted';

export interface McpTaskDispatchInput {
  prompt: string;
  /** 工作目录：必填。本机存在的目录绝对路径，或 SYSTEM_SCOPE（__system__ = 全盘） */
  cwd: string;
  title?: string;
  agentId?: string;
  model?: string;
  /** 复用已有会话续跑；不传则新建任务（taskId = 新会话 id） */
  sessionId?: string;
  permissionMode?: PermissionMode;
}

export interface McpTrajectoryStep {
  at: number;
  kind: 'tool' | 'text' | 'notice';
  tool?: string;
  argsSummary?: string;
  resultSummary?: string;
  isError?: boolean;
  durationMs?: number;
  text?: string;
}

/** 内部轨迹条目：比对外视图多两个关联字段（不对外返回） */
interface TrajectoryEntry extends McpTrajectoryStep {
  toolCallId?: string;
  startedAtMs?: number;
}

export interface McpTaskRecord {
  taskId: string;
  sessionId: string;
  title: string;
  prompt: string;
  cwd: string;
  agentId?: string;
  model?: string;
  permissionMode: PermissionMode;
  status: McpTaskStatus;
  startedAt: number;
  endedAt?: number;
  lastActivityAt: number;
  finishReason?: AgentRunResult['finishReason'];
  finalText?: string;
  error?: string;
  controller: AbortController;
  events: TrajectoryEntry[];
  assistantBuffer: string;
  lastTextStepAt: number;
  currentTool?: { name: string; argsSummary: string; startedAt: number };
  stats?: RunStats;
  summaryCache?: { text: string | null; error?: string; at: number };
}

export interface McpTaskView {
  taskId: string;
  sessionId: string;
  title: string;
  cwd: string;
  agentId?: string;
  model?: string;
  permissionMode: PermissionMode;
  status: McpTaskStatus;
  finishReason?: AgentRunResult['finishReason'];
  startedAt: number;
  endedAt?: number;
  elapsedMs: number;
  lastActivityAt: number;
  idleMs: number;
  currentStep: { kind: 'tool' | 'text'; tool?: string; argsSummary?: string; text?: string } | null;
  recentSteps: McpTrajectoryStep[];
  todos: Array<{ id: string; text: string; status: string; priority: string }>;
  stats?: { turns: number; steps: number; inputTokens: number; outputTokens: number; cachedTokens: number };
  summary: string | null;
  summaryError?: string;
  result?: string;
  note?: string;
}

/** 会话列表项（引擎 listSessions 返回值 + 派生的标题） */
export interface McpSessionInfo {
  sessionId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** 引擎上非接口成员的扩展能力（与 server/routes/session.ts 同样的结构扩展用法） */
type EngineWithExtras = AgentEngine & {
  listSessions?: () => Array<{ id: string; createdAt: string; updatedAt: string; messageCount: number }>;
  getHistory?: (sessionId: string) => AgentMessage[];
};

/** Server 实例能力（task.created 广播 / agent 事件转发 / 外部 run 注册）；不可用时全部静默降级 */
interface ServerHost {
  broadcastWS(message: unknown): void;
  sendToSession(sessionId: string, message: unknown): void;
  sendAgentEvent(sessionId: string, event: AgentEvent): void;
  registerExternalRun(sessionId: string, controller: AbortController): void;
  unregisterExternalRun(sessionId: string, controller: AbortController): void;
}

/**
 * 不向 session 订阅者转发的 agent 事件类型：ask / confirm-required 在外部派发中没有
 * 确认通道，onEvent 内已同步自动拒绝/取消，转发只会让前端闪现一张已被解决的卡片；
 * ask-timeout 同理（超时即终结，无人工介入窗口）。
 */
const NON_FORWARDABLE_EVENTS = new Set(['ask', 'ask-timeout', 'confirm-required']);

/** cwd 越权/不可用：属于参数类错误，派发阶段直接拒绝（不建任务） */
export class CwdRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CwdRejectedError';
  }
}

/** cwd 相关错误统一附带的补救提示 */
const CWD_HINT = 'use moss_list_workspaces to see saved directories';

/**
 * 会话标题：`[MCP] ` + 首个非空行（空白折叠、切片 50 字符）。
 * 与前端新建会话的 title.slice(0,50) 口径一致；刻意不用 truncate()（标题不该带诊断尾巴）。
 */
export function mcpTaskTitle(source: string): string {
  const firstLine = (source ?? '')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .find(line => line.length > 0) ?? '';
  const body = firstLine.slice(0, MCP_TITLE_MAX);
  return `${MCP_TITLE_PREFIX}${body || 'task'}`;
}

/**
 * 解析 cwd（导出纯函数：派发任务与自动化创建共用，不依赖注册表实例）。
 *
 * 规则（按用户设定的 MCP 运行规则）：
 * - `__system__` → 原样返回（全盘访问，等价前端"本机"模式）
 * - 空 → 拒绝（必填）
 * - 相对路径基于 base 解析为绝对路径
 * - 命中 ~/.moss 硬屏蔽（除 agent/mcps/skills）→ 拒绝（仓库既有全局规则，防自我提权）
 * - 本机不存在或不是目录 → 拒绝
 * 不做 roots 白名单限制：允许外部 Agent 传入任何本机存在的合法目录。
 */
export function resolveTaskCwd(raw: string, base: string): string {
  const requested = (raw ?? '').trim();
  if (requested === SYSTEM_SCOPE) return SYSTEM_SCOPE;
  if (!requested) {
    throw new CwdRejectedError(`cwd is required: pass an existing local directory, or "${SYSTEM_SCOPE}" for full-disk access; ${CWD_HINT}`);
  }
  const abs = isAbsolute(requested) ? normalize(requested) : normalize(resolve(base, requested));
  if (!isMossAccessAllowed(abs)) {
    throw new CwdRejectedError(`cwd "${requested}" is inside MOSS's protected data directory (~/.moss) and cannot be used; ${CWD_HINT}`);
  }
  let isDir = false;
  try {
    isDir = existsSync(abs) && statSync(abs).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new CwdRejectedError(`cwd "${requested}" does not exist or is not a directory; ${CWD_HINT}`);
  }
  return abs;
}

/** 「已保存的目录」条目（moss_list_workspaces） */
export interface WorkspaceEntry {
  path: string;
  label: string;
  source: 'config' | 'roots' | 'history';
  exists: boolean;
  lastUsedAt?: number;
}

function isExistingDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 组装「已保存的目录」列表（导出纯函数：注册表未就绪时 agent-tools 也能给出 config + roots）。
 * 顺序：默认工作目录 → 授权 roots → 派发历史（新→旧）；按路径去重（Windows 大小写不敏感）；
 * exists 用真实 stat 判定（不存在的也列出并标注，避免调用方反复踩坑）。
 */
export function buildWorkspaceList(input: {
  workingDirectory: string;
  roots: readonly string[];
  history: ReadonlyArray<{ cwd: string; startedAt: number }>;
}): WorkspaceEntry[] {
  const out: WorkspaceEntry[] = [];
  const seen = new Set<string>();
  const push = (rawPath: string, label: string, source: WorkspaceEntry['source'], lastUsedAt?: number): void => {
    const p = (rawPath ?? '').trim();
    if (!p || p === SYSTEM_SCOPE) return;
    const key = process.platform === 'win32' ? p.toLowerCase() : p;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: p, label, source, exists: isExistingDir(p), ...(lastUsedAt !== undefined ? { lastUsedAt } : {}) });
  };
  push(input.workingDirectory, '默认工作目录', 'config');
  for (const root of input.roots) push(root, '授权目录', 'roots');
  for (const entry of input.history) push(entry.cwd, '已用于派发', 'history', entry.startedAt);
  return out;
}

function truncate(text: string, max: number): string {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

function summarizeArgs(args: unknown): string {
  try {
    const json = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    return truncate(json, MAX_FIELD_CHARS);
  } catch {
    return truncate(String(args), MAX_FIELD_CHARS);
  }
}

/**
 * AgentEvent 的 done.finishReason 在类型上是 string（较 interface 更宽松），
 * 这里收窄到 AgentRunResult 的联合类型；未知取值按 'error' 处理（不谎报成功）。
 */
function normalizeFinishReason(value: unknown): AgentRunResult['finishReason'] {
  return value === 'stop' || value === 'length' || value === 'aborted' || value === 'max_turns'
    ? value
    : 'error';
}

function summarizeResult(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const c = item as { type?: string; text?: string };
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'image') parts.push('[image]');
  }
  return truncate(parts.join('\n'), MAX_FIELD_CHARS);
}

/**
 * MCP 派发任务注册表（进程级单例，由 mcp 模块注册为 ServiceNames.MCP_TASK_REGISTRY）。
 */
export class McpTaskRegistry {
  private readonly config: ConfigService;
  private readonly services: ServiceRegistry;
  private readonly logger: Logger;
  private readonly env: Environment;
  private readonly tasks = new Map<string, McpTaskRecord>();
  /** 摘要串行化：同一任务的并发轮询共用一次 LLM 调用 */
  private readonly summaryInflight = new Map<string, Promise<{ text: string | null; error?: string }>>();

  constructor(deps: {
    config: ConfigService;
    services: ServiceRegistry;
    logger: Logger;
    env: Environment;
  }) {
    this.config = deps.config;
    this.services = deps.services;
    this.logger = deps.logger;
    this.env = deps.env;
  }

  // ------------------------------------------------------------ 派发

  /**
   * 派发任务：建任务记录并后台启动 agent run，立即返回。
   * @throws CwdRejectedError / Error（参数或服务不可用：不建任务，由调用方转 isError）
   */
  dispatch(input: McpTaskDispatchInput): { taskId: string; sessionId: string; cwd: string; status: McpTaskStatus } {
    const prompt = (input.prompt ?? '').trim();
    if (!prompt) throw new Error('prompt is required');
    const permissionMode = input.permissionMode ?? 'auto';
    if (permissionMode !== 'ask' && permissionMode !== 'auto' && permissionMode !== 'skip') {
      throw new Error(`invalid permissionMode "${String(input.permissionMode)}" (expect ask|auto|skip)`);
    }
    const engine = this.resolveEngine();
    if (!engine) throw new Error('agent engine unavailable');

    const cwd = this.resolveCwd(input.cwd);
    const title = mcpTaskTitle((input.title ?? '').trim() || prompt);

    const requestedSession = (input.sessionId ?? '').trim();
    let taskId: string;
    if (requestedSession) {
      const existing = this.tasks.get(requestedSession);
      if (existing && (existing.status === 'running' || existing.status === 'aborting')) {
        throw new Error(`session "${requestedSession}" already has a running task (taskId=${existing.taskId})`);
      }
      taskId = requestedSession;
    } else {
      const created = this.createVisibleTask(engine, title, cwd);
      taskId = created.task.id;
      // 真实时同步：新任务立即广播（WebUI 侧边栏零刷新出现新行；与 automation / POST /api/tasks 同口径）
      try {
        this.resolveServer()?.broadcastWS({
          type: 'task.created',
          payload: { task: created.task, ...(created.group ? { group: created.group } : {}) },
        });
      } catch {
        // 广播通道不可用：静默（前端仍可通过刷新拿到列表）
      }
    }

    const record: McpTaskRecord = {
      taskId,
      sessionId: taskId,
      title,
      prompt,
      cwd,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.model ? { model: input.model } : {}),
      permissionMode,
      status: 'running',
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      controller: new AbortController(),
      events: [],
      assistantBuffer: '',
      lastTextStepAt: 0,
    };
    this.tasks.set(taskId, record);
    this.evictIfNeeded();

    this.logger.info('mcp: task dispatched', { taskId, cwd, agentId: record.agentId ?? null, permissionMode });
    void this.execute(record, engine);
    return { taskId, sessionId: record.sessionId, cwd, status: record.status };
  }

  /**
   * 建真实任务（WebUI 侧边栏可见；task.id 即 sessionId），并按工作目录**正常归类**：
   * 与前端发消息（useTask.ensureTaskGroup）/ 自动化（AutomationModule.run）同一规则——
   * 取 cwd 目录名（__system__ → 本机/System）作为 folder 分组名，按名大小写不敏感复用已有分组，
   * 不存在则新建 source='folder' 的分组（空组由 task-store 自动销毁）。
   * 刻意不建专门的 "MCP" 分类。返回 task + group（供 task.created 广播携带分组）。
   */
  private createVisibleTask(engine: AgentEngine, title: string, cwd: string): { task: TaskItem; group?: TaskGroup } {
    const group = this.resolveFolderGroup(engine, cwd);
    const task = engine.createTask(title, group?.id);
    return { task, ...(group ? { group } : {}) };
  }

  /** 目录名 → folder 分组对象（失败返回 undefined，任务落默认分组，不阻断派发） */
  private resolveFolderGroup(engine: AgentEngine, cwd: string): TaskGroup | undefined {
    try {
      const isSystem = cwd === SYSTEM_SCOPE;
      const groupName = isSystem
        ? t('automation.systemGroup')
        : (cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd);
      if (!groupName) return undefined;
      const found = engine.listTaskGroups().find(
        g => g.name.toLowerCase() === groupName.toLowerCase(),
      );
      if (found) return found;
      return engine.createTaskGroup(groupName, 'folder');
    } catch (err) {
      this.logger.warn('mcp: task group resolve failed (task falls back to default group)', {
        cwd,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /** 后台执行：run 的完整生命周期 + 兜底落定（异常绝不外泄到 HTTP 层） */
  private async execute(record: McpTaskRecord, engine: AgentEngine): Promise<void> {
    const host = this.resolveServer();
    try {
      host?.registerExternalRun(record.sessionId, record.controller);
    } catch {
      // 宿主不可用不影响执行
    }
    try {
      const result = await engine.run({
        sessionId: record.sessionId,
        userMessage: record.prompt,
        cwd: record.cwd,
        ...(record.model ? { model: record.model } : {}),
        ...(record.agentId ? { agentId: record.agentId } : {}),
        permissionMode: record.permissionMode,
        onEvent: (event: AgentEvent) => this.onEvent(record, engine, event),
        signal: record.controller.signal,
      });
      this.settleFromResult(record, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = record.controller.signal.aborted;
      this.settle(record, aborted ? 'aborted' : 'error', { error: message });
      // 终态转发：保证已打开该会话页的订阅者能 settle（收尾流式态 + 尾部补齐）。
      // 正常完成经 onEvent 的 done 转发；此处覆盖 run 抛异常（error）与被取消（aborted）。
      try {
        if (aborted) {
          host?.sendToSession(record.sessionId, {
            type: 'task.aborted',
            sessionId: record.sessionId,
            payload: {},
          });
        } else {
          host?.sendAgentEvent(record.sessionId, { type: 'error', sessionId: record.sessionId, message });
        }
      } catch {
        // 转发失败不影响落定
      }
      this.logger.warn('mcp: dispatched task failed', { taskId: record.taskId, error: message });
    } finally {
      try {
        host?.unregisterExternalRun(record.sessionId, record.controller);
      } catch {
        // 静默
      }
      this.evictIfNeeded();
    }
  }

  // ------------------------------------------------------------ 事件记账

  /** AgentEvent → 轨迹/状态（纯内存、无 I/O；任何异常都被吞掉，绝不影响 run） */
  private onEvent(record: McpTaskRecord, engine: AgentEngine, event: AgentEvent): void {
    try {
      // 真实时同步：事件转发到 session 订阅者（与 webui task.stream 同构，高频类型由
      // WsHandler 合帧）。已打开该任务页的客户端实时看到流式消息 / 工具卡片 / done 收尾。
      if (!NON_FORWARDABLE_EVENTS.has(event.type)) {
        this.resolveServer()?.sendAgentEvent(record.sessionId, event);
      }
      record.lastActivityAt = Date.now();
      switch (event.type) {
        case 'assistant-text': {
          record.assistantBuffer = truncate(record.assistantBuffer + (event.text ?? ''), MAX_ASSISTANT_BUFFER);
          const now = Date.now();
          if (now - record.lastTextStepAt >= TEXT_STEP_THROTTLE_MS) {
            record.lastTextStepAt = now;
            this.pushEvent(record, { at: now, kind: 'text', text: truncate(event.text ?? '', MAX_FIELD_CHARS) });
          }
          break;
        }
        case 'tool-call-start': {
          // 新工具开始 → 上一个「当前步骤」文本告一段落
          record.assistantBuffer = '';
          record.lastTextStepAt = 0;
          const argsSummary = summarizeArgs(event.args);
          record.currentTool = { name: event.toolName, argsSummary, startedAt: Date.now() };
          this.pushEvent(record, {
            at: Date.now(),
            kind: 'tool',
            tool: event.toolName,
            toolCallId: event.toolCallId,
            argsSummary,
            startedAtMs: Date.now(),
          });
          break;
        }
        case 'tool-call-end': {
          const entry = this.findOpenToolEntry(record, event.toolCallId, event.toolName);
          const at = Date.now();
          if (entry) {
            entry.resultSummary = summarizeResult(event.result);
            entry.isError = event.result?.isError === true;
            entry.durationMs = entry.startedAtMs ? at - entry.startedAtMs : undefined;
          }
          record.currentTool = undefined;
          break;
        }
        case 'stats-updated': {
          record.stats = event.stats;
          break;
        }
        case 'confirm-required': {
          // 外部派发没有确认通道：安全默认拒绝，否则 run 会永久挂起
          const resolved = engine.resolveConfirm(record.sessionId, event.toolCallId, false, 'session');
          this.pushEvent(record, {
            at: Date.now(),
            kind: 'notice',
            text: `rejected by policy: tool "${event.toolName}" requires confirmation, but an externally dispatched task has no confirmation channel${resolved ? '' : ' (no pending confirm matched)'}`,
          });
          break;
        }
        case 'ask': {
          const resolved = engine.resolveAsk(record.sessionId, event.toolCallId, { action: 'cancel' });
          this.pushEvent(record, {
            at: Date.now(),
            kind: 'notice',
            text: `ask cancelled: externally dispatched tasks have no user channel${resolved ? '' : ' (no pending ask matched)'}${event.questions.length ? ` — ${truncate(event.questions.map((q) => q.question).join(' / '), 160)}` : ''}`,
          });
          break;
        }
        case 'ask-timeout': {
          this.pushEvent(record, { at: Date.now(), kind: 'notice', text: 'ask timed out (no user channel)' });
          break;
        }
        case 'error': {
          record.error = event.message;
          this.pushEvent(record, { at: Date.now(), kind: 'notice', text: `error: ${truncate(event.message, MAX_FIELD_CHARS)}` });
          break;
        }
        case 'done': {
          const finishReason = normalizeFinishReason(event.finishReason);
          this.settle(record, this.statusFromFinishReason(finishReason), { finishReason });
          break;
        }
        default:
          // 其余事件（thinking / skill-mode / tool-call-delta / tool-call-executing 等）只刷新活跃时间
          break;
      }
    } catch (err) {
      this.logger.warn('mcp: trajectory capture failed', {
        taskId: record.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private findOpenToolEntry(record: McpTaskRecord, toolCallId: string | undefined, toolName: string): TrajectoryEntry | undefined {
    for (let i = record.events.length - 1; i >= 0; i--) {
      const e = record.events[i];
      if (e.kind !== 'tool') continue;
      if (e.resultSummary !== undefined) continue;
      if (toolCallId && e.toolCallId && e.toolCallId !== toolCallId) continue;
      if (!toolCallId && e.tool !== toolName) continue;
      return e;
    }
    return undefined;
  }

  private pushEvent(record: McpTaskRecord, entry: TrajectoryEntry): void {
    record.events.push(entry);
    if (record.events.length > MAX_EVENTS) {
      record.events.splice(0, record.events.length - MAX_EVENTS);
    }
  }

  private statusFromFinishReason(finishReason: AgentRunResult['finishReason']): McpTaskStatus {
    if (finishReason === 'error') return 'error';
    if (finishReason === 'aborted') return 'aborted';
    return 'done';
  }

  /** 落定终态（幂等：已终态不改写） */
  private settle(
    record: McpTaskRecord,
    status: McpTaskStatus,
    patch: { error?: string; finishReason?: AgentRunResult['finishReason']; finalText?: string } = {},
  ): void {
    if (record.status === 'done' || record.status === 'error' || record.status === 'aborted') return;
    record.status = status;
    record.endedAt = Date.now();
    if (patch.error !== undefined) record.error = patch.error;
    if (patch.finishReason !== undefined) record.finishReason = patch.finishReason;
    if (patch.finalText !== undefined) record.finalText = truncate(patch.finalText, MAX_FINAL_TEXT);
    record.summaryCache = undefined;
  }

  /** run 正常返回后的兜底落定（done 事件未到时也保证有终态） */
  private settleFromResult(record: McpTaskRecord, result: AgentRunResult): void {
    if (record.finalText === undefined) record.finalText = truncate(result.finalText ?? '', MAX_FINAL_TEXT);
    if (result.finishReason === 'aborted' || record.controller.signal.aborted) {
      this.settle(record, 'aborted', { finishReason: 'aborted' });
      return;
    }
    this.settle(record, this.statusFromFinishReason(result.finishReason), { finishReason: result.finishReason });
  }

  // ------------------------------------------------------------ 查询/取消

  get(taskId: string): McpTaskRecord | null {
    return this.tasks.get(taskId) ?? null;
  }

  /** 列出任务（最新在前） */
  list(opts: { limit?: number; status?: McpTaskStatus } = {}): McpTaskRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    let items = [...this.tasks.values()];
    if (opts.status) items = items.filter(t => t.status === opts.status);
    items.sort((a, b) => b.startedAt - a.startedAt);
    return items.slice(0, limit);
  }

  /** 取消运行中的任务；返回结果文案（失败原因由调用方转 isError） */
  cancel(taskId: string): { ok: boolean; status: McpTaskStatus; note?: string; error?: string } {
    const record = this.tasks.get(taskId);
    if (!record) {
      return { ok: false, status: 'error', error: `unknown task "${taskId}"` };
    }
    if (record.status !== 'running' && record.status !== 'aborting') {
      return { ok: false, status: record.status, note: `task already finished with status "${record.status}"` };
    }
    record.status = 'aborting';
    record.summaryCache = undefined;
    try {
      record.controller.abort();
    } catch {
      // 静默
    }
    return { ok: true, status: record.status, note: 'abort signal sent; poll moss_task_status until status becomes aborted' };
  }

  /** 进程退出/模块销毁：中止全部运行中任务，避免悬挂 run */
  dispose(): void {
    for (const record of this.tasks.values()) {
      if (record.status === 'running' || record.status === 'aborting') {
        try {
          record.controller.abort();
        } catch {
          // 静默
        }
      }
    }
  }

  /** 超限淘汰：只淘汰终态任务（运行中的永不淘汰），最旧的先走 */
  private evictIfNeeded(): void {
    if (this.tasks.size <= MAX_TASKS) return;
    const finished = [...this.tasks.values()]
      .filter(t => t.status !== 'running' && t.status !== 'aborting')
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
    let overflow = this.tasks.size - MAX_TASKS;
    for (const record of finished) {
      if (overflow <= 0) break;
      this.tasks.delete(record.taskId);
      this.summaryInflight.delete(record.taskId);
      overflow--;
    }
  }

  // ------------------------------------------------------------ 视图

  /**
   * 组装轮询视图。摘要是否计算由 config.mcpServer.trackSummary 决定（关闭时
   * summary=null 且带 summaryError 说明原因，避免调用方误以为摘要失败）。
   */
  async view(taskId: string, opts: { trajectorySteps?: number } = {}): Promise<McpTaskView | null> {
    const record = this.tasks.get(taskId);
    if (!record) return null;
    const steps = Math.min(Math.max(opts.trajectorySteps ?? 8, 1), 30);
    const now = Date.now();
    const view: McpTaskView = {
      taskId: record.taskId,
      sessionId: record.sessionId,
      title: record.title,
      cwd: record.cwd,
      ...(record.agentId ? { agentId: record.agentId } : {}),
      ...(record.model ? { model: record.model } : {}),
      permissionMode: record.permissionMode,
      status: record.status,
      ...(record.finishReason ? { finishReason: record.finishReason } : {}),
      startedAt: record.startedAt,
      ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
      elapsedMs: (record.endedAt ?? now) - record.startedAt,
      lastActivityAt: record.lastActivityAt,
      idleMs: now - record.lastActivityAt,
      currentStep: this.currentStep(record),
      recentSteps: record.events.slice(-steps).map(e => this.toPublicStep(e)),
      todos: this.readTodos(record.sessionId),
      summary: null,
      ...(record.stats
        ? {
            stats: {
              turns: record.stats.turns,
              steps: record.stats.steps,
              inputTokens: record.stats.inputTokens,
              outputTokens: record.stats.outputTokens,
              cachedTokens: record.stats.cachedTokens,
            },
          }
        : {}),
    };
    if (view.status !== 'running' && view.status !== 'aborting') {
      view.result = record.finalText ?? '';
    }
    if (record.error && !view.result) {
      view.note = `run error: ${truncate(record.error, 600)}`;
    }
    const s = await this.summarize(record, view);
    view.summary = s.text;
    if (s.error) view.summaryError = s.error;
    return view;
  }

  private toPublicStep(entry: TrajectoryEntry): McpTrajectoryStep {
    return {
      at: entry.at,
      kind: entry.kind,
      ...(entry.tool ? { tool: entry.tool } : {}),
      ...(entry.argsSummary ? { argsSummary: entry.argsSummary } : {}),
      ...(entry.resultSummary !== undefined ? { resultSummary: entry.resultSummary } : {}),
      ...(entry.isError !== undefined ? { isError: entry.isError } : {}),
      ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      ...(entry.text ? { text: entry.text } : {}),
    };
  }

  private currentStep(record: McpTaskRecord): McpTaskView['currentStep'] {
    if (record.currentTool) {
      return { kind: 'tool', tool: record.currentTool.name, argsSummary: record.currentTool.argsSummary };
    }
    const text = record.assistantBuffer.trim();
    if (text) return { kind: 'text', text: truncate(text, 600) };
    return null;
  }

  /** 读会话 todo（文件不存在/损坏 → 空数组，绝不影响轮询） */
  private readTodos(sessionId: string): McpTaskView['todos'] {
    try {
      const store = readSessionTodoStore(getSessionTodoPath(this.env, sessionId));
      return store.items.map((it: TodoItem) => ({
        id: it.id,
        text: it.text,
        status: it.status,
        priority: it.priority,
      }));
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------ 摘要

  /** 摘要是否开启（config.mcpServer.trackSummary !== false，默认开） */
  summaryEnabled(): boolean {
    try {
      return this.config.getAppConfig().mcpServer?.trackSummary !== false;
    } catch {
      return false;
    }
  }

  /**
   * 轨迹摘要（LLM）。任何失败都降级为 { text: null, error }，绝不抛出。
   * 终态任务的摘要只算一次；运行中任务 20s 内复用缓存。
   */
  private summarize(record: McpTaskRecord, view: McpTaskView): Promise<{ text: string | null; error?: string }> {
    if (!this.summaryEnabled()) return Promise.resolve({ text: null, error: 'trackSummary disabled' });

    const cached = record.summaryCache;
    if (cached) {
      const terminal = record.status !== 'running' && record.status !== 'aborting';
      // 终态：缓存永久有效（终态后不再变化）；运行中：只在窗口内复用
      if (terminal || Date.now() - cached.at < SUMMARY_CACHE_MS) {
        return Promise.resolve(cached.text === null ? { text: null, ...(cached.error ? { error: cached.error } : {}) } : { text: cached.text });
      }
    }

    const inflight = this.summaryInflight.get(record.taskId);
    if (inflight) return inflight;

    const task = (async (): Promise<{ text: string | null; error?: string }> => {
      const outcome = await this.callSummaryModel(record, view);
      record.summaryCache = { text: outcome.text, ...(outcome.error ? { error: outcome.error } : {}), at: Date.now() };
      return outcome;
    })().finally(() => {
      this.summaryInflight.delete(record.taskId);
    });
    this.summaryInflight.set(record.taskId, task);
    return task;
  }

  private async callSummaryModel(record: McpTaskRecord, view: McpTaskView): Promise<{ text: string | null; error?: string }> {
    const llm = this.services.tryResolve<LLMRouter>(ServiceNames.LLM_ROUTER);
    if (!llm) return { text: null, error: 'llm router unavailable' };

    let model: string;
    try {
      const app = this.config.getAppConfig();
      const main = app.agent?.defaultModel || '';
      const configured = app.context?.compaction?.summaryModel ?? 'inherit';
      const apiModels = flattenModels(this.config.getApiConfig()).map(m => ({ id: m.id, model: m.model }));
      model = resolveSummaryModel(configured, main, apiModels).requestModel;
    } catch (err) {
      return { text: null, error: `summary model unresolved: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!model) return { text: null, error: 'summary model unresolved (empty model name)' };

    // 摘要系统提示词从 agent/prompts/mcp/task-summary.md 加载；缺失则放弃摘要（降级）
    const systemPrompt = loadPromptFileOrNull(this.env, 'mcp/task-summary.md');
    if (!systemPrompt) return { text: null, error: 'task summary prompt missing' };

    const payload = this.buildSummaryInput(record, view);
    try {
      const response = await llm.complete(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: payload },
          ],
          stream: false,
          max_tokens: SUMMARY_MAX_TOKENS,
        },
        AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      );
      const text = (response.content ?? '').trim();
      if (!text) return { text: null, error: 'summarizer returned empty output' };
      if (response.finish_reason === 'length') {
        // 截断也返回（比没有好），但如实标注
        return { text: truncate(text, 1200), error: 'summary truncated (finish_reason=length)' };
      }
      return { text: truncate(text, 1200) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { text: null, error: `summary call failed: ${truncate(message, 200)}` };
    }
  }

  /** 摘要输入：严格裁剪（工具名 + 参数摘要 + 结果首尾截断 + todos + 当前文本），总长受控 */
  private buildSummaryInput(record: McpTaskRecord, view: McpTaskView): string {
    const lines: string[] = [
      `task: ${record.title}`,
      `prompt: ${truncate(record.prompt, 800)}`,
      `status: ${view.status}${view.finishReason ? ` (finishReason=${view.finishReason})` : ''}`,
      `elapsed: ${Math.round(view.elapsedMs / 1000)}s, steps: ${view.stats?.steps ?? 0}, turns: ${view.stats?.turns ?? 0}`,
    ];
    if (view.todos.length > 0) {
      lines.push('todos:');
      for (const t of view.todos.slice(0, 20)) {
        lines.push(`  - [${t.status}] ${truncate(t.text, 120)}`);
      }
    }
    const steps = record.events.slice(-20);
    if (steps.length > 0) {
      lines.push('recent trajectory:');
      for (const s of steps) {
        if (s.kind === 'text') {
          lines.push(`  - assistant: ${truncate(s.text ?? '', 240)}`);
        } else if (s.kind === 'notice') {
          lines.push(`  - notice: ${truncate(s.text ?? '', 240)}`);
        } else {
          const res = s.resultSummary ? truncate(s.resultSummary, 300) : '(running)';
          lines.push(`  - tool ${s.tool}: args=${truncate(s.argsSummary ?? '', 200)} -> ${res}${s.isError ? ' [error]' : ''}`);
        }
      }
    }
    if (record.assistantBuffer.trim()) {
      lines.push(`current output: ${truncate(record.assistantBuffer.trim(), 600)}`);
    }
    if (view.result) {
      lines.push(`final result: ${truncate(view.result, 600)}`);
    }
    return truncate(lines.join('\n'), SUMMARY_INPUT_CHARS);
  }

  // ------------------------------------------------------------ 会话

  /** 列出会话（含由首条用户消息派生的标题，便于外部 Agent 选择续跑的会话） */
  listSessions(limit: number): { items: McpSessionInfo[]; note?: string } {
    const engine = this.services.tryResolve<EngineWithExtras>(ServiceNames.AGENT_ENGINE);
    if (!engine) return { items: [], note: 'agent engine unavailable' };
    if (typeof engine.listSessions !== 'function') {
      return { items: [], note: 'engine does not expose listSessions()' };
    }
    let raw: Array<{ id: string; createdAt: string; updatedAt: string; messageCount: number }>;
    try {
      raw = engine.listSessions();
    } catch (err) {
      return { items: [], note: `listSessions failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const cap = Math.min(Math.max(limit, 1), 50);
    const sorted = [...raw].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    const items = sorted.slice(0, cap).map((s): McpSessionInfo => ({
      sessionId: s.id,
      title: this.deriveTitle(engine, s.id),
      createdAt: s.createdAt ?? '',
      updatedAt: s.updatedAt ?? '',
      messageCount: typeof s.messageCount === 'number' ? s.messageCount : 0,
    }));
    return { items, ...(raw.length > cap ? { note: `showing ${cap} of ${raw.length} sessions (latest first)` } : {}) };
  }

  /** 会话标题：首条用户消息截断（引擎无 title 字段，如实派生） */
  private deriveTitle(engine: EngineWithExtras, sessionId: string): string | null {
    if (typeof engine.getHistory !== 'function') return null;
    try {
      const first = engine.getHistory(sessionId).find(m => m.role === 'user' && !m.deletedAt);
      if (!first) return null;
      const text = (first.content ?? '').replace(/\s+/g, ' ').trim();
      return text ? truncate(text, 60) : null;
    } catch {
      return null;
    }
  }

  /** 读会话历史（裁剪为可读摘要视图） */
  readSession(
    sessionId: string,
    limit: number,
    includeToolResults: boolean,
  ): { items: Array<{ role: string; content: string; timestamp?: string; toolName?: string; isError?: boolean }>; note?: string } {
    const engine = this.services.tryResolve<EngineWithExtras>(ServiceNames.AGENT_ENGINE);
    if (!engine) return { items: [], note: 'agent engine unavailable' };
    if (typeof engine.getHistory !== 'function') {
      return { items: [], note: 'engine does not expose getHistory()' };
    }
    let history: AgentMessage[];
    try {
      history = engine.getHistory(sessionId);
    } catch (err) {
      return { items: [], note: `getHistory failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (history.length === 0) {
      return { items: [], note: `session "${sessionId}" has no history (unknown session or MOSS restarted)` };
    }
    const cap = Math.min(Math.max(limit, 1), 50);
    const tail = history.slice(-cap);
    const items = tail
      .filter(m => includeToolResults || (m.role !== 'tool' && !m.deletedAt))
      .map((m) => ({
        role: m.role,
        content: truncate(m.content ?? '', 600),
        ...(m.timestamp ? { timestamp: m.timestamp } : {}),
        ...(m.name ? { toolName: m.name } : {}),
        ...(m.isError !== undefined ? { isError: m.isError } : {}),
      }));
    return { items, ...(history.length > cap ? { note: `showing last ${cap} of ${history.length} messages` } : {}) };
  }

  // ------------------------------------------------------------ 基础设施

  private resolveEngine(): AgentEngine | null {
    return this.services.tryResolve<AgentEngine>(ServiceNames.AGENT_ENGINE);
  }

  /** Server 实例（WS 广播 / 事件转发 / 外部 run 注册）；模块加载顺序不定，按需惰性解析 */
  private resolveServer(): ServerHost | null {
    return this.services.tryResolve<ServerHost>(ServiceNames.SERVER_INSTANCE);
  }

  /** 默认工作目录（与 ws-handler 口径一致） */
  baseCwd(): string {
    return this.configuredWorkingDirectory() || process.cwd();
  }

  /**
   * cwd 解析（方法封装）：必填 + 校验规则见 resolveTaskCwd。
   * @throws CwdRejectedError 缺失/受保护目录/不存在
   */
  resolveCwd(raw: string): string {
    return resolveTaskCwd(raw, this.baseCwd());
  }

  /**
   * 「已保存的目录」列表（供 moss_list_workspaces）：
   * 默认工作目录（config）→ 授权 roots（filesys）→ 本进程派发历史。
   */
  listWorkspaces(): WorkspaceEntry[] {
    return buildWorkspaceList({
      workingDirectory: this.configuredWorkingDirectory(),
      roots: this.filesysRoots(),
      history: this.list({ limit: 50 }).map(record => ({ cwd: record.cwd, startedAt: record.startedAt })),
    });
  }

  /** 当前生效的授权 roots（filesys 不可用时返回空数组） */
  private filesysRoots(): string[] {
    const filesys = this.services.tryResolve<{ listRoots?(): string[] }>(ServiceNames.FILESYS);
    if (!filesys || typeof filesys.listRoots !== 'function') return [];
    try {
      return filesys.listRoots();
    } catch {
      return [];
    }
  }

  /** 配置的默认工作目录（未配置时返回空串，由 baseCwd 回退 process.cwd()） */
  private configuredWorkingDirectory(): string {
    try {
      return this.config.getAppConfig().agent?.workingDirectory ?? '';
    } catch {
      return '';
    }
  }
}