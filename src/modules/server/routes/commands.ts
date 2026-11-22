// src/modules/server/routes/commands.ts
// 自定义斜杠命令 CRUD（~/.moss/commands/<name>.md 单文件；文件名即命令名）。
// GET /api/commands（列表含 prompt）、POST /api/commands、PUT /api/commands/:name、
// DELETE /api/commands/:name、PATCH /api/commands/:name（启停）。
// 写入后 fs.watch 自动热重载 → resources:changed 广播 → 前端自动刷新。

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { ConfigService, Environment, ServiceRegistry } from '../../../core/types';
import type { CommandRegistry, Command } from '../../tools/use_command/registry';
import { COMMAND_NAME_RE } from '../../tools/use_command/registry';
import { ErrorCode } from '../../../core/error-codes';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Command → 前端 API 形状（含 prompt，供前端一次性注入渲染） */
function toCommandItem(c: Command, registry: CommandRegistry): Record<string, unknown> {
  return {
    name: c.name,
    description: c.description,
    prompt: c.prompt,
    enabled: registry.isEnabled(c.name),
    ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
    ...(c.icon ? { icon: c.icon } : {}),
  };
}

interface CommandContentBody {
  name?: unknown;
  description?: unknown;
  prompt?: unknown;
  argumentHint?: unknown;
  icon?: unknown;
}

/** YAML 双引号字符串转义（换行/引号/反斜杠） */
function yamlString(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

/** 结构化字段 → <name>.md 全文（frontmatter + body） */
function buildCommandMarkdown(data: {
  name: string;
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

/** 校验并规范化 body 字段；失败返回 error 错误码 */
function validateCommandBody(
  body: CommandContentBody | undefined,
  requireName: boolean,
): { error?: string; data: { name?: string; description?: string; argumentHint?: string; icon?: string; prompt: string } } {
  if (!body || typeof body !== 'object') {
    return { error: ErrorCode.INVALID_BODY, data: { prompt: '' } };
  }
  let name: string | undefined;
  if (requireName) {
    if (typeof body.name !== 'string' || !COMMAND_NAME_RE.test(body.name)) {
      return { error: ErrorCode.COMMAND_NAME_INVALID, data: { prompt: '' } };
    }
    name = body.name;
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return { error: ErrorCode.COMMAND_PROMPT_REQUIRED, data: { prompt: '' } };
  }
  const description = typeof body.description === 'string' ? body.description.trim() : undefined;
  const argumentHint =
    typeof body.argumentHint === 'string' && body.argumentHint.trim()
      ? body.argumentHint.trim()
      : undefined;
  const icon = typeof body.icon === 'string' && body.icon.trim() ? body.icon.trim() : undefined;
  return { data: { name, description, argumentHint, icon, prompt } };
}

function resolveRegistry(
  services: ServiceRegistry,
): CommandRegistry | null {
  return services.tryResolve<CommandRegistry>('command.registry');
}

/** GET /api/commands — 列表（含 prompt，供前端渲染注入） */
export function createListCommandsHandler(services: ServiceRegistry): RouteHandler {
  return async (): Promise<HttpResponse> => {
    const registry = resolveRegistry(services);
    if (!registry) {
      return { status: 200, body: { commands: [] } };
    }
    const commands = registry.list().map(c => toCommandItem(c, registry));
    return { status: 200, body: { commands } };
  };
}

/** POST /api/commands — 创建（写 ~/.moss/commands/<name>.md） */
export function createCreateCommandHandler(
  services: ServiceRegistry,
  env: Environment,
): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const registry = resolveRegistry(services);
    if (!registry) {
      return { status: 404, body: { error: ErrorCode.COMMAND_REGISTRY_UNAVAILABLE } };
    }
    const { error, data } = validateCommandBody(req.body as CommandContentBody | undefined, true);
    if (error) return { status: 400, body: { error } };
    const name = data.name!;
    if (registry.get(name)) {
      return { status: 409, body: { error: ErrorCode.COMMAND_ALREADY_EXISTS } };
    }
    try {
      writeFileSync(
        join(env.dataDir, 'commands', `${name}.md`),
        buildCommandMarkdown({
          name,
          description: data.description,
          argumentHint: data.argumentHint,
          icon: data.icon,
          prompt: data.prompt,
        }),
        'utf8',
      );
      return { status: 200, body: { name } };
    } catch (err) {
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

/** PUT /api/commands/:name — 更新内容（重写 <name>.md；禁止改名） */
export function createUpdateCommandHandler(
  services: ServiceRegistry,
  _env: Environment,
): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const name = params?.name;
    if (!name) {
      return { status: 400, body: { error: ErrorCode.COMMAND_NAME_REQUIRED } };
    }
    const registry = resolveRegistry(services);
    if (!registry) {
      return { status: 404, body: { error: ErrorCode.COMMAND_REGISTRY_UNAVAILABLE } };
    }
    const command = registry.get(name);
    if (!command) {
      return { status: 404, body: { error: ErrorCode.COMMAND_NOT_FOUND } };
    }
    const { error, data } = validateCommandBody(req.body as CommandContentBody | undefined, false);
    if (error) return { status: 400, body: { error } };
    try {
      writeFileSync(
        command.sourceFile,
        buildCommandMarkdown({
          name,
          description: data.description,
          argumentHint: data.argumentHint,
          icon: data.icon,
          prompt: data.prompt,
        }),
        'utf8',
      );
      return { status: 200, body: { name } };
    } catch (err) {
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

/** DELETE /api/commands/:name — 删除（删 <name>.md；watch 自动移除注册） */
export function createDeleteCommandHandler(
  services: ServiceRegistry,
): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const name = params?.name;
    if (!name) {
      return { status: 400, body: { error: ErrorCode.COMMAND_NAME_REQUIRED } };
    }
    const registry = resolveRegistry(services);
    if (!registry) {
      return { status: 404, body: { error: ErrorCode.COMMAND_REGISTRY_UNAVAILABLE } };
    }
    const command = registry.get(name);
    if (!command) {
      return { status: 404, body: { error: ErrorCode.COMMAND_NOT_FOUND } };
    }
    try {
      rmSync(command.sourceFile, { force: true });
      return { status: 200, body: { name } };
    } catch (err) {
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

/** PATCH /api/commands/:name — 启停（写 config.commands[name].enabled，热生效） */
export function createToggleCommandHandler(
  services: ServiceRegistry,
  config: ConfigService,
): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const name = params?.name;
    if (!name) {
      return { status: 400, body: { error: ErrorCode.COMMAND_NAME_REQUIRED } };
    }
    const registry = resolveRegistry(services);
    if (!registry) {
      return { status: 404, body: { error: ErrorCode.COMMAND_REGISTRY_UNAVAILABLE } };
    }
    if (!registry.get(name)) {
      return { status: 404, body: { error: ErrorCode.COMMAND_NOT_FOUND } };
    }
    const body = req.body as { enabled?: boolean } | undefined;
    if (typeof body?.enabled !== 'boolean') {
      return { status: 400, body: { error: 'enabled (boolean) is required' } };
    }
    try {
      const patch = { commands: { [name]: { enabled: body.enabled } } } as Record<string, unknown>;
      await config.updateAppConfig(patch);
      return { status: 200, body: { name, enabled: body.enabled } };
    } catch (err) {
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}
