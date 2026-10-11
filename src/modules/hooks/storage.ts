// src/modules/hooks/storage.ts
// 钩子哈希 JSON 存储：每个钩子一个 {hash}.json 文件 + scripts/ 脚本目录。
// 作用域目录：全局 ~/.moss/hooks/（scripts/ 放 TS 模块）、项目级 {cwd}/.moss/hooks/。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Environment } from '../../core/types';
import type { HookRecord, HookScope, HookUpsertInput, ScopedHookRecord } from './types';
import { HOOK_EVENTS } from './types';

/** 计算钩子内容哈希（sha256 前 16 位 hex） */
export function computeHookId(input: {
  name: string;
  event: string;
  matcher: string | null;
  type: string;
  command: string;
  modulePath: string;
}): string {
  const canonical = JSON.stringify({
    name: input.name,
    event: input.event,
    matcher: input.matcher,
    type: input.type,
    command: input.command,
    modulePath: input.modulePath,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

/** 全局钩子目录 */
export function globalHooksDir(env: Environment): string {
  return join(env.dataDir, 'hooks');
}

/** 项目级钩子目录 */
export function projectHooksDir(cwd: string): string {
  return join(cwd, '.moss', 'hooks');
}

/** 脚本目录（TS 模块钩子存放处） */
export function scriptsDir(dir: string): string {
  return join(dir, 'scripts');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** 单文件解析（无效文件跳过返回 null） */
function readHookFile(file: string, scope: HookScope): ScopedHookRecord | null {
  try {
    const raw = readFileSync(file, 'utf8');
    const rec = JSON.parse(raw) as Partial<HookRecord>;
    if (
      typeof rec.id !== 'string' ||
      typeof rec.name !== 'string' ||
      typeof rec.event !== 'string' ||
      !HOOK_EVENTS.includes(rec.event as HookRecord['event'])
    ) {
      return null;
    }
    return {
      id: rec.id,
      name: rec.name,
      event: rec.event as HookRecord['event'],
      matcher: typeof rec.matcher === 'string' && rec.matcher !== '' ? rec.matcher : null,
      type: rec.type === 'module' ? 'module' : 'terminal',
      command: rec.command ?? '',
      modulePath: rec.modulePath ?? '',
      timeout: typeof rec.timeout === 'number' ? rec.timeout : 0,
      enabled: rec.enabled !== false,
      createdAt: rec.createdAt ?? new Date().toISOString(),
      updatedAt: rec.updatedAt ?? new Date().toISOString(),
      scope,
    };
  } catch {
    return null;
  }
}

/** 列出某作用域全部钩子（scripts 子目录自动排除） */
export function listHooks(dir: string, scope: HookScope): ScopedHookRecord[] {
  if (!existsSync(dir)) return [];
  const out: ScopedHookRecord[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const rec = readHookFile(join(dir, entry), scope);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 按 id 读取 */
export function getHook(dir: string, id: string, scope: HookScope): ScopedHookRecord | null {
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return null;
  return readHookFile(file, scope);
}

/** 写入钩子（内容寻址；旧 id 不同则删除旧文件） */
export function upsertHook(
  dir: string,
  input: HookUpsertInput,
  opts?: { oldId?: string },
): HookRecord {
  ensureDir(dir);
  const now = new Date().toISOString();

  let createdAt = now;
  if (opts?.oldId) {
    const old = readHookFile(join(dir, `${opts.oldId}.json`), 'global');
    if (old) createdAt = old.createdAt;
  }

  const record: HookRecord = {
    id: computeHookId({
      name: input.name,
      event: input.event,
      matcher: input.matcher ?? null,
      type: input.type,
      command: input.command ?? '',
      modulePath: input.modulePath ?? '',
    }),
    name: input.name,
    event: input.event,
    matcher: input.matcher ?? null,
    type: input.type,
    command: input.command ?? '',
    modulePath: input.modulePath ?? '',
    timeout: input.timeout ?? 0,
    enabled: input.enabled !== false,
    createdAt,
    updatedAt: now,
  };

  writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record, null, 2), 'utf8');

  if (opts?.oldId && opts.oldId !== record.id) {
    const oldFile = join(dir, `${opts.oldId}.json`);
    if (existsSync(oldFile)) {
      try {
        rmSync(oldFile);
      } catch {
        // 删除失败不阻塞
      }
    }
  }
  return record;
}

/** 删除钩子 */
export function deleteHook(dir: string, id: string): boolean {
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return false;
  try {
    rmSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 双作用域按 id 删除 */
export function deleteHookAnywhere(env: Environment, cwd: string, id: string): boolean {
  if (deleteHook(projectHooksDir(cwd), id)) return true;
  return deleteHook(globalHooksDir(env), id);
}

/** 双作用域按 id 读取 */
export function getHookAnywhere(
  env: Environment,
  cwd: string,
  id: string,
): ScopedHookRecord | null {
  const project = getHook(projectHooksDir(cwd), id, 'project');
  if (project) return project;
  return getHook(globalHooksDir(env), id, 'global');
}

/** 列出 scripts/ 目录下的脚本文件名（模块钩子路径选择数据源） */
export function listScripts(dir: string): string[] {
  const sdir = scriptsDir(dir);
  if (!existsSync(sdir)) return [];
  try {
    return readdirSync(sdir).filter(f => f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.mjs'));
  } catch {
    return [];
  }
}

/** 写脚本文件（scripts/ 下；路径安全：禁止 .. 逃逸） */
export function writeScript(dir: string, filename: string, content: string): string {
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('invalid script filename');
  }
  const sdir = scriptsDir(dir);
  ensureDir(sdir);
  const file = join(sdir, filename);
  writeFileSync(file, content, 'utf8');
  return file;
}

/** 读脚本文件 */
export function readScript(dir: string, filename: string): string | null {
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return null;
  }
  const file = join(scriptsDir(dir), filename);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
