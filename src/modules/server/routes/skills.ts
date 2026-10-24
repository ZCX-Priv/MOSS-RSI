// src/modules/server/routes/skills.ts
// GET /api/skills, GET /api/skills/:name, PATCH /api/skills/:name（启停）
// POST /api/skills（新建目录式 skill）、POST /api/skills/import（前端 zip 解包后批量写文件）
// （自定义斜杠命令 CRUD 见 routes/commands.ts —— command 与 skill 是两个体系）

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { ConfigService, Environment, ServiceRegistry } from '../../../core/types';
import type { SkillRegistry, Skill } from '../../tools/shared/skill-registry';
import { ErrorCode } from '../../../core/error-codes';

/** Skill → 前端 API 形状（含启停状态与扩展字段） */
function toSkillItem(
  s: Skill,
  registry: SkillRegistry,
): Record<string, unknown> {
  return {
    name: s.name,
    description: s.description,
    prompt: s.prompt,
    sourceFile: s.sourceFile,
    source: 'user' as const,
    enabled: registry.isEnabled(s.name),
    ...(s.dir ? { dir: s.dir } : {}),
    ...(s.icon ? { icon: s.icon } : {}),
    ...(s.allowedTools ? { allowedTools: s.allowedTools } : {}),
    ...(s.files && s.files.length > 0 ? { files: s.files } : {}),
  };
}

export function createListSkillsHandler(services: ServiceRegistry): RouteHandler {
  return async (): Promise<HttpResponse> => {
    const registry = services.tryResolve<SkillRegistry>('skill.registry');
    if (!registry) {
      return { status: 200, body: { skills: [] } };
    }
    const skills = registry.list().map(s => toSkillItem(s, registry));
    return { status: 200, body: { skills } };
  };
}

export function createGetSkillHandler(services: ServiceRegistry): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const name = params?.name;
    if (!name) {
      return { status: 400, body: { error: ErrorCode.SKILL_NAME_REQUIRED } };
    }
    const registry = services.tryResolve<SkillRegistry>('skill.registry');
    if (!registry) {
      return { status: 404, body: { error: ErrorCode.SKILL_REGISTRY_UNAVAILABLE } };
    }
    const skill = registry.get(name);
    if (!skill) {
      return { status: 404, body: { error: ErrorCode.SKILL_NOT_FOUND } };
    }
    // 自定义 svg 图标：icon 以 .svg 结尾且为目录式 skill 时读取文件内容
    let iconSvg: string | undefined;
    if (skill.icon && skill.icon.endsWith('.svg') && skill.dir) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('node:fs');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('node:path');
        const iconPath = path.resolve(skill.dir, skill.icon);
        // 路径穿越防护：解析后必须仍在 skill 目录内
        if (iconPath.startsWith(path.resolve(skill.dir))) {
          iconSvg = fs.readFileSync(iconPath, 'utf8');
        }
      } catch {
        // 图标读取失败：忽略，前端回退默认图标
      }
    }
    return {
      status: 200,
      body: {
        skill: {
          ...toSkillItem(skill, registry),
          ...(iconSvg ? { iconSvg } : {}),
        },
      },
    };
  };
}

/** PATCH /api/skills/:name — 切换 skill 启用状态（写 config.skills[name].enabled，热生效） */
export function createUpdateSkillHandler(
  services: ServiceRegistry,
  config: ConfigService,
): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const name = params?.name;
    if (!name) {
      return { status: 400, body: { error: ErrorCode.SKILL_NAME_REQUIRED } };
    }
    const registry = services.tryResolve<SkillRegistry>('skill.registry');
    if (!registry) {
      return { status: 404, body: { error: ErrorCode.SKILL_REGISTRY_UNAVAILABLE } };
    }
    const skill = registry.get(name);
    if (!skill) {
      return { status: 404, body: { error: ErrorCode.SKILL_NOT_FOUND } };
    }
    const body = req.body as { enabled?: boolean } | undefined;
    if (typeof body?.enabled !== 'boolean') {
      return { status: 400, body: { error: 'enabled (boolean) is required' } };
    }
    try {
      const patch = { skills: { [name]: { enabled: body.enabled } } } as Record<string, unknown>;
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

/* ===== 新建 / 导入（目录式 skill 写 ~/.moss/skills/<name>/，watch 热重载自动生效） ===== */

/** skill 名合法字符（同时充当文件/目录名，防路径穿越） */
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** YAML 双引号字符串转义（换行/引号/反斜杠） */
function yamlString(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

/** 结构化字段 → SKILL.md 全文（frontmatter + prompt body） */
function buildSkillMarkdown(data: {
  name: string;
  description: string;
  prompt: string;
  icon?: string;
}): string {
  const lines: string[] = ['---', `name: ${data.name}`, `description: ${yamlString(data.description)}`];
  if (data.icon) lines.push(`icon: ${data.icon}`);
  lines.push('---', '', data.prompt.trim(), '');
  return lines.join('\n');
}

interface CreateSkillBody {
  name?: unknown;
  description?: unknown;
  prompt?: unknown;
  icon?: unknown;
}

/** POST /api/skills — 新建目录式 skill（写 ~/.moss/skills/<name>/SKILL.md） */
export function createCreateSkillHandler(
  services: ServiceRegistry,
  env: Environment,
): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const registry = services.tryResolve<SkillRegistry>('skill.registry');
    if (!registry) {
      return { status: 404, body: { error: ErrorCode.SKILL_REGISTRY_UNAVAILABLE } };
    }
    const body = req.body as CreateSkillBody | undefined;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!SKILL_NAME_RE.test(name)) {
      return { status: 400, body: { error: ErrorCode.SKILL_NAME_INVALID } };
    }
    const description = typeof body?.description === 'string' ? body.description.trim() : '';
    if (!description) {
      return { status: 400, body: { error: ErrorCode.SKILL_DESCRIPTION_REQUIRED } };
    }
    if (registry.get(name)) {
      return { status: 409, body: { error: ErrorCode.SKILL_ALREADY_EXISTS } };
    }
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    const icon = typeof body?.icon === 'string' && body.icon.trim() ? body.icon.trim() : undefined;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path');
    const skillDir = path.join(env.dataDir, 'skills', name);
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        buildSkillMarkdown({ name, description, prompt, icon }),
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

interface ImportSkillFileBody {
  path?: unknown;
  content?: unknown;
  base64?: unknown;
}

interface ImportSkillBody {
  name?: unknown;
  files?: unknown;
}

/**
 * POST /api/skills/import — 前端 zip 解包后批量写入（文本 content / 二进制 base64）。
 * 逐条校验 path 为相对路径且不含 ..，目标必须落在 ~/.moss/skills/<name>/ 内（isPathInside 防穿越）。
 */
export function createImportSkillHandler(
  services: ServiceRegistry,
  env: Environment,
): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const registry = services.tryResolve<SkillRegistry>('skill.registry');
    if (!registry) {
      return { status: 404, body: { error: ErrorCode.SKILL_REGISTRY_UNAVAILABLE } };
    }
    const body = req.body as ImportSkillBody | undefined;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!SKILL_NAME_RE.test(name)) {
      return { status: 400, body: { error: ErrorCode.SKILL_NAME_INVALID } };
    }
    if (!Array.isArray(body?.files) || body.files.length === 0) {
      return { status: 400, body: { error: ErrorCode.SKILL_FILES_REQUIRED } };
    }
    if (registry.get(name)) {
      return { status: 409, body: { error: ErrorCode.SKILL_ALREADY_EXISTS } };
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { isPathInside } = require('../../../utils/fs');
    const skillRoot = path.resolve(env.dataDir, 'skills', name);

    // 先整体校验，全部通过后再落盘（避免半写状态）
    const pending: Array<{ target: string; content: string; encoding: 'utf8' | 'base64' }> = [];
    for (const f of body.files as ImportSkillFileBody[]) {
      const rel = typeof f?.path === 'string' ? f.path.replace(/\\/g, '/').replace(/^\/+/, '') : '';
      if (
        !rel ||
        rel.split('/').includes('..') ||
        rel.includes('\0')
      ) {
        return { status: 400, body: { error: ErrorCode.SKILL_NAME_INVALID } };
      }
      const target = path.resolve(skillRoot, rel);
      if (!isPathInside(target, skillRoot)) {
        return { status: 400, body: { error: ErrorCode.SKILL_NAME_INVALID } };
      }
      if (typeof f.content === 'string') {
        pending.push({ target, content: f.content, encoding: 'utf8' });
      } else if (typeof f.base64 === 'string') {
        pending.push({ target, content: f.base64, encoding: 'base64' });
      } else {
        return { status: 400, body: { error: ErrorCode.SKILL_FILES_REQUIRED } };
      }
    }

    try {
      fs.mkdirSync(skillRoot, { recursive: true });
      for (const p of pending) {
        fs.mkdirSync(path.dirname(p.target), { recursive: true });
        fs.writeFileSync(p.target, p.content, p.encoding);
      }
      return { status: 200, body: { name, files: pending.length } };
    } catch (err) {
      // 失败时清理半写目录
      try {
        fs.rmSync(skillRoot, { recursive: true, force: true });
      } catch {
        // 清理失败仅忽略（目录残留不影响后续 409 判断：registry 按 SKILL.md 热重载）
      }
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}
