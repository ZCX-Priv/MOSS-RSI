// src/modules/rules/storage.ts
// 规则哈希 JSON 存储：每条规则一个 {hash}.json 文件。
// 作用域目录：全局 ~/.moss/rules/、项目级 {cwd}/.moss/rules/。
// 内容寻址：id = sha256(name+content+paths) 前 16 位——编辑内容即换新文件（写新删旧）。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Environment } from '../../core/types';
import type { RuleRecord, RuleScope, RuleUpsertInput, ScopedRuleRecord } from './types';

/** 计算规则内容哈希（sha256 前 16 位 hex） */
export function computeRuleId(input: { name: string; content: string; paths: string[] }): string {
  const canonical = JSON.stringify({
    name: input.name,
    content: input.content,
    paths: [...input.paths].sort(),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

/** 全局规则目录 */
export function globalRulesDir(env: Environment): string {
  return join(env.dataDir, 'rules');
}

/** 项目级规则目录 */
export function projectRulesDir(cwd: string): string {
  return join(cwd, '.moss', 'rules');
}

/** 确保目录存在 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** 单文件解析（无效文件跳过返回 null） */
function readRuleFile(file: string, scope: RuleScope): ScopedRuleRecord | null {
  try {
    const raw = readFileSync(file, 'utf8');
    const rec = JSON.parse(raw) as Partial<RuleRecord>;
    if (
      typeof rec.id !== 'string' ||
      typeof rec.name !== 'string' ||
      typeof rec.content !== 'string'
    ) {
      return null;
    }
    return {
      id: rec.id,
      name: rec.name,
      description: rec.description ?? '',
      content: rec.content,
      paths: Array.isArray(rec.paths) ? rec.paths.filter((p): p is string => typeof p === 'string') : [],
      enabled: rec.enabled !== false,
      priority: typeof rec.priority === 'number' ? rec.priority : 0,
      createdAt: rec.createdAt ?? new Date().toISOString(),
      updatedAt: rec.updatedAt ?? new Date().toISOString(),
      scope,
    };
  } catch {
    return null;
  }
}

/** 列出某作用域全部规则 */
export function listRules(dir: string, scope: RuleScope): ScopedRuleRecord[] {
  if (!existsSync(dir)) return [];
  const out: ScopedRuleRecord[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const rec = readRuleFile(join(dir, entry), scope);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 按 id 读取（在指定作用域目录中查找） */
export function getRule(dir: string, id: string, scope: RuleScope): ScopedRuleRecord | null {
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return null;
  return readRuleFile(file, scope);
}

/**
 * 写入规则（内容寻址：新哈希写新文件；旧 id 不同则删除旧文件）。
 * @returns 写入后的记录
 */
export function upsertRule(
  dir: string,
  input: RuleUpsertInput,
  opts?: { oldId?: string },
): RuleRecord {
  ensureDir(dir);
  const now = new Date().toISOString();
  const paths = (input.paths ?? []).filter((p): p is string => typeof p === 'string' && p.trim() !== '');

  // 保留旧记录的 createdAt（编辑场景）
  let createdAt = now;
  if (opts?.oldId) {
    const old = readRuleFile(join(dir, `${opts.oldId}.json`), 'global');
    if (old) createdAt = old.createdAt;
  }

  const record: RuleRecord = {
    id: computeRuleId({ name: input.name, content: input.content, paths }),
    name: input.name,
    description: input.description ?? '',
    content: input.content,
    paths,
    enabled: input.enabled !== false,
    priority: input.priority ?? 0,
    createdAt,
    updatedAt: now,
  };

  writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record, null, 2), 'utf8');

  // 内容变化 → 删除旧哈希文件
  if (opts?.oldId && opts.oldId !== record.id) {
    const oldFile = join(dir, `${opts.oldId}.json`);
    if (existsSync(oldFile)) {
      try {
        rmSync(oldFile);
      } catch {
        // 删除失败不阻塞（残留文件下次可手动清理）
      }
    }
  }
  return record;
}

/** 清空某作用域目录下全部规则文件（保留目录）。返回删除条数。 */
export function clearRules(dir: string): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      rmSync(join(dir, entry));
      removed++;
    } catch {
      // 单文件删除失败：跳过，不阻断其余清理
    }
  }
  return removed;
}

/** 删除规则（按 id） */
export function deleteRule(dir: string, id: string): boolean {
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return false;
  try {
    rmSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在两个作用域目录中按 id 查找规则（全局优先返回带 scope 标注的记录）。
 * @returns 找到则删除并返回 true
 */
export function deleteRuleAnywhere(env: Environment, cwd: string, id: string): boolean {
  const projectDir = projectRulesDir(cwd);
  if (deleteRule(projectDir, id)) return true;
  return deleteRule(globalRulesDir(env), id);
}

/** 在两个作用域目录中按 id 读取规则 */
export function getRuleAnywhere(
  env: Environment,
  cwd: string,
  id: string,
): ScopedRuleRecord | null {
  const project = getRule(projectRulesDir(cwd), id, 'project');
  if (project) return project;
  return getRule(globalRulesDir(env), id, 'global');
}
