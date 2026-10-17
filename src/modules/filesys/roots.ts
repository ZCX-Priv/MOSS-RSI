// src/modules/filesys/roots.ts
// roots 机制：cwd（隐含 root）+ 配置的额外授权目录，统一越权拒绝。
// 允许的根目录列表，动态可配，越界统一拒绝。
// extraRoots 为空时行为与旧版 resolveWithinCwd 完全一致（零迁移风险）。
//
// System 作用域（本机模式）：cwd 为 SYSTEM_SCOPE 哨兵时全盘可访问（跳过 roots 范围检查），
// 相对路径基于系统盘根解析（与 terminal 默认执行目录一致）。
// .moss 保护为全局硬规则：~/.moss 下仅 agent/mcps/skills 三个子目录可访问，
// 与 cwd/权限模式无关（skip 也拦），防止 AI 篡改自身配置/存储实现自我提权。

import { isAbsolute, normalize, resolve, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isPathInside } from '../../utils/fs';

/** 系统级（本机）作用域哨兵：前端默认工作目录传该值表示全盘访问 */
export const SYSTEM_SCOPE = '__system__';

/** 系统作用域（本机模式）的默认工作基准：Windows 取系统盘根（C:\），POSIX 取 / */
export function systemRoot(): string {
  if (process.platform === 'win32') {
    const drive = (process.env.SystemDrive || 'C:').replace(/[\\/]+$/, '');
    return `${drive}\\`;
  }
  return '/';
}

/**
 * ~/.moss 下允许 AI 访问的子目录（其余一律屏蔽，含 config/todo 等）。
 * analysis：read 工具对 office 文件的解析产物（图片/视频本体 + markdown），
 * 需对 agent（read 工具）与前端预览（/api/filesystem/raw）放行。
 */
const MOSS_ALLOWED_SUBDIRS = ['agent', 'mcps', 'skills', 'analysis'];

/** 路径归一化比较键：统一分隔符 + 小写（Windows 大小写不敏感） */
function pathKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** ~/.moss 根（标准化） */
function mossRoot(): string {
  return normalize(join(homedir(), '.moss'));
}

/**
 * .moss 访问白名单（全局硬规则）：
 * 路径位于 ~/.moss 内时，仅 agent/mcps/skills 三个子目录（含其下）放行；
 * ~/.moss 根自身与其余内容一律屏蔽；路径不在 ~/.moss 内恒放行。
 */
export function isMossAccessAllowed(absPath: string): boolean {
  const root = pathKey(mossRoot());
  const p = pathKey(normalize(absPath));
  if (p !== root && !p.startsWith(`${root}/`)) return true;
  return MOSS_ALLOWED_SUBDIRS.some(
    (sub) => p === `${root}/${sub}` || p.startsWith(`${root}/${sub}/`),
  );
}

/**
 * roots 解析：相对路径基于 cwd 解析；绝对路径直接使用；
 * 标准化后必须位于 cwd 或任一额外授权 root 内（含自身），否则返回 null（调用方拒绝访问）。
 * cwd 为 SYSTEM_SCOPE 时：相对路径基于系统盘根解析，跳过 roots 范围检查（全盘可访问）。
 * 任何路径若命中 .moss 屏蔽规则均返回 null（优先于一切放行分支）。
 */
export function resolveInRoots(rawPath: string, cwd: string, extraRoots: readonly string[]): string | null {
  const systemScope = cwd === SYSTEM_SCOPE;
  const base = systemScope ? systemRoot() : cwd || process.cwd();
  const abs = isAbsolute(rawPath) ? normalize(rawPath) : normalize(resolve(base, rawPath));
  if (!isMossAccessAllowed(abs)) return null;
  if (systemScope) return abs;
  if (isPathInside(abs, base)) return abs;
  for (const root of extraRoots) {
    if (isPathInside(abs, root)) return abs;
  }
  return null;
}

/**
 * 归一化授权 roots：仅保留真实存在的目录绝对路径（去重）。
 * 不存在的目录静默丢弃（配置指向已卸载的盘符等场景），保证服务可用。
 */
export function normalizeRoots(roots: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of roots) {
    if (!raw || !isAbsolute(raw)) continue;
    const p = normalize(raw);
    const key = process.platform === 'win32' ? p.toLowerCase() : p;
    if (seen.has(key)) continue;
    try {
      if (!existsSync(p) || !statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(key);
    out.push(p);
  }
  return out;
}
