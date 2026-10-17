// src/modules/context/healer/index.ts
// 自愈器统一入口：参数修复（args-repair）→ 工具名纠正（tool-match）→
// schema 校验修正（schema-fix）→ 可执行判定。
// 修复失败时按 agent/prompts/heal/tool-error.md 模板生成结构化错误文本，
// 回传给模型下一轮自我纠正。

import type { Environment } from '../../../core/types';
import type { HealLogEntry, HealResult, HealerConfig } from '../types';
import { loadPromptFileOrNull, renderTemplate } from '../prompt-loader';
import { repairToolCallArguments } from './args-repair';
import { fuzzyMatchToolName } from './tool-match';
import { validateAndFixSchema } from './schema-fix';

export { sanitizeMessages, alignWindowBoundaries } from './pair-sanitize';
export type { SanitizeResult } from './pair-sanitize';
export { repairToolCallArguments } from './args-repair';
export { fuzzyMatchToolName } from './tool-match';
export { validateAndFixSchema } from './schema-fix';

/** 工具注册表鸭子类型（ToolRegistry + MCP 工具的组合，由 service 组装注入） */
export interface HealRegistryLike {
  get(name: string): { name: string; description?: string; inputSchema?: unknown } | null;
  listSchemas(): Array<{ name: string; description?: string; inputSchema?: unknown }>;
}

export interface HealToolCallInput {
  toolName: string;
  /** 模型输出的 arguments 原始 JSON 字符串 */
  arguments: string;
  registry: HealRegistryLike;
  config: HealerConfig;
  env: Environment;
}

/**
 * 生成工具错误回传文本。
 * 优先使用 agent/prompts/heal/tool-error.md 模板；文件缺失时程序化拼接最小结构（降级），
 * 保证自愈回路仍能向模型回传结构化错误。
 * @returns text 回传文本；degraded 是否走了降级路径
 */
function buildToolErrorText(
  env: Environment,
  vars: { TOOL_NAME: string; ISSUES: string; USAGE: string; CANDIDATES: string },
): { text: string; degraded: boolean } {
  const template = loadPromptFileOrNull(env, 'heal/tool-error.md');
  if (template) {
    return { text: renderTemplate(template, vars), degraded: false };
  }
  const lines = [
    '[工具调用失败]',
    '',
    `工具: ${vars.TOOL_NAME}`,
    '',
    '问题:',
    vars.ISSUES,
    '',
    '正确用法:',
    vars.USAGE,
  ];
  if (vars.CANDIDATES) {
    lines.push('', vars.CANDIDATES);
  }
  return { text: lines.join('\n'), degraded: true };
}

/**
 * 工具调用自愈主入口。
 * 流程：args-repair → tool-match → schema-fix；healLog 记录全部修复动作，
 * executable=false 时 errorText 可直接作为 tool result 回传。
 */
export function healToolCall(input: HealToolCallInput): HealResult {
  const { toolName, registry, config, env } = input;
  const healLog: HealLogEntry[] = [];

  // ===== 1. 参数 JSON 修复 =====
  const repaired = repairToolCallArguments(input.arguments);
  if (repaired.note) {
    healLog.push({ kind: 'args-repair', detail: repaired.note });
  }
  let args = repaired.value;

  // ===== 2. 工具名纠正 =====
  const match = fuzzyMatchToolName(toolName, registry, config.toolNameFuzzy);
  let resolvedName = toolName;
  if (match.corrected && match.matched) {
    resolvedName = match.matched;
    healLog.push({ kind: 'tool-name', detail: `corrected tool name "${toolName}" → "${resolvedName}"` });
  } else if (match.matched === null) {
    // 无法纠正：回传错误（含候选列表）
    const { text: errorText, degraded } = buildToolErrorText(env, {
      TOOL_NAME: toolName,
      ISSUES: [
        `工具 "${toolName}" 不存在或未注册`,
        ...(repaired.note ? [`参数修复说明: ${repaired.note}`] : []),
      ].map(s => `- ${s}`).join('\n'),
      USAGE: '请先确认工具名是否正确。',
      CANDIDATES:
        match.candidates.length > 0
          ? `相近的可用工具:\n${match.candidates.map(c => `- ${c}`).join('\n')}`
          : '',
    });
    if (degraded) healLog.push({ kind: 'template-fallback', detail: 'heal/tool-error.md missing, using minimal fallback' });
    return {
      toolName,
      args,
      healLog,
      executable: false,
      errorText,
      candidates: match.candidates,
    };
  }

  // ===== 3. schema 校验 + 类型修正 =====
  const tool = registry.get(resolvedName);
  if (tool?.inputSchema && typeof args === 'object' && args !== null && !Array.isArray(args)) {
    const schemaResult = validateAndFixSchema(args as Record<string, unknown>, tool.inputSchema, config.schemaFix);
    args = schemaResult.args;
    for (const fix of schemaResult.fixes) {
      healLog.push({ kind: 'schema-fix', detail: fix });
    }
    if (!schemaResult.valid) {
      // 校验失败：回传结构化错误（含正确用法），让模型自纠
      const { text: errorText, degraded } = buildToolErrorText(env, {
        TOOL_NAME: resolvedName,
        ISSUES: [
          ...(repaired.note ? [`参数修复说明: ${repaired.note}`] : []),
          ...(match.corrected ? [`工具名已自动纠正: "${toolName}" → "${resolvedName}"`] : []),
          ...schemaResult.errors,
        ].map(s => `- ${s}`).join('\n'),
        USAGE: buildUsageHint(resolvedName, tool.inputSchema),
        CANDIDATES: '',
      });
      if (degraded) healLog.push({ kind: 'template-fallback', detail: 'heal/tool-error.md missing, using minimal fallback' });
      return {
        toolName: resolvedName,
        args,
        healLog,
        executable: false,
        errorText,
        candidates: match.candidates,
      };
    }
  }

  return {
    toolName: resolvedName,
    args,
    healLog,
    executable: true,
  };
}

/** 从 inputSchema 生成简要用法提示（参数名/类型/必填） */
function buildUsageHint(name: string, inputSchema: unknown): string {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return `工具 "${name}" 的参数定义不可用。`;
  }
  const schema = inputSchema as {
    properties?: Record<string, { type?: string | string[]; description?: string }>;
    required?: string[];
  };
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const lines = Object.entries(props).map(([key, prop]) => {
    const type = Array.isArray(prop.type) ? prop.type.join('|') : (prop.type ?? 'any');
    const req = required.has(key) ? '必填' : '可选';
    return `- ${key} (${type}, ${req})${prop.description ? `：${prop.description}` : ''}`;
  });
  return lines.length > 0
    ? `工具 "${name}" 参数:\n${lines.join('\n')}`
    : `工具 "${name}" 无需参数（或参数定义不可用）。`;
}
