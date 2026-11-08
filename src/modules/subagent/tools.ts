// src/modules/subagent/tools.ts
// 多智能体工具：
// - agent：把自包含任务委派给一次性子代理（template + task + mode: sync/async）；
// - agent_status：发现同任务树的智能体、查询状态、取消后台子代理；
// - agent_message：向主代理 / 兄弟代理 / 频道发送消息。
// 注册到 ToolRegistry（subagent 模块 initialize 时），随系统提示词暴露给模型。

import { ServiceNames } from '../../core/types';
import type { ServiceRegistry, Logger, Environment } from '../../core/types';
import type { Tool, ToolResult, ToolContext } from '../tools/types';
import { textResult, errorResult } from '../tools/types';
import type { ToolRegistry } from '../contracts';
import { loadPromptFileOrNull } from '../context/prompt-loader';
import type { AgentBus, AgentBusMember } from '../agent-bus/types';
import type { AgentRegistry } from './types';
import type { SubagentRunner } from './runner';

interface AgentToolParams {
  /** 注册表 agent id（如 agent_explorer） */
  template?: string;
  /** 完整自包含的任务描述（子代理只看得到它） */
  task?: string;
  cwd?: string;
  /** sync=阻塞等待报告（默认）；async=后台运行，立即返回 agentId */
  mode?: 'sync' | 'async';
}

interface AgentStatusParams {
  action?: 'list' | 'get' | 'cancel';
  sessionId?: string;
}

interface AgentMessageParams {
  to?: string;
  content?: string;
}

function resolveRegistry(services: ServiceRegistry): AgentRegistry | null {
  return services.tryResolve<AgentRegistry>(ServiceNames.AGENT_REGISTRY);
}

function resolveBus(services: ServiceRegistry): AgentBus | null {
  return services.tryResolve<AgentBus>(ServiceNames.AGENT_BUS);
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

function createAgentTool(runner: SubagentRunner, env: Environment): Tool {
  // 用法文案从 agent/prompts/subagent/usage-zh.md 加载；缺失时为空串降级
  const usageZh = loadPromptFileOrNull(env, 'subagent/usage-zh.md') ?? '';
  return {
    name: 'agent',
    icon: 'bot',
    description: `把自包含任务委派给一次性子代理（template + task + mode）。子代理在自己的隐藏会话中运行并返回最终报告；mode=async 时后台运行，用 agent_status 查询。${usageZh}`,
    inputSchema: {
      type: 'object',
      properties: {
        template: {
          type: 'string',
          description: '注册表 agent id，如 agent_explorer / agent_planner / agent_coder / agent_reviewer',
          description_en: 'Registry agent id, e.g. agent_explorer / agent_planner / agent_coder / agent_reviewer',
        },
        task: {
          type: 'string',
          description: '完整自包含的任务描述（子代理只能看到这段内容）',
          description_en: 'Complete self-contained task description (the subagent sees only this)',
        },
        mode: {
          type: 'string',
          enum: ['sync', 'async'],
          description:
            'sync=阻塞等待最终报告（默认）；async=后台运行，立即返回 agentId/sessionId，完成后结果以智能体消息送达',
          description_en:
            'sync=wait for the final report (default); async=run in background and return agentId/sessionId immediately',
        },
        cwd: {
          type: 'string',
          description: '工作目录（默认当前会话 cwd）',
          description_en: 'Working directory (defaults to current session cwd)',
        },
      },
      required: ['template', 'task'],
    },
    annotations: { readOnlyHint: false },
    async execute(params, ctx: ToolContext): Promise<ToolResult> {
      const p = params as AgentToolParams;
      try {
        const template = (p.template ?? '').trim();
        const task = (p.task ?? '').trim();
        if (!template || !task) return errorResult('template 与 task 为必填项');
        const mode = p.mode ?? 'sync';
        if (mode !== 'sync' && mode !== 'async') {
          return errorResult('mode 只允许 "sync" 或 "async"');
        }
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
                  `template=${started.template}, mode=async)。\n` +
                  '用 agent_status 查询进度；完成后结果会以 [智能体消息] 形式送达。',
              },
            ],
            metadata: {
              agentRun: {
                agentId: started.agentId,
                sessionId: started.sessionId,
                template: started.template,
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
          parentToolCallId: ctx.toolCallId,
          parentSessionId: ctx.sessionId,
          signal: ctx.signal,
        });
        return textResult(
          `子代理已完成 (finishReason=${output.finishReason}, session=${output.sessionId}):\n\n${output.result}`,
          output.finishReason === 'error',
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

function createAgentStatusTool(runner: SubagentRunner): Tool {
  return {
    name: 'agent_status',
    icon: 'bot',
    description:
      '发现并查询当前任务树中的智能体：action=list 列出全部成员（含主代理/子代理/状态/任务）；action=get 查看单个成员与最近消息；action=cancel 取消一个后台子代理。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'cancel'],
          description: 'list=列出成员（默认）；get=查看单个成员；cancel=取消后台子代理',
          description_en: 'list (default) | get | cancel',
        },
        sessionId: {
          type: 'string',
          description: '目标智能体 sessionId（get/cancel 必填；也可传 agentId 如 a1）',
          description_en: 'Target agent sessionId (required for get/cancel; agentId like a1 also accepted)',
        },
      },
    },
    annotations: { readOnlyHint: false },
    async execute(params, ctx: ToolContext): Promise<ToolResult> {
      const p = params as AgentStatusParams;
      try {
        const bus = resolveBus(ctx.services);
        if (!bus) return errorResult('智能体总线不可用');
        const self = bus.get(ctx.sessionId);
        if (!self) return errorResult('当前会话未注册到智能体总线');
        const action = p.action ?? 'list';

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

        return errorResult(`未知 action "${String(action)}"`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

function createAgentMessageTool(): Tool {
  return {
    name: 'agent_message',
    icon: 'bot',
    description:
      '向当前任务树中的其他智能体发送消息：to 可为 "all"（频道广播）、"parent"（父代理）、agentId（main/a1/a2）或 sessionId。目标会在下一轮开始时收到 [智能体消息]。',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: '目标："all" | "parent" | agentId（main/a1/a2）| sessionId',
          description_en: 'Target: "all" | "parent" | agentId (main/a1/a2) | sessionId',
        },
        content: {
          type: 'string',
          description: '消息正文（≤8000 字符；只写对方需要且会改变其行动的事实）',
          description_en: 'Message body (<=8000 chars; facts that change the recipient action)',
        },
      },
      required: ['to', 'content'],
    },
    annotations: { readOnlyHint: false },
    async execute(params, ctx: ToolContext): Promise<ToolResult> {
      const p = params as AgentMessageParams;
      try {
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
  const tools: Tool[] = [
    createAgentTool(runner, env),
    createAgentStatusTool(runner),
    createAgentMessageTool(),
  ];
  for (const tool of tools) {
    try {
      registry.register(tool);
    } catch (err) {
      logger.warn('subagent: tool register failed', {
        tool: tool.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info('subagent: agent tools registered', { tools: tools.map((t) => t.name) });
}
