// src/modules/subagent/tools.ts
// 单一 agent 工具：把自包含任务委派给一次性子代理（template + task）。
// 注册到 ToolRegistry（subagent 模块 initialize 时），随系统提示词暴露给主会话模型。

import { ServiceNames } from '../../core/types';
import type { ServiceRegistry, Logger, Environment } from '../../core/types';
import type { Tool, ToolResult, ToolContext } from '../tools/types';
import { textResult, errorResult } from '../tools/types';
import type { ToolRegistry } from '../contracts';
import { loadPromptFileOrNull } from '../context/prompt-loader';
import type { AgentRegistry } from './types';
import type { SubagentRunner } from './runner';

interface AgentToolParams {
  /** 注册表 agent id（如 agent_explorer） */
  template?: string;
  /** 完整自包含的任务描述（子代理只看得到它） */
  task?: string;
  cwd?: string;
}

function resolveRegistry(services: ServiceRegistry): AgentRegistry | null {
  return services.tryResolve<AgentRegistry>(ServiceNames.AGENT_REGISTRY);
}

function createAgentTool(runner: SubagentRunner, env: Environment): Tool {
  // 用法文案从 agent/prompts/subagent/usage-zh.md 加载；缺失时为空串降级
  const usageZh = loadPromptFileOrNull(env, 'subagent/usage-zh.md') ?? '';
  return {
    name: 'agent',
    icon: 'bot',
    description: `把自包含任务委派给一次性子代理（template + task）。子代理在自己的隐藏会话中运行并返回最终报告。${usageZh}`,
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
        const registry = resolveRegistry(ctx.services);
        if (registry && !registry.get(template)) {
          return errorResult(`注册表中未找到模板 "${template}"`);
        }
        const output = await runner.run({
          template,
          task,
          cwd: p.cwd || ctx.cwd,
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

/** 注册 agent 工具到 ToolRegistry（由 subagent 模块 initialize 调用）。 */
export function registerAgentTools(
  services: ServiceRegistry,
  runner: SubagentRunner,
  logger: Logger,
  env: Environment,
): void {
  const registry = services.tryResolve<ToolRegistry>(ServiceNames.TOOL_REGISTRY);
  if (!registry) {
    logger.warn('subagent: tool registry unavailable, agent tool not registered');
    return;
  }
  try {
    registry.register(createAgentTool(runner, env));
  } catch (err) {
    logger.warn('subagent: tool register failed', {
      tool: 'agent',
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  logger.info('subagent: agent tool registered');
}
