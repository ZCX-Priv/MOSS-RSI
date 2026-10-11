// src/modules/context/compiler/env-context.ts
// 环境上下文消息（会话首条锚定消息，append-only）：系统提示词保持零变量纯静态，
// 全部环境信息（平台/工作目录/设备/语言编码/模型/解释器实测/工具链实测/git/时间）集中于此。
// - 缓存布局黄金法则：静态在前（system prompt 纯文本拼接）、动态在后（本消息锚定）
// - 会话创建时生成一次，之后永不修改（修改旧消息 = 破坏前缀）
// - 时间放最后（用户约定）；跨天继续会话：末尾「追加」日期提示消息（不改动历史）
// - 旧会话（旧格式 env-context）：不迁移，保持原样（新会话起用新格式）
// - 解释器/工具链/编码来自 env-probe（启动实测；工具链经 prepareRequest 开头
//   await ensureEnvProbed 预热，本消息构建时缓存已就绪）

import { execSync } from 'node:child_process';
import { hostname, arch, cpus, release } from 'node:os';
import type { Environment, Platform } from '../../../core/types';
import type { ContextMessage, ContextSessionLike } from '../types';
import { buildTerminalInfoText, buildDevToolsText, buildEncodingText } from './env-probe';
import { SYSTEM_SCOPE, systemRoot } from '../../filesys/roots';

/** 消息 name 标识 */
export const ENV_CONTEXT_MSG_NAME = 'env-context';
export const DAY_ROLLOVER_MSG_NAME = 'day-rollover';

/** git status 快照截断上限 */
const MAX_GIT_STATUS_CHARS = 2000;

/** git 命令超时（ms）：非 git 目录/慢仓库不拖慢会话启动 */
const GIT_TIMEOUT_MS = 3000;

/** 今日日期 YYYY-MM-DD */
export function todayDate(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 当前时间字符串（env-context 快照用） */
function nowTimeString(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${todayDate()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function prettyPlatform(p: Platform): string {
  switch (p) {
    case 'win32': return 'Windows';
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    case 'android': return 'Android';
    default: return 'Other';
  }
}

/** 安全执行 git 命令（失败/超时返回 null） */
function git(args: string, cwd: string): string | null {
  try {
    const out = execSync(`git ${args}`, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return out.trim();
  } catch {
    return null;
  }
}

/** 生成 git 状态快照段（非 git 目录返回 null） */
function buildGitSnapshot(cwd: string): string | null {
  const branch = git('rev-parse --abbrev-ref HEAD', cwd);
  if (branch === null) return null;
  const status = git('--no-optional-locks status --short', cwd) ?? '';
  const log = git('--no-optional-locks log --oneline -n 5', cwd) ?? '';

  const truncatedStatus =
    status.length > MAX_GIT_STATUS_CHARS
      ? `${status.slice(0, MAX_GIT_STATUS_CHARS)}\n...（状态过长已截断，需要完整信息请运行 git status）`
      : status;

  return [
    '[Git 状态快照]（会话开始时拍摄，期间不会自动更新）',
    `当前分支: ${branch}`,
    `状态:\n${truncatedStatus || '（工作区干净）'}`,
    `最近提交:\n${log || '（无提交记录）'}`,
  ].join('\n');
}

/** 工作目录展示文案（System 作用域特殊说明，语义与旧 system.md 变量一致） */
function cwdText(cwd: string): string {
  return cwd === SYSTEM_SCOPE
    ? `System-wide access mode (full filesystem access; default working directory: ${systemRoot()}; under ~/.moss only the agent/, mcps/, skills/ subdirectories are accessible)`
    : cwd;
}

/**
 * 构建环境上下文消息（会话首条锚定消息）——全部环境信息的唯一承载处。
 * content 含生成时刻的快照（含时间，置于最后）——此后永不修改（append-only 纪律）。
 */
export function buildEnvContextMessage(
  env: Environment,
  cwd: string,
  model?: string,
  modelDisplayName?: string,
): ContextMessage {
  let cpuModel = 'unknown';
  try {
    cpuModel = cpus()[0]?.model ?? cpuModel;
  } catch {
    // 忽略
  }

  const parts: string[] = [
    '[环境上下文]',
    `平台: ${prettyPlatform(env.platform)}（${env.platform}, ${arch()}，${release()}）`,
    `工作目录: ${cwdText(cwd)}`,
    `设备信息: ${hostname()} / ${arch()} / ${cpuModel}`,
    `语言/编码: ${buildEncodingText(env)}`,
  ];
  if (modelDisplayName || model) {
    parts.push(`模型: ${modelDisplayName || model}${model ? `（ID：${model}）` : ''}`);
  }
  parts.push(`# 终端环境（启动时实测）\n${buildTerminalInfoText(env)}`);
  parts.push(`# 开发工具链（启动时实测）\n${buildDevToolsText(env)}`);
  const gitSnapshot = buildGitSnapshot(cwd);
  if (gitSnapshot) parts.push(gitSnapshot);
  // 时间放最后（用户约定）
  parts.push(`当前时间: ${nowTimeString()}（${Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'}）`);
  return {
    role: 'user',
    name: ENV_CONTEXT_MSG_NAME,
    content: parts.join('\n\n'),
    timestamp: new Date().toISOString(),
  };
}

/**
 * 会话环境上下文保障（每次 run 开始时调用）：
 * 1. 无 env-context 消息（旧会话/新会话）→ 补建并插到消息流最前 + 写 envContext 锚定信息
 * 2. 跨天（envContext.date ≠ 今天）→ 末尾追加日期提示消息（append-only，不破坏前缀）
 * @returns true 表示消息流发生了变化（需要持久化）
 */
export function ensureEnvContext(
  session: ContextSessionLike,
  env: Environment,
  cwd: string,
  model?: string,
  modelDisplayName?: string,
): boolean {
  let changed = false;
  const today = todayDate();

  const hasEnvMsg = session.messages.some(m => m.name === ENV_CONTEXT_MSG_NAME);
  if (!hasEnvMsg) {
    session.messages.unshift(buildEnvContextMessage(env, cwd, model, modelDisplayName));
    session.envContext = { createdAt: new Date().toISOString(), date: today };
    changed = true;
  }

  // 跨天检测：锚定日期 ≠ 今天 → 追加日期消息（今天内多次 run 只追加一次）
  if (session.envContext && session.envContext.date !== today) {
    session.messages.push({
      role: 'user',
      name: DAY_ROLLOVER_MSG_NAME,
      content: `[时间提示] 当前日期已更新为 ${today}（跨天继续会话，此前的环境上下文快照中的时间已过期）。`,
      timestamp: new Date().toISOString(),
    });
    session.envContext = { ...session.envContext, date: today };
    changed = true;
  }

  return changed;
}
