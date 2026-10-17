// src/modules/agenteam/templates.ts
// 内置 Agent 模板（精简四件套：explorer / planner / coder / reviewer）。
// 以注册表 builtIn agent 形式存在（不可删除），天然复用 AgentEngine 的
// agentId 执行机制：临时 subagent 与团队成员均直接以模板 id 运行。
// 提示词外置：systemPrompt 从 agent/prompts/agenteam/templates/<name>.md 加载。

import type { Environment } from '../../core/types';
import { loadPromptFileOrNull } from '../context/prompt-loader';
import type { AgentDetail } from './index';

/** 内置模板元数据（id/名称/描述 + 提示词文件路径） */
interface TemplateMeta {
  id: string;
  name: string;
  description: string;
  /** 提示词文件相对 agent/prompts/ 的路径 */
  promptPath: string;
}

/** 内置模板 agent 定义（提示词从文件加载后填充） */
interface TemplateDef {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
}

/** 内置模板元数据表（提示词路径固定；内容可被用户编辑） */
const BUILTIN_TEMPLATE_META: readonly TemplateMeta[] = [
  {
    id: 'agent_explorer',
    name: 'Explorer',
    description: '代码库探索专家：只读优先，快速定位结构与关键文件',
    promptPath: 'agenteam/templates/explorer.md',
  },
  {
    id: 'agent_planner',
    name: 'Planner',
    description: '任务规划专家：拆解目标为带依赖与验收标准的任务 DAG',
    promptPath: 'agenteam/templates/planner.md',
  },
  {
    id: 'agent_coder',
    name: 'Coder',
    description: '编码实现专家：最小改动实现，完成后自验证',
    promptPath: 'agenteam/templates/coder.md',
  },
  {
    id: 'agent_reviewer',
    name: 'Reviewer',
    description: '对抗性审查专家：从第一性原理揪出所有 bug',
    promptPath: 'agenteam/templates/reviewer.md',
  },
];

/** 加载内置模板定义（systemPrompt 读文件；缺失时为空串降级） */
export function buildBuiltinTemplateDefs(env: Environment): readonly TemplateDef[] {
  return BUILTIN_TEMPLATE_META.map(meta => ({
    id: meta.id,
    name: meta.name,
    description: meta.description,
    systemPrompt: loadPromptFileOrNull(env, meta.promptPath) ?? '',
  }));
}

/** 模板 id 集合（校验用；静态，不含提示词内容） */
export const TEMPLATE_IDS: readonly string[] = BUILTIN_TEMPLATE_META.map(d => d.id);

/** 构造模板 AgentDetail（注册表合并用；不指定 model/tools → 继承全局默认） */
export function buildTemplateAgents(env: Environment): AgentDetail[] {
  return buildBuiltinTemplateDefs(env).map(d => ({
    id: d.id,
    name: d.name,
    description: d.description,
    systemPrompt: d.systemPrompt,
    builtIn: true,
    default: false,
  }));
}

/** 判断 agent id 是否为内置模板 */
export function isBuiltinTemplate(id: string): boolean {
  return TEMPLATE_IDS.includes(id);
}
