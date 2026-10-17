// src/modules/context/compiler/system-prompt.ts
// 静态系统提示组装（缓存对齐布局核心）：
// - 从 ~/.moss/agent/prompts/main/ 加载基本设定并按序拼接（soul → identity → 其他）
//   （rules 解析段已移除：rules.md 内容已并入 system.md，见 agent/prompts/main/）
// - 零动态变量替换：全部环境信息（平台/CWD/设备/编码/模型/解释器/工具链/时间）
//   统一由 env-context 消息承载 → system prompt 纯文本拼接，字节级稳定（前缀缓存锚点）
// - always 用户规则段（rules 引擎注入）插在末尾；规则集内容指纹纳入缓存键
// - mtime 缓存：文件未变不重复读盘；变更即进入新缓存周期
// 迁移自 agent/context.ts（loadBasePrompt/buildSystemPrompt），并输出分段结构
//（供 WebUI「系统」标签页折叠栏展示）。

import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type { Environment } from '../../../core/types';
import type { SystemSection } from '../types';
import { seedBuiltinAgentPrompts } from '../../tools/shared/agent-seed';
import { estimateTextTokens } from '../budgeter/estimator';

/** always 用户规则段（rules 引擎注入；规则集变更 = 新缓存周期，与 skill 切换同级） */
export interface RulesSectionInput {
  /** 规则集内容指纹（缓存键组成部分） */
  fingerprint: string;
  /** 段文本（无 always 规则时 null） */
  text: string | null;
}

/** 基本设定候选文件名（不含 .md），按拼接优先级排序；每个位置取第一个存在的文件 */
const BASE_PROMPT_CANDIDATES: ReadonlyArray<ReadonlyArray<string>> = [
  ['system', 'soul'],
  ['base', 'identity'],
];

const CANDIDATE_NAMES: ReadonlySet<string> = new Set<string>(BASE_PROMPT_CANDIDATES.flat());

/** 段落标题（WebUI 系统标签页折叠栏展示用） */
const SEGMENT_TITLES: Record<string, string> = {
  system: '系统设定',
  soul: '工作哲学（soul）',
  identity: '身份认知',
  'user-rules': '用户规则（user rules）',
};

/** 段落缓存条目：mtime + 规则指纹未变时免读盘 */
interface PromptCacheEntry {
  key: string;
  mtimeMs: number;
  rulesFingerprint: string;
  segments: SystemSection[];
  joined: string;
}

let promptCache: PromptCacheEntry | null = null;

function readFileNoBom(path: string): string {
  const raw = readFileSync(path, 'utf8');
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** 主提示词目录的 mtime 指纹（目录 + 候选文件；变更即缓存失效） */
function promptDirMtime(userDir: string): number {
  let max = 0;
  try {
    max = Math.max(max, statSync(userDir).mtimeMs);
  } catch {
    return -1;
  }
  for (const name of readdirSync(userDir)) {
    if (!name.endsWith('.md')) continue;
    try {
      max = Math.max(max, statSync(join(userDir, name)).mtimeMs);
    } catch {
      // 单文件失败忽略
    }
  }
  return max;
}

/**
 * 加载系统提示词分段（带 mtime + 规则指纹缓存）。
 * 顺序：system/soul → identity → 其他 *.md（字母序）→ 用户规则。
 * @param rulesSection rules 引擎注入的 always 规则段（可选）
 */
export function loadSystemPromptSegments(env: Environment, rulesSection?: RulesSectionInput | null): SystemSection[] {
  seedBuiltinAgentPrompts(env);
  const userDir = join(env.dataDir, 'agent', 'prompts', 'main');
  const cacheKey = userDir;
  const mtime = promptDirMtime(userDir);
  const rulesFingerprint = rulesSection?.fingerprint ?? '';
  if (
    promptCache &&
    promptCache.key === cacheKey &&
    promptCache.mtimeMs === mtime &&
    promptCache.rulesFingerprint === rulesFingerprint
  ) {
    return promptCache.segments;
  }

  const segments: SystemSection[] = [];

  // 1. 候选位置
  for (const candidates of BASE_PROMPT_CANDIDATES) {
    for (const name of candidates) {
      const file = join(userDir, `${name}.md`);
      if (fileExists(file)) {
        segments.push({
          id: name,
          title: SEGMENT_TITLES[name] ?? name,
          tokens: 0,
          content: readFileNoBom(file).trim(),
        });
        break;
      }
    }
  }

  // 2. 其他 *.md（字母序）
  let others: string[] = [];
  try {
    others = readdirSync(userDir)
      .filter(e => e.endsWith('.md'))
      .map(e => e.replace(/\.md$/i, ''))
      .filter(baseName => !CANDIDATE_NAMES.has(baseName))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    others = [];
  }
  for (const baseName of others) {
    const file = join(userDir, `${baseName}.md`);
    if (fileExists(file)) {
      segments.push({
        id: baseName,
        title: baseName,
        tokens: 0,
        content: readFileNoBom(file).trim(),
      });
    }
  }

  // 3. always 用户规则段（rules 引擎注入；恒在末尾）
  if (rulesSection?.text) {
    segments.push({
      id: 'user-rules',
      title: SEGMENT_TITLES['user-rules'],
      tokens: 0,
      content: rulesSection.text,
      defaultOpen: false,
    });
  }

  promptCache = {
    key: cacheKey,
    mtimeMs: mtime,
    rulesFingerprint,
    segments,
    joined: segments.map(s => s.content).join('\n\n---\n\n'),
  };
  return segments;
}

/**
 * 构建静态系统提示词（纯文本拼接，零变量替换）。
 * 环境信息全部由 env-context 消息承载 → 同一份文件跨会话/跨重启字节级一致（前缀缓存锚点）。
 * @param skillPrompt 可选的 skill system 模式注入内容（拼接在末尾；skill 切换=新缓存周期，低频可接受）
 * @param rulesSection rules 引擎注入的 always 规则段（规则集变更=新缓存周期，低频可接受）
 */
export function buildStaticSystemPrompt(
  env: Environment,
  skillPrompt?: string | null,
  rulesSection?: RulesSectionInput | null,
): string {
  seedBuiltinAgentPrompts(env);
  const userDir = join(env.dataDir, 'agent', 'prompts', 'main');
  const mtime = promptDirMtime(userDir);
  const rulesFingerprint = rulesSection?.fingerprint ?? '';
  if (
    !(promptCache &&
      promptCache.key === userDir &&
      promptCache.mtimeMs === mtime &&
      promptCache.rulesFingerprint === rulesFingerprint)
  ) {
    loadSystemPromptSegments(env, rulesSection);
  }
  const joined = promptCache?.joined ?? '';
  if (skillPrompt) {
    return `${joined}\n\n---\n\n${skillPrompt}`;
  }
  return joined;
}

/**
 * 获取系统提示词分段（含 tokens 估算，WebUI 系统标签页数据源）。
 * @param skillName 当前活跃 skill 名（system 模式时追加该段）
 * @param resolveSkillPrompt skill 内容解析回调（从 SkillRegistry 实时解析）
 * @param rulesSection rules 引擎注入的 always 规则段
 */
export function getSystemSections(
  env: Environment,
  skillName?: string,
  resolveSkillPrompt?: (name: string) => string | null,
  rulesSection?: RulesSectionInput | null,
): SystemSection[] {
  const segments = loadSystemPromptSegments(env, rulesSection);
  if (skillName && resolveSkillPrompt) {
    const skillPrompt = resolveSkillPrompt(skillName);
    if (skillPrompt) {
      segments.push({
        id: 'skill',
        title: `活跃技能：${skillName}`,
        tokens: 0,
        content: `# Active Skill: ${skillName}\n\n${skillPrompt}`,
        defaultOpen: true,
      });
    }
  }
  return segments.map(s => ({ ...s, tokens: estimateTextTokens(s.content) }));
}

/** 使提示词缓存失效（测试/提示词文件被路由写回时调用） */
export function invalidateSystemPromptCache(): void {
  promptCache = null;
}
