// src/modules/server/routes/safety.ts
// 项目级权限规则：{cwd}/.moss/permissions.json 的读写。
// GET  /api/safety/project-rules?cwd=...  —— 读取某项目目录的权限规则
// PUT  /api/safety/project-rules          —— 整体写入（body: { cwd, rules }）

import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { RouteHandler } from '../types';
import type { ServiceRegistry } from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import type { SafetyRules, SafetyService } from '../../contracts';

/** 规则条数与长度上限（防止项目规则文件被写爆） */
const MAX_RULES_PER_LIST = 200;
const MAX_RULE_LENGTH = 500;

/** 校验 cwd：必须是绝对路径且为已存在目录 */
function validateCwd(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) return null;
  try {
    return statSync(value).isDirectory() ? value : null;
  } catch {
    return null;
  }
}

/** 校验并归一化规则表（非字符串丢弃、去重、限制长度） */
function normalizeRules(raw: unknown): SafetyRules | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const out: SafetyRules = { allow: [], deny: [], ask: [] };
  for (const key of ['allow', 'deny', 'ask'] as const) {
    const value = obj[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) return null;
    const rules = value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    if (rules.length > MAX_RULES_PER_LIST || rules.some((item) => item.length > MAX_RULE_LENGTH)) {
      return null;
    }
    out[key] = [...new Set(rules)];
  }
  return out;
}

export function createGetProjectRulesHandler(services: ServiceRegistry): RouteHandler {
  return (req) => {
    const safety = services.tryResolve<SafetyService>(ServiceNames.SAFETY);
    if (!safety) {
      return { status: 503, body: { error: 'safety service unavailable' } };
    }
    const cwd = validateCwd(req.query.cwd);
    if (!cwd) {
      return { status: 400, body: { error: 'invalid cwd: absolute existing directory required' } };
    }
    return { status: 200, body: { cwd, rules: safety.listProjectRules(cwd) } };
  };
}

export function createUpdateProjectRulesHandler(services: ServiceRegistry): RouteHandler {
  return async (req) => {
    const safety = services.tryResolve<SafetyService>(ServiceNames.SAFETY);
    if (!safety) {
      return { status: 503, body: { error: 'safety service unavailable' } };
    }
    const body = (req.body ?? {}) as { cwd?: unknown; rules?: unknown };
    const cwd = validateCwd(body.cwd);
    if (!cwd) {
      return { status: 400, body: { error: 'invalid cwd: absolute existing directory required' } };
    }
    const rules = normalizeRules(body.rules);
    if (!rules) {
      return { status: 400, body: { error: 'invalid rules: string arrays required (max 200 items, 500 chars each)' } };
    }
    const ok = await safety.saveProjectRules(cwd, rules);
    if (!ok) {
      return { status: 500, body: { error: 'failed to save project rules' } };
    }
    return { status: 200, body: { ok: true, cwd, rules } };
  };
}
