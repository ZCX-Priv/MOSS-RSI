// src/modules/rules/inject.ts
// 规则注入内容生成与 paths 匹配：
// - buildRulesSection：always 规则编译为系统提示段文本
// - matchPathRules：文件路径 glob 匹配（复用 Bun.Glob，与 glob 工具同源）
// - buildRuleInjectionMessage：paths 规则触发时的会话锚定消息

import { Glob } from 'bun';
import { isAbsolute, relative, sep } from 'node:path';
import type { Environment } from '../../core/types';
import { loadPromptFileOrNull, renderTemplate } from '../context/prompt-loader';
import type { ScopedRuleRecord } from './types';

/** active-rules 锚定消息 name 标识（view-builder 恒保留锚定） */
export const ACTIVE_RULES_MSG_NAME = 'active-rules';

/** 规则段标题（WebUI 系统标签页展示） */
export const USER_RULES_SECTION_ID = 'user-rules';

/** always 规则段文本（模板缺失或无规则返回 null——不注入空段） */
export function buildRulesSection(env: Environment, alwaysRules: readonly ScopedRuleRecord[]): string | null {
  if (alwaysRules.length === 0) return null;
  const template = loadPromptFileOrNull(env, 'rules/section.md');
  if (!template) return null;
  const parts = alwaysRules.map(r => {
    const header = r.description ? `## ${r.name}（${r.description}）` : `## ${r.name}`;
    return `${header}\n\n${r.content.trim()}`;
  });
  return renderTemplate(template, { RULES: parts.join('\n\n') }).trimEnd();
}

/** 路径归一化：统一 / 分隔符 */
function normalizePath(p: string): string {
  return p.split(sep).join('/').replace(/\/+/g, '/');
}

/**
 * 匹配文件路径命中的 paths 规则。
 * 匹配口径：规则 glob 匹配「相对 cwd 的路径」或「绝对路径」（两者任一命中即算）。
 */
export function matchPathRules(
  pathRules: readonly ScopedRuleRecord[],
  filePath: string,
  cwd: string,
): ScopedRuleRecord[] {
  const abs = isAbsolute(filePath) ? filePath : `${cwd}${sep}${filePath}`;
  const rel = normalizePath(relative(cwd, abs));
  const absNorm = normalizePath(abs);

  const hits: ScopedRuleRecord[] = [];
  for (const rule of pathRules) {
    for (const pattern of rule.paths) {
      const pat = normalizePath(pattern);
      let matched = false;
      try {
        const g = new Glob(pat);
        matched = g.match(rel) || g.match(absNorm);
      } catch {
        // 无效 glob 跳过该模式
      }
      if (matched) {
        hits.push(rule);
        break;
      }
    }
  }
  return hits;
}

/** paths 规则触发的会话锚定消息内容 */
export function buildRuleInjectionMessage(rule: ScopedRuleRecord): string {
  const scope = rule.scope === 'project' ? '项目规则' : '全局规则';
  return `[${scope} | ${rule.name}]\n\n${rule.content.trim()}\n\n（此规则因当前任务触及的文件（${rule.paths.join(', ')}）而自动注入，请遵守。）`;
}
