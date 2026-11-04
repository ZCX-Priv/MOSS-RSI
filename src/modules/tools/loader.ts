// src/modules/tools/loader.ts
// 统一工具加载器：从目录加载「tool.json + index.ts」结构的工具。
// 内置工具与自定义工具共用此加载器，仅目录来源不同。
// 支持两种 index.ts 导出形式：
//   - 静态：export default { execute: async (params, ctx) => {...} }
//   - 工厂：export default function createExecute(env) { return { execute: ... } }

import { t, getBackendLocale } from '../../core/i18n';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Environment, Logger } from '../../core/types';
import type { Tool, ToolAnnotations, JSONSchema, ToolConfigManifest } from './types';

// 类型定义已迁移至 types.ts，此处 re-export 保持兼容
export type { ToolConfigManifest } from './types';

/** tool.json 的完整结构 */
export interface ToolManifest {
  name: string;
  description: string;
  /** 英文描述（可选；en locale 时替代 description） */
  description_en?: string;
  icon?: string;
  annotations?: ToolAnnotations;
  inputSchema: JSONSchema;
  config?: ToolConfigManifest;
}

/** index.ts 默认导出的两种形式 */
interface ToolExecuteImpl {
  execute: Tool['execute'];
}
type ToolExport = ToolExecuteImpl | ((env: Environment) => ToolExecuteImpl);

/** 读取并校验 tool.json（失败返回 null 并记录日志） */
function readToolManifest(dir: string, logger: Logger): ToolManifest | null {
  const manifestPath = join(dir, 'tool.json');
  if (!existsSync(manifestPath)) {
    logger.warn(t('tools.skipNoManifest', { dir }));
    return null;
  }
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as ToolManifest;
    if (!isValidManifest(manifest)) {
      logger.warn(t('tools.skipMissingFields', { dir }));
      return null;
    }
    return manifest;
  } catch (err) {
    logger.warn(t('tools.skipInvalidManifest', { dir }), {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** 由 manifest + 执行函数组装 Tool（注入 sourceDir/source） */
function buildTool(
  manifest: ToolManifest,
  dir: string,
  source: 'builtin' | 'custom',
  execute: Tool['execute'],
): Tool {
  return {
    name: manifest.name,
    description: manifest.description,
    descriptionEn: manifest.description_en,
    inputSchema: manifest.inputSchema,
    annotations: manifest.annotations,
    icon: manifest.icon,
    configManifest: manifest.config,
    execute,
    sourceDir: dir,
    source,
  };
}

/**
 * 从单个目录加载工具（tool.json + index.ts）。
 * 失败返回 null 并记录日志（错误隔离）。
 * @param dir 工具目录绝对路径
 * @param env 运行环境（工厂模式工具需要）
 * @param logger 日志
 * @param source 来源标记
 */
export async function loadToolFromDir(
  dir: string,
  env: Environment,
  logger: Logger,
  source: 'builtin' | 'custom',
): Promise<Tool | null> {
  const indexPath = join(dir, 'index.ts');

  // 1. 读取并校验 tool.json
  const manifest = readToolManifest(dir, logger);
  if (!manifest) return null;

  // 2. 动态 import index.ts
  let mod: { default?: ToolExport };
  try {
    mod = await import(indexPath);
  } catch (err) {
    logger.warn(t('tools.skipImportFailed', { dir }), {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const exported = mod.default;
  if (!exported) {
    logger.warn(t('tools.skipNoDefaultExport', { dir }));
    return null;
  }

  // 3. 解析导出形式（静态对象 or 工厂函数）
  let impl: ToolExecuteImpl;
  try {
    if (typeof exported === 'function') {
      impl = (exported as (env: Environment) => ToolExecuteImpl)(env);
    } else if (exported && typeof exported === 'object') {
      impl = exported as ToolExecuteImpl;
    } else {
      logger.warn(t('tools.skipInvalidExport', { dir }));
      return null;
    }
  } catch (err) {
    logger.warn(t('tools.factoryFailed', { dir }), {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!impl || typeof impl.execute !== 'function') {
    logger.warn(t('tools.skipNoExecute', { dir }));
    return null;
  }

  // 4. 合并 tool.json 静态字段 + index.ts 的 execute，注入 sourceDir/source
  // bind(impl)：保留 this 绑定，防止工具实现采用对象方法模式时 this 丢失
  return buildTool(manifest, dir, source, impl.execute.bind(impl));
}

/** 单个工具实现的惰性加载器（首次 execute 时才 import index.ts，之后复用） */
function createLazyImplLoader(
  dir: string,
  env: Environment,
  logger: Logger,
): () => Promise<ToolExecuteImpl> {
  const indexPath = join(dir, 'index.ts');
  let promise: Promise<ToolExecuteImpl> | null = null;
  return () => {
    if (promise) return promise;
    promise = import(indexPath)
      .then((mod: { default?: ToolExport }) => {
        const exported = mod.default;
        if (!exported) throw new Error(t('tools.skipNoDefaultExport', { dir }));
        if (typeof exported === 'function') {
          return (exported as (env: Environment) => ToolExecuteImpl)(env);
        }
        if (exported && typeof exported === 'object') {
          return exported as ToolExecuteImpl;
        }
        throw new Error(t('tools.skipInvalidExport', { dir }));
      })
      .catch((err: unknown) => {
        // 失败不缓存：下次调用可重试（与热重载语义一致）
        promise = null;
        logger.warn(t('tools.skipImportFailed', { dir }), {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      });
    return promise;
  };
}

/**
 * 启动期工具描述符加载（启动性能关键路径）：
 * 只读 tool.json（小文件），不 import index.ts；execute 首次调用时才动态加载实现。
 * 这样 20 个工具（含 pdf/office/sharp/tree-sitter 等重依赖）不会阻塞内核启动，
 * 也避免把事件循环堵住导致 server/context/remote 等模块激活延迟。
 */
export async function loadToolDescriptorsFromDir(
  dir: string,
  env: Environment,
  logger: Logger,
  source: 'builtin' | 'custom',
): Promise<Tool[]> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const toolDirs: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(join(full, 'tool.json'))) continue;
    toolDirs.push(full);
  }
  toolDirs.sort();

  const loaded = toolDirs.map((full) => {
    const manifest = readToolManifest(full, logger);
    if (!manifest) return null;
    const getImpl = createLazyImplLoader(full, env, logger);
    return buildTool(manifest, full, source, async (params, ctx) => {
      const impl = await getImpl();
      if (typeof impl.execute !== 'function') {
        throw new Error(t('tools.skipNoExecute', { dir: full }));
      }
      return impl.execute(params, ctx);
    });
  });
  return loaded.filter((tool): tool is Tool => tool !== null);
}

// ============================================================================
// 工具文本 locale 解析（description / inputSchema 的双语字段）
// ============================================================================

/**
 * 按当前后端 locale 解析工具描述：en 且存在 descriptionEn 时返回英文，否则中文默认。
 * 每次调用 live 读取 locale（config 变更后下一次 run/请求即生效）。
 */
export function localizeDescription(tool: Pick<Tool, 'description' | 'descriptionEn'>): string {
  return getBackendLocale() === 'en' && tool.descriptionEn ? tool.descriptionEn : tool.description;
}

/** 递归复制 schema 节点：en locale 用 description_en 替换 description，并剥离 description_en 自定义字段 */
function localizeValue(value: unknown, useEn: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => localizeValue(v, useEn));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = localizeValue(v, useEn);
    }
    const en = out.description_en;
    if (typeof en === 'string' && useEn) {
      out.description = en;
    }
    delete out.description_en;
    return out;
  }
  return value;
}

/**
 * 按当前后端 locale 解析 inputSchema：返回新对象（不污染原始 manifest），
 * 无论 locale 都剥离 description_en 键（保证发给 LLM 的 schema 无自定义字段）。
 */
export function localizeSchema(schema: JSONSchema): JSONSchema {
  return localizeValue(schema, getBackendLocale() === 'en') as JSONSchema;
}

/**
 * 批量加载目录下所有工具（每个子目录一个工具）。
 * 错误隔离：单个工具加载失败不影响其他（loadToolFromDir 内部 catch 返回 null）。
 * 无 tool.json 的子目录（如 shared/ 共享模块）静默跳过。
 * 动态 import 并行执行（启动性能：串行 await 会让 Bun 逐个编译 TS 明显拖慢启动）；
 * 返回顺序按目录名排序稳定（与串行版 readdirSync 顺序一致）。
 */
export async function loadToolsFromDir(
  dir: string,
  env: Environment,
  logger: Logger,
  source: 'builtin' | 'custom',
): Promise<Tool[]> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const toolDirs: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    // 非工具目录（无 tool.json），静默跳过
    if (!existsSync(join(full, 'tool.json'))) continue;
    toolDirs.push(full);
  }
  toolDirs.sort();

  const loaded = await Promise.all(
    toolDirs.map((full) =>
      loadToolFromDir(full, env, logger, source).catch((err: unknown) => {
        logger.warn(t('tools.skipImportFailed', { dir: full }), {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }),
    ),
  );
  return loaded.filter((tool): tool is Tool => tool !== null);
}

/**
 * 探测内置工具目录：优先 src/modules/tools，回退 dist/modules/tools。
 * 双路径扫描（src 优先，dist 回退）。
 */
export function resolveBuiltinDir(env: Environment): string | null {
  const candidates = [
    join(env.packageRoot, 'src', 'modules', 'tools'),
    join(env.packageRoot, 'dist', 'modules', 'tools'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** 校验 tool.json 必填字段 */
function isValidManifest(obj: unknown): obj is ToolManifest {
  if (!obj || typeof obj !== 'object') return false;
  const m = obj as Record<string, unknown>;
  return (
    typeof m.name === 'string' &&
    typeof m.description === 'string' &&
    typeof m.inputSchema === 'object' &&
    m.inputSchema !== null
  );
}
