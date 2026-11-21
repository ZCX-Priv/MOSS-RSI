// tools/skill/index.ts
// skill 工具 execute 逻辑：统一 skill 工具，按 action 分派。
//   list    —— 列出所有启用的 skill（渐进式披露第一级：name + description）
//   use     —— 激活注册表中的 skill，返回 prompt 模板（第二级；目录式 skill 附带
//              references/scripts 文件清单供 LLM 按需 read）
//   create  —— 在 ~/.moss/skills/<name>/SKILL.md 新建用户 skill
//   update  —— 修改现有 skill（名称不可变）
//   delete  —— 删除用户 skill（内置 skill 不可删除）
//   search  —— 按关键词搜索 SkillHub 技能市场
//   install —— 按 canonicalName（@owner/slug）从市场安装
// 元数据见同目录 tool.json。
//
// 设计要点：
//  - 名称是稳定标识：更新不允许改名；写文件后立即 registry.rescan()。
//  - 所有错误以 ToolResult.isError 返回；写操作的权限分级在 safety/policy.ts 中按 action 判定。

import { t } from '../../../core/i18n';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService, Environment } from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import type { ToolContext, ToolResult } from '../types';
import type { SkillRegistry } from '../shared/skill-registry';
import { installMarketSkill, queryMarketSkills, SkillMarketError } from '../shared/skill-market';

type SkillAction = 'list' | 'use' | 'create' | 'update' | 'delete' | 'search' | 'install';

interface SkillParams {
  action?: string;
  skill?: string;
  args?: Record<string, unknown>;
  name?: string;
  description?: string;
  content?: string;
  enabled?: boolean;
  icon?: string;
  allowedTools?: unknown;
  keyword?: string;
  canonicalName?: string;
}

/** 工具内部错误：execute 统一转为 isError 结果 */
class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillError';
  }
}

/** skill 名称规则（与 SkillRegistry 保持一致） */
const SKILL_NAME_RE = /^[a-z][a-z0-9-]*$/;

function textResult(text: string, metadata?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(metadata ? { metadata } : {}),
  };
}

function errorText(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** YAML 双引号字符串转义（换行/引号/反斜杠） */
function yamlString(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

function resolveSkillRegistry(ctx: ToolContext): SkillRegistry {
  const registry = ctx.services.tryResolve<SkillRegistry>(ServiceNames.SKILL_REGISTRY);
  if (!registry) throw new SkillError(t('tools.skillRegistryUnavailable'));
  return registry;
}

function isBuiltinSkill(env: Environment, name: string): boolean {
  return existsSync(join(env.packageRoot, 'skills', name, 'SKILL.md'));
}

function buildSkillMarkdown(data: {
  name: string;
  description: string;
  prompt: string;
  icon?: string;
  allowedTools?: string[];
}): string {
  const lines: string[] = ['---', `name: ${data.name}`, `description: ${yamlString(data.description)}`];
  if (data.icon) lines.push(`icon: ${data.icon}`);
  if (data.allowedTools && data.allowedTools.length > 0) {
    lines.push(`allowed-tools: ${yamlString(data.allowedTools.join(', '))}`);
  }
  lines.push('---', '', data.prompt.trim(), '');
  return lines.join('\n');
}

/** create/update 携带 enabled 时写入 config.skills[name].enabled */
async function applyEnabled(ctx: ToolContext, name: string, enabled: boolean): Promise<void> {
  const config = ctx.services.tryResolve<ConfigService>(ServiceNames.CONFIG_SERVICE);
  if (!config) throw new SkillError(t('tools.skillConfigUnavailable'));
  await config.updateAppConfig({ skills: { [name]: { enabled } } });
}

// ============================================================================
// list / use
// ============================================================================

/** action=list：列出所有启用的 skill */
function runList(ctx: ToolContext): ToolResult {
  const reg = ctx.services.tryResolve<SkillRegistry>(ServiceNames.SKILL_REGISTRY);
  if (!reg) {
    return errorText(`Error: ${t('tools.listSkillRegistryUnavailable')}`);
  }

  const skills = reg.list().filter(s => reg.isEnabled(s.name));
  if (skills.length === 0) {
    return {
      content: [{ type: 'text', text: t('tools.listSkillNoSkills') }],
      metadata: { count: 0 },
    };
  }

  const lines = skills.map(
    s => `- ${s.name}: ${s.description || t('tools.listSkillNoDescription')}`,
  );
  return {
    content: [
      {
        type: 'text',
        text: `${t('tools.listSkillHeader', { count: skills.length })}\n${lines.join('\n')}\n\n${t('tools.listSkillUseHint')}`,
      },
    ],
    metadata: { count: skills.length },
  };
}

/** action=use：激活指定 skill，返回完整指令模板 */
function runUse(p: SkillParams, ctx: ToolContext): ToolResult {
  if (!p.skill) {
    return errorText(`Error: ${t('tools.useSkillRequired')}`);
  }

  const reg = ctx.services.tryResolve<SkillRegistry>(ServiceNames.SKILL_REGISTRY);
  if (!reg) {
    return errorText(`Error: ${t('tools.useSkillRegistryUnavailable')}`);
  }

  const skill = reg.get(p.skill);
  if (!skill) {
    const available = reg.list().filter(s => reg.isEnabled(s.name)).map(s => s.name).join(', ');
    return errorText(`Error: ${t('tools.useSkillNotFound', { skill: p.skill, available: available || t('tools.useSkillNoneAvailable') })}`);
  }

  // 启停校验（config.skills[name].enabled）
  if (!reg.isEnabled(p.skill)) {
    return errorText(`Error: ${t('tools.useSkillDisabled', { skill: p.skill })}`);
  }

  try {
    let promptText = substitutePlaceholders(skill.prompt, p.args ?? {});
    // 渐进式披露第三级入口：目录式 skill 附带附属文件清单（LLM 用 read 工具按需读取）
    if (skill.files && skill.files.length > 0) {
      const base = skill.dir ?? '';
      const fileList = skill.files.map(f => `- ${base ? `${base}/` : ''}${f}`).join('\n');
      promptText += `\n\n---\n${t('tools.useSkillFilesHeader')}\n${fileList}`;
    }
    if (skill.allowedTools && skill.allowedTools.length > 0) {
      promptText += `\n\n${t('tools.useSkillAllowedTools', { tools: skill.allowedTools.join(', ') })}`;
    }
    return {
      content: [{ type: 'text', text: promptText }],
      metadata: {
        skill: p.skill,
        mode: 'prompt',
        ...(skill.dir ? { dir: skill.dir } : {}),
        ...(skill.files && skill.files.length > 0 ? { files: skill.files } : {}),
      },
    };
  } catch (err) {
    return errorText(t('tools.useSkillInvokeFailed', {
      skill: p.skill,
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * 将 prompt 中的 {{key}} 占位符替换为 args[key] 的字符串值。
 * 未提供的占位符保持原样（方便用户看到缺哪个参数）。
 */
function substitutePlaceholders(prompt: string, args: Record<string, unknown>): string {
  return prompt.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      const val = args[key];
      return val === null || val === undefined ? match : String(val);
    }
    return match;
  });
}

// ============================================================================
// create / update / delete
// ============================================================================

function requireName(p: SkillParams): string {
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  if (!name) throw new SkillError(t('tools.skillNameRequired'));
  return name;
}

function createSkill(p: SkillParams, ctx: ToolContext, env: Environment): ToolResult {
  const registry = resolveSkillRegistry(ctx);
  const name = requireName(p);
  if (!SKILL_NAME_RE.test(name)) {
    throw new SkillError(t('tools.skillNameInvalid', { name }));
  }
  const description = typeof p.description === 'string' ? p.description.trim() : '';
  if (!description) throw new SkillError(t('tools.skillDescriptionRequired'));
  if (registry.get(name)) throw new SkillError(t('tools.skillTargetExists', { name }));

  const skillDir = join(env.dataDir, 'skills', name);
  const file = join(skillDir, 'SKILL.md');
  const allowedTools = toStringArray(p.allowedTools);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    file,
    buildSkillMarkdown({
      name,
      description,
      prompt: typeof p.content === 'string' ? p.content : '',
      ...(typeof p.icon === 'string' && p.icon.trim() ? { icon: p.icon.trim() } : {}),
      ...(allowedTools ? { allowedTools } : {}),
    }),
    'utf8',
  );
  registry.rescan();
  return textResult(t('tools.skillCreated', { name }), { kind: 'skill', action: 'create', name });
}

function updateSkill(p: SkillParams, ctx: ToolContext): ToolResult {
  const registry = resolveSkillRegistry(ctx);
  const name = requireName(p);
  const existing = registry.get(name);
  if (!existing) throw new SkillError(t('tools.skillTargetNotFound', { name }));

  const target = existing.dir ? join(existing.dir, 'SKILL.md') : existing.sourceFile;
  if (!target) throw new SkillError(t('tools.skillTargetNotFound', { name }));

  const allowedTools = toStringArray(p.allowedTools) ?? existing.allowedTools;
  writeFileSync(
    target,
    buildSkillMarkdown({
      name,
      description: typeof p.description === 'string' ? p.description.trim() : existing.description,
      prompt: typeof p.content === 'string' ? p.content : existing.prompt,
      icon: typeof p.icon === 'string' ? p.icon.trim() : existing.icon,
      ...(allowedTools ? { allowedTools } : {}),
    }),
    'utf8',
  );
  registry.rescan();
  return textResult(t('tools.skillUpdated', { name }), { kind: 'skill', action: 'update', name });
}

function deleteSkill(p: SkillParams, ctx: ToolContext, env: Environment): ToolResult {
  const registry = resolveSkillRegistry(ctx);
  const name = requireName(p);
  const existing = registry.get(name);
  if (!existing) throw new SkillError(t('tools.skillTargetNotFound', { name }));
  if (isBuiltinSkill(env, name)) {
    throw new SkillError(t('tools.skillBuiltinUndeletable', { name }));
  }
  const target = existing.dir ?? existing.sourceFile;
  if (!target) throw new SkillError(t('tools.skillTargetNotFound', { name }));
  rmSync(target, { recursive: true, force: true });
  registry.unregister(name);
  return textResult(t('tools.skillDeleted', { name }), { kind: 'skill', action: 'delete', name });
}

// ============================================================================
// search / install（SkillHub 市场）
// ============================================================================

async function searchMarket(p: SkillParams): Promise<ToolResult> {
  const keyword = typeof p.keyword === 'string' ? p.keyword.trim() : '';
  if (!keyword) throw new SkillError(t('tools.skillMarketKeywordRequired'));
  try {
    const { skills } = await queryMarketSkills({ keyword, pageSize: 12 });
    if (skills.length === 0) return textResult(t('tools.skillMarketNoResults'));
    const lines = skills.map((s) => {
      const canonical = s.canonicalName || s.slug;
      return `- ${s.name} (${canonical}): ${s.description || '-'}`;
    });
    return textResult(
      `${t('tools.skillMarketResultHeader', { count: skills.length })}\n${lines.join('\n')}`,
      { count: skills.length },
    );
  } catch (err) {
    throw new SkillError(
      t('tools.skillMarketUnavailable', {
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

async function installFromMarket(
  p: SkillParams,
  ctx: ToolContext,
  env: Environment,
): Promise<ToolResult> {
  const canonicalName = typeof p.canonicalName === 'string' ? p.canonicalName.trim() : '';
  if (!canonicalName) throw new SkillError(t('tools.skillMarketCanonicalRequired'));
  const registry = resolveSkillRegistry(ctx);
  const config = ctx.services.tryResolve<ConfigService>(ServiceNames.CONFIG_SERVICE);
  try {
    const result = await installMarketSkill({
      canonicalName,
      env,
      registry,
      ...(config ? { config } : {}),
    });
    return textResult(
      result.installed
        ? t('tools.skillInstalled', { name: result.name })
        : t('tools.skillAlreadyInstalled', { name: result.name }),
      { kind: 'skill', action: 'install', name: result.name, installed: result.installed },
    );
  } catch (err) {
    const message =
      err instanceof SkillMarketError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new SkillError(t('tools.skillInstallFailed', { message }));
  }
}

// ============================================================================
// 分派
// ============================================================================

async function dispatch(
  action: SkillAction,
  p: SkillParams,
  ctx: ToolContext,
  env: Environment,
): Promise<ToolResult> {
  switch (action) {
    case 'list':
      return runList(ctx);
    case 'use':
      return runUse(p, ctx);
    case 'create':
      return createSkill(p, ctx, env);
    case 'update':
      return updateSkill(p, ctx);
    case 'delete':
      return deleteSkill(p, ctx, env);
    case 'search':
      return searchMarket(p);
    case 'install':
      return installFromMarket(p, ctx, env);
  }
}

function parseAction(value: unknown): SkillAction {
  if (
    value === 'list' ||
    value === 'use' ||
    value === 'create' ||
    value === 'update' ||
    value === 'delete' ||
    value === 'search' ||
    value === 'install'
  ) {
    return value;
  }
  throw new SkillError(t('tools.skillActionInvalid'));
}

/**
 * 工厂导出：create/update/delete/install 需要 env（资源文件目录）与 ctx.services（注册表/配置）。
 */
export default function createExecute(env: Environment): {
  execute: (params: unknown, ctx: ToolContext) => Promise<ToolResult>;
} {
  return {
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const p = (params ?? {}) as SkillParams;
      try {
        const action = parseAction(p.action);
        const result = await dispatch(action, p, ctx, env);
        // create/update 携带 enabled 时同步写入 config.skills[name].enabled
        if (
          typeof p.enabled === 'boolean' &&
          (action === 'create' || action === 'update') &&
          typeof p.name === 'string' &&
          p.name.trim()
        ) {
          await applyEnabled(ctx, p.name.trim(), p.enabled);
        }
        return result;
      } catch (err) {
        if (err instanceof SkillError) return errorText(err.message);
        return errorText(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
