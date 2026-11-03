// src/modules/rules/loader.ts
// 双作用域规则加载与合并：全局 ~/.moss/rules/ + 项目级 {cwd}/.moss/rules/。
// 合并策略：项目级按 name 覆盖全局（同名时项目级胜出）；结果编译为
// CompiledRuleSet（alwaysRules / pathRules）+ 内容指纹（缓存键）。
// mtime 指纹缓存：目录未变不重复读盘。

import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Environment } from '../../core/types';
import { globalRulesDir, listRules, projectRulesDir } from './storage';
import type { CompiledRuleSet, ScopedRuleRecord } from './types';

interface LoaderCacheEntry {
  key: string;
  /** 目录 + 文件清单签名（名字/mtime/size；同毫秒内新增文件也能失效） */
  mtime: string;
  set: CompiledRuleSet;
}

let cache: LoaderCacheEntry | null = null;

/** 目录树签名（目录 mtime + 顶层 .json 文件名/mtime/size；变更即缓存失效） */
function rulesDirMtime(dir: string): string {
  try {
    const dirMtime = statSync(dir).mtimeMs;
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const st = statSync(join(dir, entry));
        files.push(`${entry}:${st.mtimeMs}:${st.size}`);
      } catch {
        // 单文件失败忽略
      }
    }
    // 文件清单参与签名：同一毫秒内创建的新规则文件名变化，仍会使缓存失效
    return `${dirMtime}|${files.sort().join('|')}`;
  } catch {
    return '-1';
  }
}

/**
 * 加载并编译规则集合（双作用域合并，带 mtime 缓存）。
 * @param env 环境（全局目录）
 * @param cwd 当前工作目录（项目级目录）
 */
export function loadCompiledRuleSet(env: Environment, cwd: string): CompiledRuleSet {
  const globalDir = globalRulesDir(env);
  const projectDir = projectRulesDir(cwd);
  const key = `${globalDir}::${projectDir}`;
  const mtime = rulesDirMtime(globalDir) + rulesDirMtime(projectDir);

  if (cache && cache.key === key && cache.mtime === mtime) {
    return cache.set;
  }

  const globalRules = listRules(globalDir, 'global').filter(r => r.enabled);
  const projectRules = listRules(projectDir, 'project').filter(r => r.enabled);

  // 项目级按 name 覆盖全局（项目级 +100 基础优先级）
  const projectNames = new Set(projectRules.map(r => r.name));
  const merged: ScopedRuleRecord[] = [
    ...globalRules.filter(r => !projectNames.has(r.name)),
    ...projectRules,
  ];

  const alwaysRules = merged.filter(r => r.paths.length === 0);
  const pathRules = merged.filter(r => r.paths.length > 0);

  // 内容指纹：规则集的确定性摘要（缓存键；任何变更即失效）
  const fingerprint = createHash('sha256')
    .update(
      merged
        .map(r => `${r.id}:${r.name}:${r.priority}:${r.scope}`)
        .sort()
        .join('|'),
    )
    .digest('hex')
    .slice(0, 16);

  const set: CompiledRuleSet = { alwaysRules, pathRules, fingerprint };
  cache = { key, mtime, set };
  return set;
}

/** 使加载缓存失效（规则写盘后由 service 调用） */
export function invalidateRuleCache(): void {
  cache = null;
}
