// src/modules/subagent/tools.ts
// 多智能体统一工具（单工具 + action 分派）：
// - action=delegate（缺省）：把自包含任务委派给一次性子代理（template + task + mode: sync/async）；
// - action=status：发现同任务树的智能体、查询状态、取消后台子代理；
// - action=message：向主代理 / 兄弟代理 / 频道发送消息；
// - action=manage：管理注册表中的内置/自定义 Agent。
// 注册到 ToolRegistry（subagent 模块 initialize 时），随系统提示词暴露给模型。

import { ServiceNames } from '../../core/types';
import type { ConfigService, ServiceRegistry, Logger, Environment } from '../../core/types';
import type { Tool, ToolResult, ToolContext } from '../tools/types';
import { textResult, errorResult } from '../tools/types';
import type { AgentEngine, ToolRegistry } from '../contracts';
import { loadPromptFileOrNull } from '../context/prompt-loader';
import type { AgentBus, AgentBusMember } from '../agent-bus/types';
import type { AgentDetail, AgentRegistry } from './types';
import type { SubagentRunner } from './runner';

/** 子代理默认/最低工具调用轮数（不填按 200；低于 200 提升为 200） */
const DEFAULT_SUBAGENT_MAX_TURNS = 200;
const MIN_SUBAGENT_MAX_TURNS = 200;

type AgentAction = 'delegate' | 'status' | 'message' | 'board' | 'manage';

interface AgentToolParams {
  action?: AgentAction;
  // delegate
  /** 注册表 agent id（如 agent_explorer） */
  template?: string;
  /** 完整自包含的任务描述（子代理只看得到它） */
  task?: string;
  cwd?: string;
  /** sync=阻塞等待报告（默认）；async=后台运行，立即返回 agentId */
  mode?: 'sync' | 'async';
  /** 本次子代理可用的工具白名单（不填=模板默认配置） */
  tools?: string[] | string;
  /** 工具调用轮数：不填=200；最低 200；'infinite'=不限制 */
  maxTurns?: number | string;
  /** 是否附带父会话最近一条用户请求作为背景（默认 true） */
  inherit_context?: boolean;
  // status
  sessionId?: string;
  statusAction?: 'list' | 'get' | 'cancel';
  // message
  to?: string;
  content?: string;
  // board
  boardAction?: 'read' | 'post' | 'rule' | 'remove';
  title?: string;
  boardId?: string;
  // manage
  manageAction?: 'list' | 'get' | 'create' | 'update' | 'delete' | 'tools';
  id?: string;
  name?: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  icon?: string;
}

/** 子代理终态：aborted 不能被当成 completed（否则刷新后失败会变成功） */
function resolveAgentRunStatus(finishReason: string): 'completed' | 'failed' | 'aborted' {
  if (finishReason === 'error') return 'failed';
  if (finishReason === 'aborted') return 'aborted';
  return 'completed';
}

/** 归一化工具白名单：接受数组或单个字符串；去空/去重；空值视为未填写（走模板默认） */
function normalizeToolAllowlist(raw: unknown): string[] | undefined {
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null;
  if (!list) return undefined;
  const names = [
    ...new Set(
      list
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
  return names.length > 0 ? names : undefined;
}

/** 归一化轮数：不填=200；infinite=0（引擎按 Infinity 处理）；低于 200 提升为 200 */
function normalizeMaxTurns(raw: unknown): { value?: number; error?: string } {
  if (raw === undefined || raw === null || raw === '') return { value: DEFAULT_SUBAGENT_MAX_TURNS };
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'infinite') return { value: 0 };
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0) {
    return { error: 'maxTurns 必须是 ≥200 的整数，或 "infinite"' };
  }
  return { value: Math.max(MIN_SUBAGENT_MAX_TURNS, n) };
}

function resolveRegistry(services: ServiceRegistry): AgentRegistry | null {
  return services.tryResolve<AgentRegistry>(ServiceNames.AGENT_REGISTRY);
}

function resolveBus(services: ServiceRegistry): AgentBus | null {
  return services.tryResolve<AgentBus>(ServiceNames.AGENT_BUS);
}

/** 父会话最近一条用户请求（截断；失败返回 undefined，不阻断派发） */
function resolveParentGoal(ctx: ToolContext): string | undefined {
  try {
    const engine = ctx.services.tryResolve<AgentEngine>(ServiceNames.AGENT_ENGINE);
    const session = engine?.getSessionForContext?.(ctx.sessionId);
    if (!session) return undefined;
    const last = [...session.messages]
      .reverse()
      .find(
        (m) =>
          m.role === 'user' &&
          !m.name &&
          !m.deletedAt &&
          !m.compacted &&
          m.content.trim().length > 0,
      );
    return last ? last.content.slice(0, 2000) : undefined;
  } catch {
    return undefined;
  }
}

/** 当前可派发的 Agent 目录文案（内置模板 + 自定义） */
function agentCatalogText(registry: AgentRegistry | null): string {
  const items = registry?.list() ?? [];
  const available = items.filter((item) => !item.default && item.id !== 'agent');
  if (available.length === 0) return '当前注册表中只有主 Agent。';
  return `当前可用：${available
    .map((item) => `${item.id}（${item.name}${item.builtIn ? '，内置' : '，自定义'}）`)
    .join('、')}。`;
}

/** 成员树文本化（缩进按 depth，模型可直接读） */
function formatMembers(members: AgentBusMember[]): string {
  if (members.length === 0) return '（当前没有智能体）';
  const sorted = [...members].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return Date.parse(a.startedAt) - Date.parse(b.startedAt);
  });
  return sorted
    .map((m) => {
      const indent = '  '.repeat(Math.max(0, m.depth));
      const template = m.template ? ` [${m.template}]` : '';
      const parent = m.parentAgentId ? ` parent=${m.parentAgentId}` : '';
      return `${indent}- ${m.agentId} ${m.name}${template} status=${m.status} session=${m.sessionId}${parent} task=${m.task}`;
    })
    .join('\n');
}

/** 按 agentId 或 sessionId 在 root 内定位成员 */
function findMember(bus: AgentBus, rootSessionId: string, id: string): AgentBusMember | null {
  const direct = bus.get(id);
  if (direct && direct.rootSessionId === rootSessionId) return direct;
  return bus.list(rootSessionId).find((m) => m.agentId === id) ?? null;
}

/** 当前会话在 AgentBus 中的成员（主代理也注册） */
function resolveSelf(ctx: ToolContext): AgentBusMember | null {
  const bus = resolveBus(ctx.services);
  return bus?.get(ctx.sessionId) ?? null;
}

/** 子代理嵌套上限（config.agent.maxSubagentDepth，与引擎保持同一收窄口径） */
function resolveMaxSubagentDepth(ctx: ToolContext): number {
  try {
    const config = ctx.services
      .tryResolve<ConfigService>(ServiceNames.CONFIG_SERVICE)
      ?.getAppConfig();
    return Math.min(5, Math.max(1, config?.agent.maxSubagentDepth ?? 2));
  } catch {
    return 2;
  }
}

/** action=delegate：一次性子代理派发 */
async function runDelegate(
  p: AgentToolParams,
  ctx: ToolContext,
  runner: SubagentRunner,
): Promise<ToolResult> {
  const template = (p.template ?? '').trim();
  const task = (p.task ?? '').trim();
  if (!template || !task) return errorResult('template 与 task 为必填项');
  const mode = p.mode ?? 'sync';
  if (mode !== 'sync' && mode !== 'async') {
    return errorResult('mode 只允许 "sync" 或 "async"');
  }

  // 嵌套深度运行时守卫：工具始终保留（保证 status/message 可用），仅拒绝继续派发
  const self = resolveSelf(ctx);
  if (self?.kind === 'subagent') {
    const maxDepth = resolveMaxSubagentDepth(ctx);
    if (self.depth >= maxDepth) {
      return errorResult(
        `已达到子代理嵌套层级上限（当前 ${self.depth} 层，上限 ${maxDepth} 层）；请直接完成当前任务或使用 action=status/message 协作。`,
      );
    }
  }

  // 可选覆盖：工具白名单与工具调用轮数（不填走模板默认 / 200）
  const toolAllowlist = normalizeToolAllowlist(p.tools);
  const maxTurnsResult = normalizeMaxTurns(p.maxTurns);
  if (maxTurnsResult.error) return errorResult(maxTurnsResult.error);
  const maxTurns = maxTurnsResult.value as number;
  const parentGoal = p.inherit_context === false ? undefined : resolveParentGoal(ctx);
  const configSummary =
    `tools=${toolAllowlist?.join(',') ?? '模板默认'} ` +
    `maxTurns=${maxTurns === 0 ? 'infinite' : maxTurns}`;
  const registry = resolveRegistry(ctx.services);
  if (registry && !registry.get(template)) {
    return errorResult(`注册表中未找到模板 "${template}"`);
  }
  if (mode === 'async') {
    const started = runner.start({
      template,
      task,
      cwd: p.cwd || ctx.cwd,
      mode: 'async',
      toolAllowlist,
      maxTurns,
      ...(parentGoal ? { parentGoal } : {}),
      parentToolCallId: ctx.toolCallId,
      parentSessionId: ctx.sessionId,
      // 父 run 正常完成不会 abort；用户停止/打断发送会 abort → 级联中止后台子代理
      signal: ctx.signal,
    });
    return {
      content: [
        {
          type: 'text',
          text:
            `已启动后台智能体 (agent=${started.agentId}, session=${started.sessionId}, ` +
            `template=${started.template}, mode=async, ${configSummary})。\n` +
            '用 agent(action="status", ...) 查询进度；完成后结果会以 [智能体消息] 形式送达。',
        },
      ],
      metadata: {
        agentRun: {
          agentId: started.agentId,
          sessionId: started.sessionId,
          template: started.template,
          name: started.name,
          status: 'running',
        },
      },
    };
  }
  const output = await runner.run({
    template,
    task,
    cwd: p.cwd || ctx.cwd,
    mode: 'sync',
    toolAllowlist,
    maxTurns,
    ...(parentGoal ? { parentGoal } : {}),
    parentToolCallId: ctx.toolCallId,
    parentSessionId: ctx.sessionId,
    signal: ctx.signal,
  });
  const status = resolveAgentRunStatus(output.finishReason);
  const prefix = status === 'aborted' ? '子代理已中止' : '子代理已完成';
  const result = textResult(
    `${prefix} (finishReason=${output.finishReason}, session=${output.sessionId}, ${configSummary}):\n\n${output.result}`,
    status === 'failed' || status === 'aborted',
  );
  result.metadata = {
    agentRun: {
      sessionId: output.sessionId,
      template,
      name: output.name,
      status,
      finishReason: output.finishReason,
    },
  };
  return result;
}

/** action=status：成员发现 / 查询 / 取消 */
function runStatus(p: AgentToolParams, ctx: ToolContext, runner: SubagentRunner): ToolResult {
  const bus = resolveBus(ctx.services);
  if (!bus) return errorResult('智能体总线不可用');
  const self = bus.get(ctx.sessionId);
  if (!self) return errorResult('当前会话未注册到智能体总线');
  const action = p.statusAction ?? 'list';

  if (action === 'list') {
    const members = bus.list(self.rootSessionId);
    return textResult(`智能体列表（root=${self.rootSessionId}）：\n${formatMembers(members)}`);
  }

  const targetId = (p.sessionId ?? '').trim();
  if (!targetId) return errorResult(`${action} 需要 sessionId（或 agentId）`);

  if (action === 'get') {
    const member = findMember(bus, self.rootSessionId, targetId);
    if (!member) return errorResult(`未找到智能体 "${targetId}"`);
    const snapshot = bus.snapshot(self.rootSessionId, { limit: 200 });
    const recent = snapshot.messages
      .filter(
        (m) => m.fromSessionId === member.sessionId || m.toSessionId === member.sessionId,
      )
      .slice(-10)
      .map((m) => {
        const to = m.toAgentId ?? '频道';
        const content = m.content.length > 500 ? `${m.content.slice(0, 500)}…` : m.content;
        return `  [${m.createdAt}] ${m.fromAgentId} → ${to}: ${content}`;
      });
    return textResult(
      `智能体 ${member.agentId}(${member.name})\n` +
        `status=${member.status} session=${member.sessionId} template=${member.template ?? '-'}\n` +
        `task=${member.task}\n` +
        (recent.length > 0 ? `最近消息：\n${recent.join('\n')}` : '最近消息：（无）'),
    );
  }

  if (action === 'cancel') {
    const member = findMember(bus, self.rootSessionId, targetId);
    if (!member) return errorResult(`未找到智能体 "${targetId}"`);
    if (member.kind !== 'subagent') return errorResult('只能取消子代理，不能取消主代理');
    const stopped = runner.stop(member.sessionId);
    return stopped
      ? textResult(`已请求取消 ${member.agentId}(${member.name})`)
      : errorResult(`${member.agentId}(${member.name}) 当前没有可取消的运行`);
  }

  return errorResult(`未知 status 操作 "${String(action)}"`);
}

/** action=message：智能体间消息 */
function runMessage(p: AgentToolParams, ctx: ToolContext): ToolResult {
  const bus = resolveBus(ctx.services);
  if (!bus) return errorResult('智能体总线不可用');
  const self = bus.get(ctx.sessionId);
  if (!self) return errorResult('当前会话未注册到智能体总线');
  const to = (p.to ?? '').trim();
  const content = (p.content ?? '').trim();
  if (!to) return errorResult('to 为必填项');
  if (!content) return errorResult('content 不能为空');

  const result = bus.send({ fromSessionId: ctx.sessionId, to, content, kind: 'chat' });
  if (result.error) return errorResult(result.error);
  const recipients = result.recipients
    .map((m) => `${m.agentId}(${m.name})`)
    .join(', ');
  return textResult(`已送达 ${result.delivered} 个智能体：${recipients}`);
}

/** action=board：共享白板读取 / 讨论 / 规则管理 */
function runBoard(p: AgentToolParams, ctx: ToolContext): ToolResult {
  const bus = resolveBus(ctx.services);
  if (!bus) return errorResult('智能体总线不可用');
  const self = bus.get(ctx.sessionId);
  if (!self) return errorResult('当前会话未注册到智能体总线');
  const action = p.boardAction ?? 'read';

  if (action === 'read') {
    const board = bus.readBoard(self.rootSessionId);
    const lines: string[] = [`共享白板（root=${self.rootSessionId}）`];
    lines.push(`\n规则（${board.rules.length}）：`);
    if (board.rules.length === 0) {
      lines.push('- （主代理尚未设定规则）');
    } else {
      for (const rule of board.rules) {
        lines.push(`- [${rule.id}] ${rule.title ?? '未命名'}：${rule.content}`);
      }
    }
    lines.push(`\n最近讨论（${board.discussion.length}）：`);
    if (board.discussion.length === 0) {
      lines.push('- （暂无讨论）');
    } else {
      for (const note of board.discussion.slice(-20)) {
        const content = note.content.length > 500 ? `${note.content.slice(0, 500)}…` : note.content;
        lines.push(`- ${note.authorAgentId}(${note.authorName}) [${note.createdAt}]: ${content}`);
      }
    }
    return textResult(lines.join('\n').slice(0, 6000));
  }

  if (action === 'post') {
    const content = (p.content ?? '').trim();
    if (!content) return errorResult('post 需要 content');
    const posted = bus.postBoard({
      fromSessionId: ctx.sessionId,
      kind: 'discussion',
      content,
    });
    if (posted.error) return errorResult(posted.error);
    return textResult(
      `已在白板讨论区发言（实时投递 ${posted.delivered} 个运行中成员）。` +
        '白板内容持久保存，后派发的子代理也会在启动时看到最近讨论。',
    );
  }

  if (action === 'rule') {
    const content = (p.content ?? '').trim();
    const title = (p.title ?? '').trim();
    if (!title) return errorResult('rule 需要 title（同标题会覆盖旧规则）');
    if (!content) return errorResult('rule 需要 content');
    const posted = bus.postBoard({
      fromSessionId: ctx.sessionId,
      kind: 'rule',
      title,
      content,
    });
    if (posted.error) return errorResult(posted.error);
    return textResult(
      `已${posted.note?.updatedAt ? '更新' : '新增'}白板规则「${title}」（id=${posted.note?.id ?? '-'}，` +
        `实时投递 ${posted.delivered} 个运行中成员）。`,
    );
  }

  if (action === 'remove') {
    const id = (p.boardId ?? '').trim();
    if (!id) return errorResult('remove 需要 boardId');
    const removed = bus.removeBoardNote({ fromSessionId: ctx.sessionId, id });
    return removed.ok ? textResult(`已删除白板规则 "${id}"`) : errorResult(removed.error ?? '删除失败');
  }

  return errorResult(`未知 board 操作 "${String(action)}"；可选 read / post / rule / remove`);
}

/** action=manage：注册表 Agent 管理 */
function runManage(p: AgentToolParams, ctx: ToolContext): ToolResult {
  const self = resolveSelf(ctx);
  if (self?.kind === 'subagent') {
    return errorResult('子代理不可管理 Agent 注册表；自定义 Agent 的创建/修改由主代理负责');
  }

  const registry = resolveRegistry(ctx.services);
  if (!registry) return errorResult('Agent 注册表不可用');
  const manageAction = p.manageAction ?? 'list';
  const id = (p.id ?? '').trim();

  if (manageAction === 'list') {
    const items = registry.list();
    const lines = items.map((item) => {
      const flags = [
        item.builtIn ? 'builtin' : 'custom',
        item.default ? 'default' : '',
      ].filter(Boolean).join(',');
      return `- ${item.id}｜${item.name}｜${flags}${item.description ? `｜${item.description}` : ''}`;
    });
    return textResult(`Agent 列表（${items.length}）：\n${lines.join('\n')}`);
  }

  if (manageAction === 'tools') {
    const toolRegistry = ctx.services.tryResolve<ToolRegistry>(ServiceNames.TOOL_REGISTRY);
    if (!toolRegistry) return errorResult('工具注册表不可用');
    const names = toolRegistry.listSchemas().map((tool) => tool.name).sort();
    return textResult(`可用工具（${names.length}）：\n${names.join(', ')}`);
  }

  if (manageAction === 'get') {
    if (!id) return errorResult('get 需要 id');
    const detail = registry.get(id);
    if (!detail) return errorResult(`未找到 Agent "${id}"`);
    return textResult(JSON.stringify(detail, null, 2));
  }

  if (manageAction === 'create') {
    const name = (p.name ?? '').trim();
    if (!name) return errorResult('create 需要 name');
    const created = registry.create({
      name,
      ...(p.description ? { description: p.description } : {}),
      ...(p.systemPrompt ? { systemPrompt: p.systemPrompt } : {}),
      ...(p.model ? { model: p.model } : {}),
      ...(Array.isArray(p.tools) && p.tools.length > 0 ? { tools: p.tools } : {}),
      ...(p.icon ? { icon: p.icon } : {}),
      ...(typeof p.maxTurns === 'number' ? { maxTurns: p.maxTurns } : {}),
      ...(typeof p.maxTokens === 'number' ? { maxTokens: p.maxTokens } : {}),
    });
    return textResult(
      `已创建自定义 Agent：${created.id}（${created.name}）。用 agent(action="delegate", template="${created.id}", task=...) 派发。`,
    );
  }

  if (manageAction === 'update') {
    if (!id) return errorResult('update 需要 id');
    const target = registry.get(id);
    if (!target) return errorResult(`未找到 Agent "${id}"`);
    if (target.builtIn) return errorResult('内置模板只读，不能修改');
    const patch: Partial<AgentDetail> = {};
    if (p.name !== undefined) patch.name = p.name;
    if (p.description !== undefined) patch.description = p.description;
    if (p.systemPrompt !== undefined) patch.systemPrompt = p.systemPrompt;
    if (p.model !== undefined) patch.model = p.model;
    if (p.tools !== undefined) patch.tools = Array.isArray(p.tools) ? p.tools : [p.tools];
    if (p.icon !== undefined) patch.icon = p.icon;
    if (typeof p.maxTurns === 'number') patch.maxTurns = p.maxTurns;
    if (typeof p.maxTokens === 'number') patch.maxTokens = p.maxTokens;
    const updated = registry.update(id, patch);
    if (!updated) return errorResult(`更新 Agent "${id}" 失败`);
    return textResult(`已更新 Agent ${updated.id}（${updated.name}）`);
  }

  if (manageAction === 'delete') {
    if (!id) return errorResult('delete 需要 id');
    const target = registry.get(id);
    if (!target) return errorResult(`未找到 Agent "${id}"`);
    if (target.builtIn) return errorResult('内置模板不可删除');
    if (target.default) return errorResult('默认 Agent 不可删除');
    return registry.remove(id)
      ? textResult(`已删除 Agent "${id}"`)
      : errorResult(`删除 Agent "${id}" 失败`);
  }

  return errorResult(`未知 manage 操作 "${String(manageAction)}"`);
}

/** 当前同轮并行上限（tool description 每次 listSchemas 时实时读取） */
function concurrentSubagentText(services: ServiceRegistry): string {
  try {
    const cfg = services.tryResolve<ConfigService>(ServiceNames.CONFIG_SERVICE)?.getAppConfig();
    const raw = cfg?.agent.maxConcurrentSubagents;
    const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 4;
    return value === 0
      ? '当前同轮并行上限：不限制（0）；仍建议按任务独立性与资源情况分批。'
      : `当前同轮并行上限：${value}；超过上限的调用会排队执行，不会失败。`;
  } catch {
    return '当前同轮并行上限：4（缺省）；超过上限的调用会排队执行，不会失败。';
  }
}

function createAgentTool(
  runner: SubagentRunner,
  env: Environment,
  registry: AgentRegistry | null,
  services: ServiceRegistry,
): Tool {
  // 用法文案从 agent/subagent/usage.md 加载；缺失时为空串降级
  const usage = loadPromptFileOrNull(env, 'subagent/usage.md') ?? '';
  return {
    name: 'agent',
    icon: 'bot',
    // 动态描述：每次 listSchemas() 都读取实时配置，保证模型知道当前并行上限
    get description(): string {
      return (
        '多智能体统一工具（action 分派）。delegate（缺省）：把自包含任务委派给一次性子代理（template + task + mode + 可选 tools/maxTurns），多个独立任务应在同一轮发起多个 async 调用并行执行；status：列出/查看/取消当前任务树中的智能体；message：向主代理/兄弟代理点对点私聊；board：共享白板（主代理设定规则，所有成员可读/讨论）；manage：管理内置与自定义 Agent（list/get/create/update/delete/tools）。' +
        `${agentCatalogText(registry)}${concurrentSubagentText(services)}嵌套层级受设置中的 maxSubagentDepth 限制；子代理不可使用 manage。${usage}`
      );
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['delegate', 'status', 'message', 'board', 'manage'],
          description:
            '操作类型：delegate（缺省）=派发子代理；status=列出/查看/取消智能体；message=点对点私聊；board=共享白板（规则/讨论）；manage=管理 Agent 注册表',
          description_en:
            'Operation: delegate (default) = dispatch a subagent; status = list/get/cancel agents; message = direct message; board = shared board (rules/discussion); manage = manage the agent registry',
        },
        statusAction: {
          type: 'string',
          enum: ['list', 'get', 'cancel'],
          description: 'status 子操作：list（默认）列出成员；get 查看单个成员；cancel 取消后台子代理',
          description_en: 'status sub-operation: list (default) | get | cancel',
        },
        manageAction: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update', 'delete', 'tools'],
          description: 'manage 子操作：list（默认）| get | create | update | delete | tools',
          description_en: 'manage sub-operation: list (default) | get | create | update | delete | tools',
        },
        template: {
          type: 'string',
          description: 'delegate：注册表 agent id，如 agent_explorer / agent_planner / agent_coder / agent_reviewer',
          description_en: 'delegate: registry agent id, e.g. agent_explorer / agent_planner / agent_coder / agent_reviewer',
        },
        task: {
          type: 'string',
          description: 'delegate：完整自包含的任务描述（子代理只能看到这段内容）',
          description_en: 'delegate: complete self-contained task description (the subagent sees only this)',
        },
        mode: {
          type: 'string',
          enum: ['sync', 'async'],
          description:
            'delegate：sync=阻塞等待最终报告（默认）；async=后台运行，立即返回 agentId/sessionId，完成后结果以智能体消息送达',
          description_en:
            'delegate: sync=wait for the final report (default); async=run in background and return agentId/sessionId immediately',
        },
        cwd: {
          type: 'string',
          description: 'delegate：工作目录（默认当前会话 cwd）',
          description_en: 'delegate: working directory (defaults to current session cwd)',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'delegate：本次子代理可用的工具白名单（如 ["read","grep","edit"]），不填=模板默认；manage：Agent 模板的工具白名单，不填=全部工具',
          description_en:
            'delegate: tool allowlist for this subagent (e.g. ["read","grep","edit"]), omitted = template defaults; manage: tool allowlist for the agent profile, omitted = all tools',
        },
        maxTurns: {
          oneOf: [
            {
              type: 'integer',
              minimum: MIN_SUBAGENT_MAX_TURNS,
              description: '工具调用轮数上限（≥200，无上限）',
            },
            { type: 'string', enum: ['infinite'], description: '不限制轮数' },
          ],
          description:
            'delegate：子代理工具调用轮数（不填=200；低于 200 按 200；infinite=不限制）；manage：Agent 模板最大轮数',
          description_en:
            'delegate: subagent tool-call turns (omitted=200; values below 200 are raised to 200; infinite=unlimited); manage: agent profile max turns',
        },
        inherit_context: {
          type: 'boolean',
          description: 'delegate：是否附带父会话最近一条用户请求作为背景（默认 true；仅帮助理解目标，不扩大任务范围）',
          description_en:
            'delegate: attach the parent session last user request as background (default true; context only)',
        },
        sessionId: {
          type: 'string',
          description: 'status：目标智能体 sessionId（get/cancel 必填；也可传 agentId 如 a1）',
          description_en: 'status: target agent sessionId (required for get/cancel; agentId like a1 also accepted)',
        },
        to: {
          type: 'string',
          description: 'message：目标 "all" | "parent" | agentId（main/a1/a2）| sessionId',
          description_en: 'message: target "all" | "parent" | agentId (main/a1/a2) | sessionId',
        },
        content: {
          type: 'string',
          description:
            'message/board：正文（message ≤8000 字符；board ≤4000 字符；只写对方需要且会改变其行动的事实）',
          description_en:
            'message/board: body text (message <=8000 chars; board <=4000 chars; facts that change the recipient action)',
        },
        boardAction: {
          type: 'string',
          enum: ['read', 'post', 'rule', 'remove'],
          description:
            'board 子操作：read（默认）读取规则与最近讨论；post 在讨论区发言（所有成员）；rule 设定/覆盖规则（仅主代理，需要 title）；remove 删除规则（仅主代理，需要 boardId）',
          description_en:
            'board sub-operation: read (default) | post discussion (all members) | rule upsert (main agent only, requires title) | remove rule (main agent only, requires boardId)',
        },
        title: {
          type: 'string',
          description: 'board rule：规则标题（同标题覆盖旧规则，仅主代理）',
          description_en: 'board rule: rule title (same title upserts; main agent only)',
        },
        boardId: {
          type: 'string',
          description: 'board remove：规则 id（从 boardAction="read" 结果中获取）',
          description_en: 'board remove: rule id (from boardAction="read" output)',
        },
        id: {
          type: 'string',
          description: 'manage：Agent id（get/update/delete 必填）',
          description_en: 'manage: agent id (required for get/update/delete)',
        },
        name: {
          type: 'string',
          description: 'manage：显示名称（create 必填）',
          description_en: 'manage: display name (required for create)',
        },
        description: {
          type: 'string',
          description: 'manage：一句话描述',
          description_en: 'manage: one-line description',
        },
        systemPrompt: {
          type: 'string',
          description: 'manage：角色系统提示词（叠加到主提示词之后）',
          description_en: 'manage: role system prompt (appended to the main prompt)',
        },
        model: {
          type: 'string',
          description: 'manage：模型 id；不填继承全局默认',
          description_en: 'manage: model id; omitted inherits the global default',
        },
        maxTokens: {
          type: 'integer',
          minimum: 1,
          description: 'manage：单次回复最大 token',
          description_en: 'manage: max tokens per reply',
        },
        icon: {
          type: 'string',
          description: 'manage：图标名（可选）',
          description_en: 'manage: icon name (optional)',
        },
      },
    },
    annotations: { readOnlyHint: false },
    async execute(params, ctx: ToolContext): Promise<ToolResult> {
      const p = (params ?? {}) as AgentToolParams;
      try {
        const action = p.action ?? 'delegate';
        switch (action) {
          case 'delegate':
            return await runDelegate(p, ctx, runner);
          case 'status':
            return runStatus(p, ctx, runner);
          case 'message':
            return runMessage(p, ctx);
          case 'board':
            return runBoard(p, ctx);
          case 'manage':
            return runManage(p, ctx);
          default:
            return errorResult(`未知 action "${String(action)}"；可选 delegate / status / message / board / manage`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/** 注册多智能体工具到 ToolRegistry（由 subagent 模块 initialize 调用）。 */
export function registerAgentTools(
  services: ServiceRegistry,
  runner: SubagentRunner,
  logger: Logger,
  env: Environment,
): void {
  const registry = services.tryResolve<ToolRegistry>(ServiceNames.TOOL_REGISTRY);
  if (!registry) {
    logger.warn('subagent: tool registry unavailable, agent tools not registered');
    return;
  }
  const agentRegistry = services.tryResolve<AgentRegistry>(ServiceNames.AGENT_REGISTRY);
  const tool = createAgentTool(runner, env, agentRegistry, services);
  try {
    registry.register(tool);
  } catch (err) {
    logger.warn('subagent: tool register failed', {
      tool: tool.name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  logger.info('subagent: agent tools registered', { tools: [tool.name] });
}
