// src/modules/server/routes/tools.ts
// GET   /api/tools         - 列出所有已加载工具的完整信息（含可编辑参数定义与当前生效值）
// PATCH /api/tools/:name  - 更新工具配置（enabled / config 段字段），写 config.tools[name]，触发热生效

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { ConfigService, ServiceRegistry } from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import type { ToolRegistry } from '../../contracts';
import { ErrorCode } from '../../../core/error-codes';
import { localizeDescription } from '../../tools/loader';
import { compareToolNames } from '../../tools/sort';
import type { ToolConfigManifest } from '../../tools/types';

/** 读取 config.json 中某工具的当前配置值（config 不可用时返回空对象） */
function readStoredToolConfig(config: ConfigService, name: string): Record<string, unknown> {
  try {
    const allTools = config.getAppConfig().tools as Record<string, Record<string, unknown>>;
    return allTools[name] ?? {};
  } catch {
    return {};
  }
}

/** 从工具的 configManifest 构建字段定义列表（排除 enabled；requireConfirmation 由通用行为区统一呈现） */
function buildConfigFields(manifest: ToolConfigManifest | undefined): Array<{
  key: string;
  type: 'boolean' | 'integer' | 'string';
  default: unknown;
  min?: number;
  max?: number;
}> {
  if (!manifest) return [];
  const fields: Array<{
    key: string;
    type: 'boolean' | 'integer' | 'string';
    default: unknown;
    min?: number;
    max?: number;
  }> = [];
  for (const [key, def] of Object.entries(manifest.defaults)) {
    if (key === 'enabled' || key === 'requireConfirmation') continue;
    const fieldSchema = manifest.schema?.[key];
    const type = fieldSchema?.type ?? inferType(def);
    fields.push({
      key,
      type,
      default: def,
      ...(fieldSchema?.min !== undefined ? { min: fieldSchema.min } : {}),
      ...(fieldSchema?.max !== undefined ? { max: fieldSchema.max } : {}),
    });
  }
  return fields;
}

/** 从默认值类型推断字段类型 */
function inferType(val: unknown): 'boolean' | 'integer' | 'string' {
  if (typeof val === 'boolean') return 'boolean';
  if (typeof val === 'number') return 'integer';
  return 'string';
}

/** GET /api/tools：返回所有已加载工具（含 disabled）的完整信息 */
export function createListToolsHandler(services: ServiceRegistry, config: ConfigService): RouteHandler {
  return async (): Promise<HttpResponse> => {
    const registry = services.tryResolve<ToolRegistry>(ServiceNames.TOOL_REGISTRY);
    if (!registry) {
      return { status: 200, body: { tools: [] } };
    }
    // 顺序：首字母分组（A→Z→a→z→0→9），组内长度升序，同长度按字符序（与发给模型的工具列表一致）
    const tools = registry.list().sort((a, b) => compareToolNames(a.name, b.name)).map((t) => {
      const stored = readStoredToolConfig(config, t.name);
      // 当前生效值 = defaults 深合并 config.json 覆盖值（config 优先）
      const configValues: Record<string, unknown> = { ...(t.configManifest?.defaults ?? {}) };
      for (const [k, v] of Object.entries(stored)) configValues[k] = v;
      return {
        name: t.name,
        description: localizeDescription(t),
        icon: t.icon,
        source: t.source ?? 'builtin',
        annotations: t.annotations,
        sourceDir: t.sourceDir,
        enabled: registry.isEnabled(t.name),
        configFields: buildConfigFields(t.configManifest),
        configValues,
      };
    });
    return { status: 200, body: { tools } };
  };
}

/**
 * PATCH /api/tools/:name：更新工具配置。
 * - body.config：任意已声明字段的子集（enabled / requireConfirmation / config 段字段）
 * - body.enabled：布尔（旧格式兼容，等价 config.enabled）
 */
export function createUpdateToolHandler(services: ServiceRegistry, config: ConfigService): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const name = params?.name;
    if (!name) {
      return { status: 400, body: { error: ErrorCode.TOOL_NAME_REQUIRED } };
    }
    const body = (req.body ?? {}) as {
      enabled?: boolean;
      config?: Record<string, unknown>;
    };

    // 合并旧格式 { enabled } 与新格式 { config: {...} }
    const patch: Record<string, unknown> = { ...(body.config ?? {}) };
    if (typeof body.enabled === 'boolean') {
      if (typeof patch.enabled === 'boolean' && patch.enabled !== body.enabled) {
        return {
          status: 400,
          body: { error: ErrorCode.TOOL_CONFIG_INVALID, message: 'Conflicting "enabled" values in body' },
        };
      }
      patch.enabled = body.enabled;
    }
    if (Object.keys(patch).length === 0) {
      return { status: 400, body: { error: ErrorCode.TOOL_ENABLED_REQUIRED } };
    }

    const registry = services.tryResolve<ToolRegistry>(ServiceNames.TOOL_REGISTRY);
    const tool = registry?.get(name);
    if (!registry || !tool) {
      return { status: 404, body: { error: ErrorCode.TOOL_NOT_FOUND } };
    }

    // 字段校验：shape 来自工具自身 configManifest（builtin/custom 统一），无声明时仅允许 enabled/requireConfirmation。
    // zod 校验器动态加载（仅 PATCH 路径触发，不进启动闭包）。
    if (tool.configManifest) {
      const { buildConfigShape, validateToolConfigPatch } = await import('../../../core/config-schema');
      const shape = buildConfigShape(tool.configManifest);
      const validation = validateToolConfigPatch(shape, patch);
      if (!validation.ok) {
        return { status: 400, body: { error: ErrorCode.TOOL_CONFIG_INVALID, message: validation.error } };
      }
    }

    try {
      // updateAppConfig 做 deep merge，仅需传 patch；写入后 registry 实时生效
      await config.updateAppConfig({
        tools: { [name]: patch },
      } as never);
      // 返回合并后的完整生效值（defaults + 存储值 + 本次 patch）
      const merged: Record<string, unknown> = { ...(tool.configManifest?.defaults ?? {}) };
      for (const [k, v] of Object.entries(readStoredToolConfig(config, name))) merged[k] = v;
      return { status: 200, body: { name, config: merged } };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}
