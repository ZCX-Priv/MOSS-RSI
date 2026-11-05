// src/modules/tools/manifest.ts
// 工具配置规格数据源（不含 zod）。
//
// 启动性能关键路径：
// - 生产构建会在 dist/modules/tools/_config-manifest.json 预生成一份合并清单，
//   启动只读这一个 JSON，不再逐个目录 readdir/stat/read；
// - 开发态（源码运行）没有预生成清单时回退扫描，仅开发模式承担该成本；
// - 扫描/读取结果进程内缓存，重复调用零开销。
//
// zod schema 构建已移到 src/core/config-schema.ts（只在配置校验时动态加载），
// 避免把 729KB 的 zod 拉进启动闭包。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolConfigManifest } from './types';

/** 预生成清单文件名 */
const CONFIG_MANIFEST_FILE = '_config-manifest.json';

interface PrebuiltToolConfigEntry {
  name: string;
  config?: ToolConfigManifest;
}

interface PrebuiltConfigManifest {
  version?: number;
  tools?: PrebuiltToolConfigEntry[];
}

/** toolName → config 段（缺失 config 的工具也收录，defaults 为空） */
let cachedConfigs: Map<string, ToolConfigManifest | undefined> | null = null;

/**
 * 探测内置工具目录。
 * 候选路径（顺序不可颠倒）：
 *   - import.meta.dir/modules/tools（生产模式：main.js 在 dist/，tools 目录复制到 dist/modules/tools）
 *   - import.meta.dir                （开发模式：本文件在 src/modules/tools/）
 */
function resolveBuiltinConfigDir(): string | null {
  const candidates = [join(import.meta.dir, 'modules', 'tools'), join(import.meta.dir)];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** 读取预生成清单（不存在/损坏返回 null，由调用方回退扫描） */
function readPrebuiltManifest(dir: string): Map<string, ToolConfigManifest | undefined> | null {
  const file = join(dir, CONFIG_MANIFEST_FILE);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as PrebuiltConfigManifest;
    if (!Array.isArray(raw.tools)) return null;
    const result = new Map<string, ToolConfigManifest | undefined>();
    for (const entry of raw.tools) {
      if (!entry || typeof entry.name !== 'string') continue;
      result.set(entry.name, entry.config);
    }
    return result;
  } catch {
    return null;
  }
}

/** 开发态回退：扫描目录读取 tool.json（结果仅内存使用） */
function scanToolConfigs(dir: string): Map<string, ToolConfigManifest | undefined> {
  const result = new Map<string, ToolConfigManifest | undefined>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifestPath = join(full, 'tool.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: string;
        config?: ToolConfigManifest;
      };
      if (!manifest.name) continue;
      result.set(manifest.name, manifest.config);
    } catch {
      // 无效 tool.json 跳过（工具加载器会单独告警）
    }
  }
  return result;
}

/** 读取全部内置工具的 config 段（进程内缓存；生产只读一个预生成 JSON） */
export function loadToolConfigs(): Map<string, ToolConfigManifest | undefined> {
  if (cachedConfigs) return cachedConfigs;
  const dir = resolveBuiltinConfigDir();
  if (!dir) {
    cachedConfigs = new Map();
    return cachedConfigs;
  }
  cachedConfigs = readPrebuiltManifest(dir) ?? scanToolConfigs(dir);
  return cachedConfigs;
}

/** 构建 tools 默认值（defaultAppConfig / loadDefaults 使用） */
export function buildToolsDefaults(): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, config] of loadToolConfigs()) {
    result[name] = config?.defaults ? { ...config.defaults } : {};
  }
  return result;
}

/** 内置工具名集合（区分内置与自定义工具，防止自定义覆盖内置） */
export function builtinToolNames(): Set<string> {
  return new Set(loadToolConfigs().keys());
}

/** 供 config-schema 构建 zod 校验用：工具 config 规格 */
export function toolConfigEntries(): Array<{ name: string; config?: ToolConfigManifest }> {
  return Array.from(loadToolConfigs().entries()).map(([name, config]) => ({ name, config }));
}
