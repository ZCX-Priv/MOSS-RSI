// src/modules/rules/engine-core.test.ts
// 规则引擎核心逻辑单元测试：内容哈希、双作用域 CRUD、always/paths 编译合并、
// paths glob 匹配（直接用 bun:test 运行时内置的 Bun.Glob，不再 mock）。

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
  computeRuleId,
  globalRulesDir,
  projectRulesDir,
  listRules,
  upsertRule,
  deleteRule,
  getRule,
} from './storage';
import { loadCompiledRuleSet, invalidateRuleCache } from './loader';
import { buildRulesSection, matchPathRules } from './inject';
import type { Environment } from '../../core/types';
import type { ScopedRuleRecord } from './types';

describe('rules storage（哈希 JSON + 双作用域）', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'moss-rules-test-'));
    invalidateRuleCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    invalidateRuleCache();
  });

  test('computeRuleId：内容寻址确定性 + paths 顺序无关', () => {
    const base = { name: 'n', content: 'c', paths: ['a/**', 'b/**'] };
    expect(computeRuleId(base)).toBe(computeRuleId({ ...base }));
    expect(computeRuleId(base)).toBe(computeRuleId({ ...base, paths: ['b/**', 'a/**'] }));
    expect(computeRuleId(base)).not.toBe(computeRuleId({ ...base, content: 'changed' }));
    expect(computeRuleId(base)).toMatch(/^[0-9a-f]{16}$/);
  });

  test('upsertRule + listRules + getRule：落盘与枚举', () => {
    const rec = upsertRule(dir, {
      name: 'TypeScript 规范',
      description: 'TS 项目约定',
      content: '- 使用 strict 模式',
      paths: ['src/**/*.ts'],
    });
    expect(existsSync(join(dir, `${rec.id}.json`))).toBe(true);

    const list = listRules(dir, 'global');
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('TypeScript 规范');
    expect(list[0].paths).toEqual(['src/**/*.ts']);
    expect(list[0].enabled).toBe(true);

    const got = getRule(dir, rec.id, 'global');
    expect(got?.id).toBe(rec.id);
  });

  test('upsertRule 内容变更：旧哈希文件删除、新哈希文件写入（写新删旧）', () => {
    const old = upsertRule(dir, { name: 'n', content: 'v1', paths: [] });
    const updated = upsertRule(dir, { name: 'n', content: 'v2', paths: [] }, { oldId: old.id });
    expect(updated.id).not.toBe(old.id);
    expect(existsSync(join(dir, `${old.id}.json`))).toBe(false);
    expect(existsSync(join(dir, `${updated.id}.json`))).toBe(true);
    expect(listRules(dir, 'global')).toHaveLength(1);
  });

  test('deleteRule', () => {
    const rec = upsertRule(dir, { name: 'n', content: 'c', paths: [] });
    expect(deleteRule(dir, rec.id)).toBe(true);
    expect(deleteRule(dir, rec.id)).toBe(false);
    expect(listRules(dir, 'global')).toHaveLength(0);
  });

  test('禁用规则不进编译集（enabled=false 过滤）', () => {
    upsertRule(dir, { name: 'disabled-rule', content: 'c', paths: [], enabled: false });
    const list = listRules(dir, 'global');
    expect(list[0].enabled).toBe(false);
    // loader 过滤 disabled
    const env = { dataDir: dir } as Environment;
    const set = loadCompiledRuleSet(env, join(dir, 'nonexistent-project'));
    expect(set.alwaysRules).toHaveLength(0);
  });
});

describe('rules loader（双作用域合并编译）', () => {
  let globalDir: string;
  let projectDir: string;
  let projectCwd: string;

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), 'moss-rules-global-'));
    projectDir = mkdtempSync(join(tmpdir(), 'moss-rules-project-'));
    projectCwd = projectDir;
    // projectRulesDir = cwd/.moss/rules
    const rulesDir = join(projectDir, '.moss', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    invalidateRuleCache();
  });

  afterEach(() => {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    invalidateRuleCache();
  });

  test('always/paths 分类 + 项目级同名覆盖全局', () => {
    const gDir = join(globalDir, 'rules'); // loader 读 env.dataDir/rules
    upsertRule(gDir, { name: 'global-always', content: 'G-A', paths: [] });
    upsertRule(gDir, { name: 'shared-name', content: 'G-OLD', paths: [] });
    upsertRule(gDir, { name: 'global-paths', content: 'G-P', paths: ['docs/**'] });
    const pDir = join(projectCwd, '.moss', 'rules');
    upsertRule(pDir, { name: 'shared-name', content: 'P-NEW', paths: [] });
    upsertRule(pDir, { name: 'project-paths', content: 'P-P', paths: ['src/**'] });

    const env = { dataDir: globalDir } as Environment;
    const set = loadCompiledRuleSet(env, projectCwd);

    // 项目级 shared-name 覆盖全局（同名只保留项目级）
    expect(set.alwaysRules).toHaveLength(2);
    const shared = set.alwaysRules.find(r => r.name === 'shared-name');
    expect(shared?.content).toBe('P-NEW');
    expect(shared?.scope).toBe('project');
    expect(set.alwaysRules.find(r => r.name === 'global-always')?.scope).toBe('global');

    expect(set.pathRules).toHaveLength(2);
    expect(set.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  test('缓存：集合未变时返回同一对象（引用相等）', () => {
    const env = { dataDir: globalDir } as Environment;
    const s1 = loadCompiledRuleSet(env, projectCwd);
    const s2 = loadCompiledRuleSet(env, projectCwd);
    expect(s1).toBe(s2);

    upsertRule(join(projectCwd, '.moss', 'rules'), { name: 'new', content: 'x', paths: [] });
    const s3 = loadCompiledRuleSet(env, projectCwd);
    expect(s3).not.toBe(s1);
  });
});

describe('buildRulesSection（always 段文本）', () => {
  test('无规则返回 null；有规则生成带标题的段落', () => {
    expect(buildRulesSection([])).toBeNull();
    const text = buildRulesSection([
      {
        id: 'a', name: 'R1', description: 'd1', content: 'BODY-1', paths: [], enabled: true,
        priority: 0, createdAt: '', updatedAt: '', scope: 'global',
      },
      {
        id: 'b', name: 'R2', description: '', content: 'BODY-2', paths: [], enabled: true,
        priority: 0, createdAt: '', updatedAt: '', scope: 'project',
      },
    ]);
    expect(text).toContain('# 用户规则');
    expect(text).toContain('## R1（d1）');
    expect(text).toContain('BODY-1');
    expect(text).toContain('## R2');
    expect(text).toContain('BODY-2');
  });
});

describe('matchPathRules（paths glob 匹配：相对/绝对双口径）', () => {
  const mkRule = (name: string, paths: string[]): ScopedRuleRecord => ({
    id: name, name, description: '', content: '', paths, enabled: true,
    priority: 0, createdAt: '', updatedAt: '', scope: 'project',
  });

  test('相对路径命中 ** 递归模式', () => {
    const rules = [mkRule('ts', ['src/**/*.ts'])];
    expect(matchPathRules(rules, 'src/a/b.ts', 'C:/proj')).toHaveLength(1);
    expect(matchPathRules(rules, 'src/top.ts', 'C:/proj')).toHaveLength(1);
    expect(matchPathRules(rules, 'lib/x.ts', 'C:/proj')).toHaveLength(0);
    expect(matchPathRules(rules, 'src/a/b.tsx', 'C:/proj')).toHaveLength(0);
  });

  test('绝对路径输入（resolve 后转相对再匹配）', () => {
    const rules = [mkRule('ts', ['src/**/*.ts'])];
    const abs = join('C:', sep, 'proj', 'src', 'x.ts');
    expect(matchPathRules(rules, abs, join('C:', sep, 'proj'))).toHaveLength(1);
  });

  test('多模式任一命中即匹配；多规则各命中各的', () => {
    const rules = [
      mkRule('r1', ['**/*.test.ts', '**/*.spec.ts']),
      mkRule('r2', ['docs/**']),
    ];
    const hits1 = matchPathRules(rules, 'src/a.test.ts', 'C:/p');
    expect(hits1.map(h => h.name)).toEqual(['r1']);
    const hits2 = matchPathRules(rules, 'docs/readme.md', 'C:/p');
    expect(hits2.map(h => h.name)).toEqual(['r2']);
    expect(matchPathRules(rules, 'src/main.ts', 'C:/p')).toHaveLength(0);
  });
});

describe('作用域目录解析', () => {
  test('globalRulesDir / projectRulesDir 路径约定', () => {
    const env = { dataDir: 'C:/moss-data' } as Environment;
    expect(globalRulesDir(env)).toBe(join('C:/moss-data', 'rules'));
    expect(projectRulesDir('C:/proj')).toBe(join('C:/proj', '.moss', 'rules'));
  });
});
