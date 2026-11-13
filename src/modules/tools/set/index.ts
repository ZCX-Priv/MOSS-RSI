// src/modules/tools/set/index.ts
// set 工具 execute 逻辑：统一管理 skill / rule / hook / command。
//   action: list | create | update | delete；kind=skill 额外支持 search / install（SkillHub 市场）。
//
// 设计要点：
//  - 名称是稳定标识：skill/command 更新不允许改名；rule/hook 优先按 id 精确定位。
//  - 写文件后立即刷新对应注册表（skill rescan / command reloadBySourceFile），不依赖 watch 防抖。
//  - 所有错误以 ToolResult.isError 返回；写操作的权限分级在 safety/policy.ts 中按 action 判定。
// 元数据见同目录 tool.json。

import { t } from '../../../core/i18n';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService, Environment } from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import type { ToolContext, ToolResult } from '../types';
import type { SkillRegistry } from '../shared/skill-registry';
import type { CommandRegistry } from '../use_command/registry';
import { COMMAND_NAME_RE, parseCommandFile } from '../use_command/registry';
import type { RulesEngineServiceImpl } from '../../rules/service';
import type { HooksEngineServiceImpl } from '../../hooks/service';
import type { RuleScope, ScopedRuleRecord } from '../../rules/types';
import type { HookEvent, HookScope, ScopedHookRecord } from '../../hooks/types';
import { HOOK_EVENTS } from '../../hooks/types';
import { installMarketSkill, queryMarketSkills, SkillMarketError } from '../shared/skill-market';
import type { AgentEngine } from '../../contracts';
import type { PermissionMode } from '../../safety/types';

type SetKind = 'skill' | 'rule' | 'hook' | 'command' | 'mode';
type SetAction = 'list' | 'create' | 'update' | 'delete' | 'search' | 'install' | 'set';

const PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>(['ask', 'auto', 'skip']);

interface SetParams {
  kind?: string;
  action?: string;
  name?: string;
  id?: string;
  scope?: string;
  description?: string;
  content?: string;
  enabled?: boolean;
  paths?: unknown;
  priority?: unknown;
  event?: string;
  matcher?: string;
  hookType?: string;
  command?: string;
  modulePath?: string;
  timeout?: unknown;
  icon?: string;
  allowedTools?: unknown;
  argumentHint?: string;
  keyword?: string;
  canonicalName?: string;
  mode?: string;
}

/** 工具内部错误：execute 统一转为 isError 结果 */
class SetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetError';
  }
}

/** skill / command 名称规则（与 SkillRegistry / CommandRegistry 保持一致） */
const SKILL_NAME_RE = /^[a-z][a-z0-9-]*$/;

// ============================================================================
// 通用 helper
// ============================================================================

function textResult(text: string, metadata?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(metadata ? { metadata } : {}),
  };
}

function failResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function parseKind(value: unknown): SetKind {
  if (
    value === 'skill' ||
    value === 'rule' ||
    value === 'hook' ||
    value === 'command' ||
    value === 'mode'
  ) {
    return value;
  }
  throw new SetError(t('tools.setKindInvalid'));
}

function parseAction(value: unknown): SetAction {
  if (
    value === 'list' ||
    value === 'create' ||
    value === 'update' ||
    value === 'delete' ||
    value === 'search' ||
    value === 'install' ||
    value === 'set'
  ) {
    return value;
  }
  throw new SetError(t('tools.setActionInvalid'));
}

function requireName(p: SetParams): string {
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  if (!name) throw new SetError(t('tools.setNameRequired'));
  return name;
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
  if (!registry) throw new SetError(t('tools.setRegistryUnavailable', { registry: 'skill' }));
  return registry;
}

function resolveCommandRegistry(ctx: ToolContext): CommandRegistry {
  const registry = ctx.services.tryResolve<CommandRegistry>(ServiceNames.COMMAND_REGISTRY);
  if (!registry) throw new SetError(t('tools.setRegistryUnavailable', { registry: 'command' }));
  return registry;
}

function resolveRulesEngine(ctx: ToolContext): RulesEngineServiceImpl {
  const engine = ctx.services.tryResolve<RulesEngineServiceImpl>(ServiceNames.RULES_ENGINE);
  if (!engine) throw new SetError(t('tools.setRegistryUnavailable', { registry: 'rule' }));
  return engine;
}

function resolveHooksEngine(ctx: ToolContext): HooksEngineServiceImpl {
  const engine = ctx.services.tryResolve<HooksEngineServiceImpl>(ServiceNames.HOOKS_ENGINE);
  if (!engine) throw new SetError(t('tools.setRegistryUnavailable', { registry: 'hook' }));
  return engine;
}

/** skill/command 启停写入 config（缺省即启用；这里只处理显式 enabled） */
async function applyEnabled(
  ctx: ToolContext,
  kind: 'skill' | 'command',
  name: string,
  enabled: boolean,
): Promise<void> {
  const config = ctx.services.tryResolve<ConfigService>(ServiceNames.CONFIG_SERVICE);
  if (!config) throw new SetError(t('tools.setConfigUnavailable'));
  const patch =
    kind === 'skill'
      ? { skills: { [name]: { enabled } } }
      : { commands: { [name]: { enabled } } };
  await config.updateAppConfig(patch);
}

function parseScope(value: unknown): RuleScope & HookScope {
  return value === 'project' ? 'project' : 'global';
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

function buildCommandMarkdown(data: {
  description?: string;
  argumentHint?: string;
  icon?: string;
  prompt: string;
}): string {
  const lines: string[] = ['---'];
  if (data.description) lines.push(`description: ${yamlString(data.description)}`);
  if (data.argumentHint) lines.push(`argument-hint: ${yamlString(data.argumentHint)}`);
  if (data.icon) lines.push(`icon: ${data.icon}`);
  lines.push('---', '', data.prompt.trim(), '');
  return lines.join('\n');
}

// ============================================================================
// skill
// ============================================================================

function listSkills(p: SetParams, ctx: ToolContext, env: Environment): ToolResult {
  const registry = resolveSkillRegistry(ctx);
  const nameFilter = typeof p.name === 'string' ? p.name.trim() : '';
  const skills = registry
    .list()
    .filter((s) => !nameFilter || s.name === nameFilter)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (skills.length === 0) return textResult(t('tools.setListEmpty', { kind: 'skill' }));
  const lines = skills.map((s) => {
    const flags = [
      isBuiltinSkill(env, s.name) ? 'builtin' : null,
      registry.isEnabled(s.name) ? 'enabled' : 'disabled',
    ].filter(Boolean) as string[];
    return `- ${s.name} [${flags.join(', ')}]: ${s.description || '-'}`;
  });
  return textResult(
    `${t('tools.setListHeader', { kind: 'skill', count: skills.length })}\n${lines.join('\n')}`,
    { count: skills.length },
  );
}

function createSkill(p: SetParams, ctx: ToolContext, env: Environment): ToolResult {
  const registry = resolveSkillRegistry(ctx);
  const name = requireName(p);
  if (!SKILL_NAME_RE.test(name)) {
    throw new SetError(t('tools.setResourceNameInvalid', { name }));
  }
  const description = typeof p.description === 'string' ? p.description.trim() : '';
  if (!description) throw new SetError(t('tools.setDescriptionRequired'));
  if (registry.get(name)) throw new SetError(t('tools.setTargetExists', { kind: 'skill', name }));

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
  return textResult(t('tools.setCreated', { kind: 'skill', name }), { kind: 'skill', action: 'create', name });
}

function updateSkill(p: SetParams, ctx: ToolContext, env: Environment): ToolResult {
  const registry = resolveSkillRegistry(ctx);
  const name = requireName(p);
  const existing = registry.get(name);
  if (!existing) throw new SetError(t('tools.setTargetNotFound', { kind: 'skill', name }));

  const target = existing.dir ? join(existing.dir, 'SKILL.md') : existing.sourceFile;
  if (!target) throw new SetError(t('tools.setTargetNotFound', { kind: 'skill', name }));

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
  return textResult(t('tools.setUpdated', { kind: 'skill', name }), { kind: 'skill', action: 'update', name });
}

function deleteSkill(p: SetParams, ctx: ToolContext, env: Environment): ToolResult {
  const registry = resolveSkillRegistry(ctx);
  const name = requireName(p);
  const existing = registry.get(name);
  if (!existing) throw new SetError(t('tools.setTargetNotFound', { kind: 'skill', name }));
  if (isBuiltinSkill(env, name)) {
    throw new SetError(t('tools.setBuiltinUndeletable', { name }));
  }
  const target = existing.dir ?? existing.sourceFile;
  if (!target) throw new SetError(t('tools.setTargetNotFound', { kind: 'skill', name }));
  rmSync(target, { recursive: true, force: true });
  registry.unregister(name);
  return textResult(t('tools.setDeleted', { kind: 'skill', name }), { kind: 'skill', action: 'delete', name });
}

async function searchMarket(p: SetParams): Promise<ToolResult> {
  const keyword = typeof p.keyword === 'string' ? p.keyword.trim() : '';
  if (!keyword) throw new SetError(t('tools.setMarketKeywordRequired'));
  try {
    const { skills } = await queryMarketSkills({ keyword, pageSize: 12 });
    if (skills.length === 0) return textResult(t('tools.setMarketNoResults'));
    const lines = skills.map((s) => {
      const canonical = s.canonicalName || s.slug;
      return `- ${s.name} (${canonical}): ${s.description || '-'}`;
    });
    return textResult(
      `${t('tools.setMarketResultHeader', { count: skills.length })}\n${lines.join('\n')}`,
      { count: skills.length },
    );
  } catch (err) {
    throw new SetError(
      t('tools.setMarketUnavailable', {
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

async function installFromMarket(
  p: SetParams,
  ctx: ToolContext,
  env: Environment,
): Promise<ToolResult> {
  const canonicalName = typeof p.canonicalName === 'string' ? p.canonicalName.trim() : '';
  if (!canonicalName) throw new SetError(t('tools.setMarketCanonicalRequired'));
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
        ? t('tools.setInstalled', { name: result.name })
        : t('tools.setAlreadyInstalled', { name: result.name }),
      { kind: 'skill', action: 'install', name: result.name, installed: result.installed },
    );
  } catch (err) {
    const message =
      err instanceof SkillMarketError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new SetError(t('tools.setInstallFailed', { message }));
  }
}

async function dispatchSkill(
  action: SetAction,
  p: SetParams,
  ctx: ToolContext,
  env: Environment,
): Promise<ToolResult> {
  switch (action) {
    case 'list':
      return listSkills(p, ctx, env);
    case 'create':
      return createSkill(p, ctx, env);
    case 'update':
      return updateSkill(p, ctx, env);
    case 'delete':
      return deleteSkill(p, ctx, env);
    case 'search':
      return searchMarket(p);
    case 'install':
      return installFromMarket(p, ctx, env);
    default:
      throw new SetError(t('tools.setModeActionOnly'));
  }
}

// ============================================================================
// rule
// ============================================================================

function allRules(
  engine: RulesEngineServiceImpl,
  cwd: string,
  scope?: RuleScope,
): ScopedRuleRecord[] {
  const list = engine.list(cwd);
  if (scope === 'project') return list.project;
  if (scope === 'global') return list.global;
  return [...list.project, ...list.global];
}

function locateRule(
  engine: RulesEngineServiceImpl,
  cwd: string,
  p: SetParams,
): ScopedRuleRecord {
  const scoped = p.scope === 'project' || p.scope === 'global' ? (p.scope as RuleScope) : undefined;
  const candidates = allRules(engine, cwd, scoped);
  const id = typeof p.id === 'string' ? p.id.trim() : '';
  if (id) {
    const found = candidates.find((r) => r.id === id);
    if (found) return found;
    throw new SetError(t('tools.setTargetNotFound', { kind: 'rule', name: id }));
  }
  const name = requireName(p);
  const matches = candidates.filter((r) => r.name === name);
  if (matches.length === 0) throw new SetError(t('tools.setTargetNotFound', { kind: 'rule', name }));
  if (matches.length > 1) throw new SetError(t('tools.setAmbiguousTarget', { kind: 'rule', name }));
  return matches[0];
}

function listRules(p: SetParams, ctx: ToolContext): ToolResult {
  const engine = resolveRulesEngine(ctx);
  const scope = p.scope === 'project' || p.scope === 'global' ? (p.scope as RuleScope) : undefined;
  const nameFilter = typeof p.name === 'string' ? p.name.trim() : '';
  const rules = allRules(engine, ctx.cwd, scope)
    .filter((r) => !nameFilter || r.name === nameFilter)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (rules.length === 0) return textResult(t('tools.setListEmpty', { kind: 'rule' }));
  const lines = rules.map((r) => {
    const paths = r.paths.length > 0 ? `, paths=${r.paths.join(', ')}` : '';
    return `- [${r.scope}] ${r.name} (id=${r.id}, ${r.enabled ? 'enabled' : 'disabled'}${paths})`;
  });
  return textResult(
    `${t('tools.setListHeader', { kind: 'rule', count: rules.length })}\n${lines.join('\n')}`,
    { count: rules.length },
  );
}

function createRule(p: SetParams, ctx: ToolContext): ToolResult {
  const engine = resolveRulesEngine(ctx);
  const name = requireName(p);
  if (typeof p.content !== 'string' || !p.content.trim()) {
    throw new SetError(t('tools.setContentRequired'));
  }
  const record = engine.upsert(ctx.cwd, parseScope(p.scope), {
    name,
    content: p.content,
    ...(typeof p.description === 'string' ? { description: p.description } : {}),
    ...(toStringArray(p.paths) ? { paths: toStringArray(p.paths) } : {}),
    ...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}),
    ...(typeof p.priority === 'number' ? { priority: p.priority } : {}),
  });
  return textResult(t('tools.setCreated', { kind: 'rule', name }), {
    kind: 'rule',
    action: 'create',
    name,
    id: record.id,
  });
}

function updateRule(p: SetParams, ctx: ToolContext): ToolResult {
  const engine = resolveRulesEngine(ctx);
  const existing = locateRule(engine, ctx.cwd, p);
  const paths = toStringArray(p.paths);
  const record = engine.upsert(
    ctx.cwd,
    existing.scope,
    {
      name: existing.name,
      description: typeof p.description === 'string' ? p.description : existing.description,
      content: typeof p.content === 'string' && p.content.trim() ? p.content : existing.content,
      paths: paths ?? existing.paths,
      enabled: typeof p.enabled === 'boolean' ? p.enabled : existing.enabled,
      priority: typeof p.priority === 'number' ? p.priority : existing.priority,
    },
    existing.id,
  );
  return textResult(t('tools.setUpdated', { kind: 'rule', name: existing.name }), {
    kind: 'rule',
    action: 'update',
    name: existing.name,
    id: record.id,
  });
}

function deleteRule(p: SetParams, ctx: ToolContext): ToolResult {
  const engine = resolveRulesEngine(ctx);
  const existing = locateRule(engine, ctx.cwd, p);
  const ok = engine.delete(ctx.cwd, existing.id);
  if (!ok) throw new SetError(t('tools.setTargetNotFound', { kind: 'rule', name: existing.name }));
  return textResult(t('tools.setDeleted', { kind: 'rule', name: existing.name }), {
    kind: 'rule',
    action: 'delete',
    name: existing.name,
    id: existing.id,
  });
}

// ============================================================================
// hook
// ============================================================================

function allHooks(
  engine: HooksEngineServiceImpl,
  cwd: string,
  scope?: HookScope,
): ScopedHookRecord[] {
  const list = engine.list(cwd);
  if (scope === 'project') return list.project;
  if (scope === 'global') return list.global;
  return [...list.project, ...list.global];
}

function locateHook(
  engine: HooksEngineServiceImpl,
  cwd: string,
  p: SetParams,
): ScopedHookRecord {
  const scoped = p.scope === 'project' || p.scope === 'global' ? (p.scope as HookScope) : undefined;
  const candidates = allHooks(engine, cwd, scoped);
  const id = typeof p.id === 'string' ? p.id.trim() : '';
  if (id) {
    const found = candidates.find((h) => h.id === id);
    if (found) return found;
    throw new SetError(t('tools.setTargetNotFound', { kind: 'hook', name: id }));
  }
  const name = requireName(p);
  const matches = candidates.filter((h) => h.name === name);
  if (matches.length === 0) throw new SetError(t('tools.setTargetNotFound', { kind: 'hook', name }));
  if (matches.length > 1) throw new SetError(t('tools.setAmbiguousTarget', { kind: 'hook', name }));
  return matches[0];
}

function parseHookEvent(value: unknown): HookEvent {
  if (typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value)) {
    return value as HookEvent;
  }
  throw new SetError(t('tools.setHookEventInvalid', { events: HOOK_EVENTS.join(', ') }));
}

function validateHookTarget(type: 'terminal' | 'module', command: string, modulePath: string): void {
  if (type === 'terminal' && !command) throw new SetError(t('tools.setHookCommandRequired'));
  if (type === 'module' && !modulePath) throw new SetError(t('tools.setHookModuleRequired'));
}

function listHooks(p: SetParams, ctx: ToolContext): ToolResult {
  const engine = resolveHooksEngine(ctx);
  const scope = p.scope === 'project' || p.scope === 'global' ? (p.scope as HookScope) : undefined;
  const nameFilter = typeof p.name === 'string' ? p.name.trim() : '';
  const hooks = allHooks(engine, ctx.cwd, scope)
    .filter((h) => !nameFilter || h.name === nameFilter)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (hooks.length === 0) return textResult(t('tools.setListEmpty', { kind: 'hook' }));
  const lines = hooks.map((h) => {
    return `- [${h.scope}] ${h.name} (id=${h.id}, event=${h.event}, type=${h.type}, ${h.enabled ? 'enabled' : 'disabled'})`;
  });
  return textResult(
    `${t('tools.setListHeader', { kind: 'hook', count: hooks.length })}\n${lines.join('\n')}`,
    { count: hooks.length },
  );
}

function createHook(p: SetParams, ctx: ToolContext): ToolResult {
  const engine = resolveHooksEngine(ctx);
  const name = requireName(p);
  const event = parseHookEvent(p.event);
  const type = p.hookType === 'module' ? 'module' : 'terminal';
  const command = typeof p.command === 'string' ? p.command : '';
  const modulePath = typeof p.modulePath === 'string' ? p.modulePath : '';
  validateHookTarget(type, command, modulePath);
  const record = engine.upsert(ctx.cwd, parseScope(p.scope), {
    name,
    event,
    ...(typeof p.matcher === 'string' ? { matcher: p.matcher || null } : { matcher: null }),
    type,
    command,
    modulePath,
    ...(typeof p.timeout === 'number' ? { timeout: p.timeout } : {}),
    ...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}),
  });
  return textResult(t('tools.setCreated', { kind: 'hook', name }), {
    kind: 'hook',
    action: 'create',
    name,
    id: record.id,
  });
}

function updateHook(p: SetParams, ctx: ToolContext): ToolResult {
  const engine = resolveHooksEngine(ctx);
  const existing = locateHook(engine, ctx.cwd, p);
  const event = p.event === undefined ? existing.event : parseHookEvent(p.event);
  const type = p.hookType === 'module' || p.hookType === 'terminal' ? p.hookType : existing.type;
  const command = typeof p.command === 'string' ? p.command : existing.command;
  const modulePath = typeof p.modulePath === 'string' ? p.modulePath : existing.modulePath;
  validateHookTarget(type, command, modulePath);
  const record = engine.upsert(
    ctx.cwd,
    existing.scope,
    {
      name: existing.name,
      event,
      matcher: typeof p.matcher === 'string' ? p.matcher || null : existing.matcher,
      type,
      command,
      modulePath,
      timeout: typeof p.timeout === 'number' ? p.timeout : existing.timeout,
      enabled: typeof p.enabled === 'boolean' ? p.enabled : existing.enabled,
    },
    existing.id,
  );
  return textResult(t('tools.setUpdated', { kind: 'hook', name: existing.name }), {
    kind: 'hook',
    action: 'update',
    name: existing.name,
    id: record.id,
  });
}

function deleteHook(p: SetParams, ctx: ToolContext): ToolResult {
  const engine = resolveHooksEngine(ctx);
  const existing = locateHook(engine, ctx.cwd, p);
  const ok = engine.delete(ctx.cwd, existing.id);
  if (!ok) throw new SetError(t('tools.setTargetNotFound', { kind: 'hook', name: existing.name }));
  return textResult(t('tools.setDeleted', { kind: 'hook', name: existing.name }), {
    kind: 'hook',
    action: 'delete',
    name: existing.name,
    id: existing.id,
  });
}

// ============================================================================
// command
// ============================================================================

function listCommands(p: SetParams, ctx: ToolContext): ToolResult {
  const registry = resolveCommandRegistry(ctx);
  const nameFilter = typeof p.name === 'string' ? p.name.trim() : '';
  const commands = registry
    .list()
    .filter((c) => !nameFilter || c.name === nameFilter)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (commands.length === 0) return textResult(t('tools.setListEmpty', { kind: 'command' }));
  const lines = commands.map((c) => {
    const flags = registry.isEnabled(c.name) ? 'enabled' : 'disabled';
    return `- ${c.name} [${flags}]: ${c.description || '-'}`;
  });
  return textResult(
    `${t('tools.setListHeader', { kind: 'command', count: commands.length })}\n${lines.join('\n')}`,
    { count: commands.length },
  );
}

function reloadCommand(registry: CommandRegistry, file: string): void {
  const cmd = parseCommandFile(file);
  if (!cmd) throw new SetError(t('tools.setCommandReloadFailed', { name: file }));
  registry.reloadBySourceFile(file, cmd);
}

function createCommand(p: SetParams, ctx: ToolContext, env: Environment): ToolResult {
  const registry = resolveCommandRegistry(ctx);
  const name = requireName(p);
  if (!COMMAND_NAME_RE.test(name)) {
    throw new SetError(t('tools.setResourceNameInvalid', { name }));
  }
  if (registry.get(name)) throw new SetError(t('tools.setTargetExists', { kind: 'command', name }));
  if (typeof p.content !== 'string' || !p.content.trim()) {
    throw new SetError(t('tools.setContentRequired'));
  }

  const dir = join(env.dataDir, 'commands');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.md`);
  writeFileSync(
    file,
    buildCommandMarkdown({
      ...(typeof p.description === 'string' ? { description: p.description } : {}),
      ...(typeof p.argumentHint === 'string' ? { argumentHint: p.argumentHint } : {}),
      ...(typeof p.icon === 'string' ? { icon: p.icon } : {}),
      prompt: p.content,
    }),
    'utf8',
  );
  reloadCommand(registry, file);
  return textResult(t('tools.setCreated', { kind: 'command', name }), {
    kind: 'command',
    action: 'create',
    name,
  });
}

function updateCommand(p: SetParams, ctx: ToolContext): ToolResult {
  const registry = resolveCommandRegistry(ctx);
  const name = requireName(p);
  const existing = registry.get(name);
  if (!existing) throw new SetError(t('tools.setTargetNotFound', { kind: 'command', name }));
  const prompt = typeof p.content === 'string' ? p.content : existing.prompt;
  if (!prompt.trim()) throw new SetError(t('tools.setContentRequired'));

  writeFileSync(
    existing.sourceFile,
    buildCommandMarkdown({
      description: typeof p.description === 'string' ? p.description : existing.description,
      argumentHint: typeof p.argumentHint === 'string' ? p.argumentHint : existing.argumentHint,
      icon: typeof p.icon === 'string' ? p.icon : existing.icon,
      prompt,
    }),
    'utf8',
  );
  reloadCommand(registry, existing.sourceFile);
  return textResult(t('tools.setUpdated', { kind: 'command', name }), {
    kind: 'command',
    action: 'update',
    name,
  });
}

function deleteCommand(p: SetParams, ctx: ToolContext): ToolResult {
  const registry = resolveCommandRegistry(ctx);
  const name = requireName(p);
  const existing = registry.get(name);
  if (!existing) throw new SetError(t('tools.setTargetNotFound', { kind: 'command', name }));
  rmSync(existing.sourceFile, { force: true });
  registry.removeBySourceFile(existing.sourceFile);
  return textResult(t('tools.setDeleted', { kind: 'command', name }), {
    kind: 'command',
    action: 'delete',
    name,
  });
}

// ============================================================================
// mode（会话权限模式）
// ============================================================================

function setSessionMode(p: SetParams, ctx: ToolContext): ToolResult {
  const mode = p.mode === 'ask' || p.mode === 'auto' || p.mode === 'skip' ? p.mode : undefined;
  if (!mode || !PERMISSION_MODES.has(mode)) {
    throw new SetError(t('tools.setModeInvalid'));
  }
  const engine = ctx.services.tryResolve<AgentEngine>(ServiceNames.AGENT_ENGINE);
  if (!engine?.setPermissionMode) {
    throw new SetError(t('tools.setModeUnavailable'));
  }
  const ok = engine.setPermissionMode(ctx.sessionId, mode);
  if (!ok) throw new SetError(t('tools.setModeUnavailable'));
  return textResult(t('tools.setModeApplied', { mode }), {
    kind: 'mode',
    action: 'set',
    mode,
  });
}

// ============================================================================
// 分派
// ============================================================================

async function dispatch(p: SetParams, ctx: ToolContext, env: Environment): Promise<ToolResult> {
  const kind = parseKind(p.kind);
  const action = parseAction(p.action);

  if (kind === 'mode') {
    if (action !== 'set') throw new SetError(t('tools.setModeActionOnly'));
    return setSessionMode(p, ctx);
  }

  if (kind !== 'skill' && (action === 'search' || action === 'install')) {
    throw new SetError(t('tools.setMarketSkillOnly'));
  }
  if (action === 'set') {
    // set 仅用于 kind=mode
    throw new SetError(t('tools.setModeActionOnly'));
  }

  switch (kind) {
    case 'skill':
      return dispatchSkill(action, p, ctx, env);
    case 'rule':
      switch (action) {
        case 'list':
          return listRules(p, ctx);
        case 'create':
          return createRule(p, ctx);
        case 'update':
          return updateRule(p, ctx);
        case 'delete':
          return deleteRule(p, ctx);
        default:
          throw new SetError(t('tools.setMarketSkillOnly'));
      }
    case 'hook':
      switch (action) {
        case 'list':
          return listHooks(p, ctx);
        case 'create':
          return createHook(p, ctx);
        case 'update':
          return updateHook(p, ctx);
        case 'delete':
          return deleteHook(p, ctx);
        default:
          throw new SetError(t('tools.setMarketSkillOnly'));
      }
    case 'command':
      switch (action) {
        case 'list':
          return listCommands(p, ctx);
        case 'create':
          return createCommand(p, ctx, env);
        case 'update':
          return updateCommand(p, ctx);
        case 'delete':
          return deleteCommand(p, ctx);
        default:
          throw new SetError(t('tools.setMarketSkillOnly'));
      }
  }
}

/**
 * 工厂导出：需要 env（资源文件目录）与 ctx.services（注册表/引擎）。
 * 写操作后显式刷新注册表；enabled 变更写入 config。
 */
export default function createExecute(env: Environment): { execute: (params: unknown, ctx: ToolContext) => Promise<ToolResult> } {
  return {
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const p = (params ?? {}) as SetParams;
      try {
        const result = await dispatch(p, ctx, env);
        // skill/command 的显式启停（create/update 都可携带）
        const kind = p.kind;
        if (
          typeof p.enabled === 'boolean' &&
          (kind === 'skill' || kind === 'command') &&
          (p.action === 'create' || p.action === 'update') &&
          typeof p.name === 'string' &&
          p.name.trim()
        ) {
          await applyEnabled(ctx, kind, p.name.trim(), p.enabled);
        }
        return result;
      } catch (err) {
        if (err instanceof SetError) return failResult(err.message);
        return failResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
