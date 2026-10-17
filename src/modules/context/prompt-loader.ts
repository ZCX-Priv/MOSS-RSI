// src/modules/context/prompt-loader.ts
// 上下文引擎提示词文件加载：所有 LLM 提示词外部化为 agent/prompts/ 下的 md 文件。
// 加载顺序：~/.moss/agent/prompts/<relative>（用户可改）→ 包内种子源 → 内置兜底文本。
// ensureContextPrompts：为已初始化用户补充播种 compact/ 与 heal/ 目录（幂等，不覆盖用户修改）。

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Environment } from '../../core/types';

/** 剥离 UTF-8 BOM（避免 \uFEFF 混入提示词） */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 加载提示词文件（缺失或为空时返回 null）。
 * 查找顺序：用户目录 → 包内种子源；均缺失/为空时返回 null，由调用方决定降级行为。
 * @param env 环境信息
 * @param relativePath 相对 ~/.moss/agent/prompts/ 的路径（如 'compact/compaction.md'）
 */
export function loadPromptFileOrNull(env: Environment, relativePath: string): string | null {
  // 1. 用户目录（~/.moss/agent/prompts/...）
  const userFile = join(env.dataDir, 'agent', 'prompts', relativePath);
  try {
    if (existsSync(userFile)) {
      const text = readFileSync(userFile, 'utf8');
      if (text.trim() !== '') return stripBom(text);
    }
  } catch {
    // 读取失败落回种子源
  }

  // 2. 包内种子源（<packageRoot>/agent/prompts/...）
  const pkgFile = join(env.packageRoot, 'agent', 'prompts', relativePath);
  try {
    if (existsSync(pkgFile)) {
      const text = readFileSync(pkgFile, 'utf8');
      if (text.trim() !== '') return stripBom(text);
    }
  } catch {
    // 落回兜底
  }

  return null;
}

/**
 * 加载提示词文件（缺失时返回兜底文本，默认空串）。
 * @param env 环境信息
 * @param relativePath 相对 ~/.moss/agent/prompts/ 的路径（如 'compact/compaction.md'）
 * @param fallback 兜底文本（用户文件与包内种子均缺失时使用；默认空串）
 */
export function loadPromptFile(env: Environment, relativePath: string, fallback = ''): string {
  return loadPromptFileOrNull(env, relativePath) ?? fallback;
}

/**
 * 补充播种上下文引擎提示词（compact/ 与 heal/）：
 * seedBuiltinAgentPrompts 只在 ~/.moss/agent 不存在时整体复制，
 * 已初始化用户需要按文件级幂等补充（目标已存在则跳过，不覆盖用户修改）。
 * main/ 下的系统提示词由 seedBuiltinAgentPrompts 的指纹同步统一维护，此处不再重复播种。
 */
export function ensureContextPrompts(env: Environment): void {
  const relatives = [
    'compact/compaction.md',
    'heal/tool-error.md',
  ];
  for (const rel of relatives) {
    const dest = join(env.dataDir, 'agent', 'prompts', rel);
    if (existsSync(dest)) continue;
    const src = join(env.packageRoot, 'agent', 'prompts', rel);
    try {
      if (!existsSync(src)) continue;
      mkdirSync(join(dest, '..'), { recursive: true });
      copyFileSync(src, dest);
    } catch {
      // 播种失败不阻断：loadPromptFile 会走包内源或兜底
    }
  }
}

/** 替换模板变量 {{VAR}}（未识别的占位符原样保留） */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}
