// src/modules/mcp/agent-tools.ts
// MCP 对外暴露的 agent 级工具集（moss_*）。
//
// 定位：外部 Agent 通过这组工具「驱动 MOSS」——派发任务、轮询进度、管理自动化、查看会话，
// 而不是拿 MOSS 的内部工具（read/glob/terminal…）替 MOSS 做文件操作。
//
// 本文件不依赖 ToolRegistry：工具由暴露层直接持有，避免污染内部工具面，
// 也让 HTTP 端点与 stdio 入口共用同一份契约。

import { t } from '../../core/i18n';
import { ServiceNames } from '../../core/types';
import type { ToolResult } from '../tools/types';
import { errorResult } from '../tools/types';
import type { AutomationService } from '../automation';
import { SYSTEM_SCOPE } from '../filesys/roots';
import type { ExposureDeps } from './expose';
import {
  buildWorkspaceList,
  CwdRejectedError,
  McpTaskRegistry,
  resolveTaskCwd,
  type McpTaskStatus,
  type McpTaskView,
  type WorkspaceEntry,
} from './task-registry';

/** 单次状态响应的字符上限（保护调用方上下文） */
const VIEW_CHAR_BUDGET = 8000;

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execute(args: Record<string, unknown>, deps: ExposureDeps): Promise<ToolResult>;
}

// ============================================================================
// 参数小工具（外部输入不可信，逐项收窄）
// ============================================================================

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readInt(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const v = args[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function readBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = args[key];
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

/** 便捷构造：文本 + 结构化内容（expose 的 toCallToolResult 会把 metadata.structured 映射为 structuredContent） */
function asResult(text: string, structuredValue: unknown, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
    metadata: { structured: structuredValue },
  };
}

/** asResult 的调用点语法糖：保持「先结构化载荷、后文本」的可读顺序 */
function structured(wrapper: { metadata: { structured: unknown } }, text: string): ToolResult {
  return asResult(text, wrapper.metadata.structured);
}

function needRegistry(deps: ExposureDeps): McpTaskRegistry | null {
  return deps.services.tryResolve<McpTaskRegistry>(ServiceNames.MCP_TASK_REGISTRY);
}

/**
 * 默认工作目录基准（与 ws-handler / 注册表同口径）。
 */
function baseCwdOf(deps: ExposureDeps): string {
  try {
    const wd = deps.config.getAppConfig().agent?.workingDirectory ?? '';
    if (wd.trim()) return wd;
  } catch {
    // 配置不可用 → 退回进程 cwd
  }
  return process.cwd();
}

/**
 * cwd 解析（派发任务与自动化创建共用）：
 * 直接走导出的纯函数 resolveTaskCwd —— 不依赖注册表实例，规则只有一处实现。
 */
function resolveCwdArg(deps: ExposureDeps, raw?: string): { ok: true; cwd: string } | { ok: false; error: string } {
  try {
    return { ok: true, cwd: resolveTaskCwd(raw ?? '', baseCwdOf(deps)) };
  } catch (err) {
    if (err instanceof CwdRejectedError) return { ok: false, error: err.message };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================================================
// 视图渲染与收敛
// ============================================================================

function fmtTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 按「先丢最旧轨迹 → 再截 summary → 最后截 result」收敛到字符预算内 */
function shrinkView(view: McpTaskView): McpTaskView {
  const size = (): number => JSON.stringify(view).length;
  if (size() <= VIEW_CHAR_BUDGET) return view;

  while (view.recentSteps.length > 1 && size() > VIEW_CHAR_BUDGET) {
    view.recentSteps.shift();
  }
  if (size() > VIEW_CHAR_BUDGET && view.summary && view.summary.length > 400) {
    view.summary = `${view.summary.slice(0, 400)}…[truncated]`;
  }
  if (size() > VIEW_CHAR_BUDGET && view.result && view.result.length > 4000) {
    view.result = `${view.result.slice(0, 4000)}…[truncated]`;
  }
  if (size() > VIEW_CHAR_BUDGET && view.result && view.result.length > 1200) {
    view.result = `${view.result.slice(0, 1200)}…[truncated]`;
  }
  if (size() > VIEW_CHAR_BUDGET) {
    view.recentSteps = view.recentSteps.slice(-3);
  }
  return view;
}

function renderTaskView(view: McpTaskView): string {
  const head = `task ${view.taskId} [${view.status}] ${fmtSeconds(view.elapsedMs)} elapsed, idle ${fmtSeconds(view.idleMs)}`;
  const lines: string[] = [head];
  lines.push(`title: ${view.title}`);
  lines.push(`cwd: ${view.cwd}`);
  if (view.agentId) lines.push(`agentId: ${view.agentId}`);
  if (view.finishReason) lines.push(`finishReason: ${view.finishReason}`);
  if (view.currentStep) {
    lines.push(
      view.currentStep.kind === 'tool'
        ? `current step: tool ${view.currentStep.tool} ${view.currentStep.argsSummary ?? ''}`
        : `current step: ${view.currentStep.text ?? ''}`,
    );
  }
  if (view.stats) {
    lines.push(
      `stats: turns=${view.stats.turns} steps=${view.stats.steps} in=${view.stats.inputTokens} out=${view.stats.outputTokens} cached=${view.stats.cachedTokens}`,
    );
  }
  if (view.todos.length > 0) {
    lines.push(`todos (${view.todos.length}):`);
    for (const todo of view.todos.slice(0, 20)) {
      lines.push(`  - [${todo.status}] (${todo.priority}) ${todo.text}`);
    }
  }
  if (view.recentSteps.length > 0) {
    lines.push('recent steps:');
    for (const step of view.recentSteps) {
      if (step.kind === 'text') {
        lines.push(`  - ${fmtTime(step.at)} assistant: ${step.text ?? ''}`);
      } else if (step.kind === 'notice') {
        lines.push(`  - ${fmtTime(step.at)} notice: ${step.text ?? ''}`);
      } else {
        const dur = step.durationMs !== undefined ? ` (${step.durationMs}ms)` : '';
        const res = step.resultSummary !== undefined ? step.resultSummary : '(running)';
        lines.push(`  - ${fmtTime(step.at)} tool ${step.tool}${dur} args=${step.argsSummary ?? '{}'} -> ${res}${step.isError ? ' [error]' : ''}`);
      }
    }
  }
  if (view.summary) lines.push(`summary: ${view.summary}`);
  else if (view.summaryError) lines.push(`summary: unavailable (${view.summaryError})`);
  if (view.result !== undefined) lines.push(`result:\n${view.result}`);
  if (view.note) lines.push(`note: ${view.note}`);
  return lines.join('\n');
}

// ============================================================================
// 工具定义
// ============================================================================

const STATUS_TEXT_HINT =
  'Poll this to follow progress. Pass the taskId returned by moss_dispatch_task.';

/** 构造 agent 级工具集（registry 为 MCP 任务注册表；未就绪时相关工具返回明确错误） */
export function createAgentTools(registry: McpTaskRegistry | null): AgentTool[] {
  const tools: AgentTool[] = [];

  // ----------------------------------------------------------- 派发任务
  tools.push({
    name: 'moss_dispatch_task',
    description:
      'Dispatch a task to MOSS (an autonomous coding agent running on this machine) and return immediately with a taskId. ' +
      'MOSS runs the task in its own session with its own tools, working directory and model, so this is the way to delegate real work to MOSS ' +
      '(e.g. "refactor module X", "investigate why the build breaks", "write tests for Y"). ' +
      'Execution is ASYNCHRONOUS: poll moss_task_status with the returned taskId to follow progress and get the final result. ' +
      'NOTE: MOSS cannot ask for confirmation on externally dispatched tasks — tools that require confirmation are auto-rejected ' +
      '(pass permissionMode="skip" only if you intend to grant full access). ' +
      'cwd is REQUIRED: give an absolute path of an existing local directory (or "__system__" for full-disk access). ' +
      'Call moss_list_workspaces first to see the directories MOSS already has saved. ' +
      'The created session shows up in the MOSS UI as "[MCP] <title>", grouped under the working directory like a normal session.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Self-contained task description. MOSS sees only this text.' },
        cwd: {
          type: 'string',
          description:
            'REQUIRED. Working directory: absolute path of an existing local directory, or "__system__" for full-disk access ' +
            '(MOSS\'s own ~/.moss data directory stays blocked). See moss_list_workspaces for saved directories.',
        },
        title: { type: 'string', description: 'Short task title shown in the MOSS UI (defaults to the prompt). Displayed as "[MCP] …".' },
        agentId: { type: 'string', description: 'MOSS agent profile id to run with (e.g. agent_explorer / agent_coder). Optional.' },
        model: { type: 'string', description: 'Override the model name for this task. Optional.' },
        sessionId: {
          type: 'string',
          description: 'Reuse an existing MOSS session to continue a previous conversation instead of creating a new one.',
        },
        permissionMode: {
          type: 'string',
          enum: ['ask', 'auto', 'skip'],
          description: 'Permission mode: "auto" (default) auto-approves low risk and rejects high risk; "skip" grants full access.',
        },
      },
      required: ['prompt', 'cwd'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async execute(args, deps) {
      const reg = needRegistry(deps);
      if (!reg) return errorResult('task registry not ready (MCP module still initializing) — retry shortly');
      const prompt = readString(args, 'prompt');
      if (!prompt) return errorResult('prompt is required');
      const cwdInput = readString(args, 'cwd');
      if (!cwdInput) {
        return errorResult('cwd is required: pass an existing local directory (or "__system__"); use moss_list_workspaces to see saved directories');
      }
      // 显式传入的 permissionMode 必须合法：静默降级会让调用方以为拿到了 'skip'
      const permissionMode = readString(args, 'permissionMode');
      if (permissionMode !== undefined && permissionMode !== 'ask' && permissionMode !== 'auto' && permissionMode !== 'skip') {
        return errorResult(`invalid permissionMode "${permissionMode}" (expect ask|auto|skip)`);
      }
      try {
        const result = reg.dispatch({
          prompt,
          cwd: cwdInput,
          ...(readString(args, 'title') ? { title: readString(args, 'title') as string } : {}),
          ...(readString(args, 'agentId') ? { agentId: readString(args, 'agentId') as string } : {}),
          ...(readString(args, 'model') ? { model: readString(args, 'model') as string } : {}),
          ...(readString(args, 'sessionId') ? { sessionId: readString(args, 'sessionId') as string } : {}),
          ...(permissionMode ? { permissionMode } : {}),
        });
        const payload = {
          taskId: result.taskId,
          sessionId: result.sessionId,
          status: result.status,
          cwd: result.cwd,
          hint: 'Use moss_task_status with this taskId to poll progress; moss_task_cancel to stop it.',
        };
        return {
          content: [
            {
              type: 'text',
              text: `task dispatched (async)\n${JSON.stringify(payload, null, 2)}`,
            },
          ],
          metadata: { structured: payload },
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ----------------------------------------------------------- 目录列表
  tools.push({
    name: 'moss_list_workspaces',
    description:
      'List the working directories MOSS has saved, so you can pick a "cwd" for moss_dispatch_task / moss_automation (which both REQUIRE cwd). ' +
      'Returns the configured default working directory, MOSS\'s authorized roots, and directories used by previous dispatches in this MOSS process. ' +
      'This list is a convenience, not a restriction: you may pass ANY existing local directory as cwd, or "__system__" for full-disk access ' +
      '(MOSS\'s own ~/.moss data directory is always blocked).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async execute(_args, deps) {
      const reg = needRegistry(deps);
      // 注册表未就绪时仍给出配置侧目录（root/历史缺失不影响工具可用）
      let workspaces: WorkspaceEntry[];
      if (reg) {
        workspaces = reg.listWorkspaces();
      } else {
        let workingDirectory = '';
        try {
          workingDirectory = deps.config.getAppConfig().agent?.workingDirectory ?? '';
        } catch {
          workingDirectory = '';
        }
        const filesys = deps.services.tryResolve<{ listRoots?(): string[] }>(ServiceNames.FILESYS);
        let roots: string[] = [];
        if (filesys && typeof filesys.listRoots === 'function') {
          try {
            roots = filesys.listRoots();
          } catch {
            roots = [];
          }
        }
        workspaces = buildWorkspaceList({ workingDirectory, roots, history: [] });
      }
      const payload = {
        cwdRequired: true,
        systemScope: {
          value: SYSTEM_SCOPE,
          label: '本机（全盘可访问）',
          note: `full-disk access; relative paths resolve from the system drive root (C:\\ on Windows, / otherwise). MOSS's own ~/.moss data directory stays blocked.`,
        },
        workspaces,
        note: reg
          ? 'Directories MOSS already has saved. Any existing local directory is accepted as cwd.'
          : 'The MCP task registry is not ready yet, so only configuration-based directories are listed.',
        hint: 'If the directory you need is missing, it can still be passed directly as cwd (it only has to exist on this machine).',
      };
      return structured({ metadata: { structured: payload } }, JSON.stringify(payload, null, 2));
    },
  });

  // ----------------------------------------------------------- 任务状态
  tools.push({
    name: 'moss_task_status',
    description:
      'Get the live status of a task dispatched via moss_dispatch_task: current step, recent tool/text trajectory, todos, run stats, ' +
      'an LLM-written trajectory summary, and (once finished) the final result text. ' +
      'Call it repeatedly to follow progress. ' +
      `${STATUS_TEXT_HINT}`,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id returned by moss_dispatch_task (same as the MOSS session id).' },
        trajectorySteps: { type: 'integer', description: 'How many recent trajectory steps to include (1-30, default 8).' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async execute(args, deps) {
      const reg = needRegistry(deps);
      if (!reg) return errorResult('task registry not ready (MCP module still initializing) — retry shortly');
      const taskId = readString(args, 'taskId');
      if (!taskId) return errorResult('taskId is required');
      const trajectorySteps = readInt(args, 'trajectorySteps', 8, 1, 30);
      try {
        const view = await reg.view(taskId, { trajectorySteps });
        if (!view) {
          return errorResult(
            `unknown task "${taskId}". This registry only tracks tasks dispatched in the current MOSS process; ` +
              'use moss_list_tasks to see live ones. If MOSS restarted, read the session history instead (moss_read_session with the session id).',
          );
        }
        const slim = shrinkView(view);
        return structured({ metadata: { structured: slim } }, renderTaskView(slim));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ----------------------------------------------------------- 取消任务
  tools.push({
    name: 'moss_task_cancel',
    description:
      'Cancel a running task dispatched via moss_dispatch_task (sends the abort signal; the task then settles as "aborted"). ' +
      'Poll moss_task_status until the status changes.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task id returned by moss_dispatch_task.' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async execute(args, deps) {
      const reg = needRegistry(deps);
      if (!reg) return errorResult('task registry not ready (MCP module still initializing) — retry shortly');
      const taskId = readString(args, 'taskId');
      if (!taskId) return errorResult('taskId is required');
      try {
        const outcome = reg.cancel(taskId);
        if (!outcome.ok) {
          return errorResult(
            outcome.error
              ? `${outcome.error}; use moss_list_tasks to see tracked tasks`
              : `cannot cancel: ${outcome.note ?? 'task is not running'}`,
          );
        }
        const payload = { taskId, status: outcome.status, note: outcome.note };
        return structured({ metadata: { structured: payload } }, `cancel requested\n${JSON.stringify(payload, null, 2)}`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ----------------------------------------------------------- 任务列表
  tools.push({
    name: 'moss_list_tasks',
    description:
      'List tasks dispatched to MOSS through this MCP server in the current MOSS process (newest first), so you can find a taskId again.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max entries (1-50, default 20).' },
        status: {
          type: 'string',
          enum: ['running', 'aborting', 'done', 'error', 'aborted'],
          description: 'Only show tasks in this status.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async execute(args, deps) {
      const reg = needRegistry(deps);
      if (!reg) return errorResult('task registry not ready (MCP module still initializing) — retry shortly');
      const limit = readInt(args, 'limit', 20, 1, 50);
      const status = readString(args, 'status') as McpTaskStatus | undefined;
      const allowed: McpTaskStatus[] = ['running', 'aborting', 'done', 'error', 'aborted'];
      if (status && !allowed.includes(status)) {
        return errorResult(`invalid status "${status}" (expect ${allowed.join('|')})`);
      }
      try {
        const now = Date.now();
        const items = reg.list({ limit, ...(status ? { status } : {}) }).map(record => ({
          taskId: record.taskId,
          sessionId: record.sessionId,
          title: record.title,
          status: record.status,
          startedAt: new Date(record.startedAt).toISOString(),
          elapsedMs: (record.endedAt ?? now) - record.startedAt,
        }));
        const payload = { count: items.length, tasks: items };
        return structured({ metadata: { structured: payload } }, JSON.stringify(payload, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ----------------------------------------------------------- 自动化任务
  tools.push({
    name: 'moss_automation',
    description:
      'Create and manage MOSS scheduled automations (cron or one-off). An automation stores a prompt + working directory that MOSS runs on schedule. ' +
      'Actions: create | list | get | update | delete | trigger | pause | resume | history. ' +
      'create requires title, prompt and cwd — cwd must be an absolute path of an existing local directory (or "__system__" for full-disk access); ' +
      'call moss_list_workspaces to see saved directories. ' +
      'trigger runs it immediately and returns a runId.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'get', 'update', 'delete', 'trigger', 'pause', 'resume', 'history'],
          description: 'Operation to perform.',
        },
        id: { type: 'string', description: 'Automation id (required except for create/list).' },
        title: { type: 'string', description: 'Automation title (create: required).' },
        description: { type: 'string', description: 'Optional description.' },
        icon: { type: 'string', description: 'Optional icon name.' },
        scheduleType: { type: 'string', enum: ['cron', 'once'], description: 'Schedule kind (default cron).' },
        cron: { type: 'string', description: 'Cron expression when scheduleType=cron, e.g. "0 9 * * 1-5".' },
        runAt: { type: 'string', description: 'ISO timestamp when scheduleType=once.' },
        prompt: { type: 'string', description: 'Prompt MOSS runs on each trigger (create: required).' },
        cwd: { type: 'string', description: 'Working directory the automation runs in.' },
        agentId: { type: 'string', description: 'MOSS agent profile id to run with.' },
        enabled: { type: 'boolean', description: 'Whether the automation is scheduled at all.' },
        paused: { type: 'boolean', description: 'Whether the automation is temporarily paused.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async execute(args, deps) {
      const svc = deps.services.tryResolve<AutomationService>(ServiceNames.AUTOMATION_SERVICE);
      if (!svc) return errorResult(t('tools.automationServiceUnavailable'));
      const action = readString(args, 'action');
      if (!action) return errorResult('action is required');

      // cwd 必填（与派发任务同一规则）；update 仅在显式提供 cwd 时校验并改写
      let cwdInput = readString(args, 'cwd');
      if (action === 'create') {
        if (!cwdInput) {
          return errorResult('cwd is required: pass an existing local directory (or "__system__"); use moss_list_workspaces to see saved directories');
        }
        const resolved = resolveCwdArg(deps, cwdInput);
        if (!resolved.ok) return errorResult(resolved.error);
        cwdInput = resolved.cwd;
      } else if (action === 'update' && cwdInput) {
        const resolved = resolveCwdArg(deps, cwdInput);
        if (!resolved.ok) return errorResult(resolved.error);
        cwdInput = resolved.cwd;
      }

      try {
        switch (action) {
          case 'create': {
            const title = readString(args, 'title');
            const prompt = readString(args, 'prompt');
            if (!title) return errorResult(t('tools.automationTitleRequired'));
            if (!prompt) return errorResult(t('tools.automationPromptRequired'));
            if (!cwdInput) return errorResult(t('tools.automationCwdRequired'));
            const item = svc.create({
              title,
              prompt,
              cwd: cwdInput,
              ...(readString(args, 'description') ? { description: readString(args, 'description') as string } : {}),
              ...(readString(args, 'icon') ? { icon: readString(args, 'icon') as string } : {}),
              ...(readString(args, 'agentId') ? { agentId: readString(args, 'agentId') as string } : {}),
              ...(readString(args, 'scheduleType') === 'cron' || readString(args, 'scheduleType') === 'once'
                ? { scheduleType: readString(args, 'scheduleType') as 'cron' | 'once' }
                : {}),
              ...(readString(args, 'cron') ? { cron: readString(args, 'cron') as string } : {}),
              ...(readString(args, 'runAt') ? { runAt: readString(args, 'runAt') as string } : {}),
            });
            const payload = { action, id: item.id, item };
            return structured({ metadata: { structured: payload } }, `${t('tools.automationCreated')}:\n${JSON.stringify(item, null, 2)}`);
          }
          case 'update': {
            const id = readString(args, 'id');
            if (!id) return errorResult(t('tools.automationIdRequired'));
            const updatable = [
              'title',
              'description',
              'icon',
              'scheduleType',
              'cron',
              'runAt',
              'prompt',
              'agentId',
              'enabled',
              'paused',
            ];
            const patch: Record<string, unknown> = {};
            for (const key of updatable) {
              const value = args[key];
              if (value !== undefined && value !== null && value !== '') patch[key] = value;
            }
            if (cwdInput) patch.cwd = cwdInput;
            if (Object.keys(patch).length === 0) return errorResult(t('tools.automationIdRequired'));
            const item = svc.update(id, patch);
            if (!item) return errorResult(t('tools.automationNotFound', { id }));
            const payload = { action, id: item.id, item };
            return structured({ metadata: { structured: payload } }, `${t('tools.automationUpdated')}:\n${JSON.stringify(item, null, 2)}`);
          }
          case 'delete': {
            const id = readString(args, 'id');
            if (!id) return errorResult(t('tools.automationIdRequired'));
            const ok = svc.remove(id);
            if (!ok) return errorResult(t('tools.automationNotFound', { id }));
            return structured({ metadata: { structured: { action, id } } }, t('tools.automationDeleted', { id }));
          }
          case 'list': {
            const items = svc.list();
            const payload = { action, count: items.length, items };
            return structured(
              { metadata: { structured: payload } },
              items.length === 0
                ? t('tools.automationEmpty')
                : `${t('tools.automationListHeader', { count: items.length })}:\n${JSON.stringify(items, null, 2)}`,
            );
          }
          case 'get': {
            const id = readString(args, 'id');
            if (!id) return errorResult(t('tools.automationIdRequired'));
            const item = svc.get(id);
            if (!item) return errorResult(t('tools.automationNotFound', { id }));
            const history = svc.getHistory(id);
            const payload = { action, id, item, history };
            return structured(
              { metadata: { structured: payload } },
              `${t('tools.automationGetHeader')}:\n${JSON.stringify({ ...item, history }, null, 2)}`,
            );
          }
          case 'trigger': {
            const id = readString(args, 'id');
            if (!id) return errorResult(t('tools.automationIdRequired'));
            const { runId } = svc.trigger(id);
            return structured({ metadata: { structured: { action, id, runId } } }, t('tools.automationTriggered', { runId }));
          }
          case 'pause': {
            const id = readString(args, 'id');
            if (!id) return errorResult(t('tools.automationIdRequired'));
            const ok = svc.pause(id);
            if (!ok) return errorResult(t('tools.automationNotFound', { id }));
            return structured({ metadata: { structured: { action, id } } }, t('tools.automationPaused', { id }));
          }
          case 'resume': {
            const id = readString(args, 'id');
            if (!id) return errorResult(t('tools.automationIdRequired'));
            const ok = svc.resume(id);
            if (!ok) return errorResult(t('tools.automationNotFound', { id }));
            return structured({ metadata: { structured: { action, id } } }, t('tools.automationResumed', { id }));
          }
          case 'history': {
            const id = readString(args, 'id');
            if (!id) return errorResult(t('tools.automationIdRequired'));
            const item = svc.get(id);
            if (!item) return errorResult(t('tools.automationNotFound', { id }));
            const history = svc.getHistory(id);
            const payload = { action, id, count: history.length, history };
            return structured(
              { metadata: { structured: payload } },
              `${t('tools.automationHistoryHeader', { count: history.length })}:\n${JSON.stringify(history, null, 2)}`,
            );
          }
          default:
            return errorResult(t('tools.automationUnknownAction', { action }));
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ----------------------------------------------------------- 会话列表
  tools.push({
    name: 'moss_list_sessions',
    description:
      'List MOSS sessions (newest first) with a derived title and message count. ' +
      'Use it to find a sessionId you can pass to moss_dispatch_task (to continue that conversation) or to moss_read_session.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max entries (1-50, default 20).' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async execute(args, deps) {
      const reg = needRegistry(deps);
      if (!reg) return errorResult('task registry not ready (MCP module still initializing) — retry shortly');
      const limit = readInt(args, 'limit', 20, 1, 50);
      try {
        const { items, note } = reg.listSessions(limit);
        const payload = { count: items.length, sessions: items, ...(note ? { note } : {}) };
        return structured({ metadata: { structured: payload } }, JSON.stringify(payload, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ----------------------------------------------------------- 读会话历史
  tools.push({
    name: 'moss_read_session',
    description:
      'Read the message history of a MOSS session (user/assistant messages, newest last). ' +
      'Useful to see what MOSS actually did, or to recover context when a dispatched task is unknown (e.g. after a MOSS restart).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'MOSS session id (same value as the taskId from moss_dispatch_task).' },
        limit: { type: 'integer', description: 'How many of the newest messages to return (1-50, default 20).' },
        includeToolResults: { type: 'boolean', description: 'Include raw tool result messages (default false).' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async execute(args, deps) {
      const reg = needRegistry(deps);
      if (!reg) return errorResult('task registry not ready (MCP module still initializing) — retry shortly');
      const sessionId = readString(args, 'sessionId');
      if (!sessionId) return errorResult('sessionId is required');
      const limit = readInt(args, 'limit', 20, 1, 50);
      const includeToolResults = readBool(args, 'includeToolResults', false);
      try {
        const { items, note } = reg.readSession(sessionId, limit, includeToolResults);
        const payload = { sessionId, count: items.length, messages: items, ...(note ? { note } : {}) };
        return structured({ metadata: { structured: payload } }, JSON.stringify(payload, null, 2));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  });

  return tools;
}