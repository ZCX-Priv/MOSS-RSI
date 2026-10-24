// src/modules/computer/paths.ts
// cua-driver 可执行文件探测 + ~/.moss/computer 目录与截图文件管理。
// 说明：不修改 PATH、不自动安装；安装由用户在 Computer 面板显式触发。

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Environment } from '../../core/types';

/** 截图保留策略 */
const SCREENSHOT_RETAIN_DAYS = 7;
const SCREENSHOT_MAX_FILES = 500;
/** 面板实时截图临时文件：最多保留 50 个 */
const LIVE_MAX_FILES = 50;
/** live 文件最长保留 1 小时（防止异常退出堆积） */
const LIVE_MAX_AGE_MS = 60 * 60 * 1000;

export interface ComputerDirs {
  root: string;
  screenshots: string;
  live: string;
}

/**
 * 解析 cua-driver 可执行文件。
 * 顺序：MOSS_CUA_DRIVER_PATH → 平台固定安装位置 → PATH。
 */
export function resolveCuaDriverPath(env: Environment): string | null {
  const candidates: string[] = [];
  const override = process.env.MOSS_CUA_DRIVER_PATH?.trim();
  if (override) candidates.push(override);

  if (env.isWindows) {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      candidates.push(join(localAppData, 'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe'));
    }
    candidates.push(join(env.homeDir, '.cua-driver', 'packages', 'current', 'cua-driver.exe'));
  } else {
    candidates.push(join(env.homeDir, '.local', 'bin', 'cua-driver'));
    candidates.push('/usr/local/bin/cua-driver');
    candidates.push('/opt/homebrew/bin/cua-driver');
    candidates.push('/usr/bin/cua-driver');
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // 忽略不可访问的候选路径
    }
  }

  // PATH 兜底（Bun 运行时提供 which；测试/非 Bun 环境返回 null）
  try {
    if (typeof Bun !== 'undefined' && typeof Bun.which === 'function') {
      return Bun.which('cua-driver');
    }
  } catch {
    // which 失败视为未安装
  }
  return null;
}

/** ~/.moss/computer 下的三个目录 */
export function getComputerDirs(env: Environment): ComputerDirs {
  const root = join(env.dataDir, 'computer');
  return {
    root,
    screenshots: join(root, 'screenshots'),
    live: join(root, 'live'),
  };
}

/** 创建目录（幂等） */
export function ensureComputerDirs(dirs: ComputerDirs): void {
  mkdirSync(dirs.screenshots, { recursive: true });
  mkdirSync(dirs.live, { recursive: true });
}

/** 日期目录 yyyyMMdd（本地时区） */
function dateDir(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** 时间片段 HHmmssSSS */
function timePart(now = new Date()): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${hh}${mm}${ss}${ms}`;
}

/** 生成一次截图路径（不创建文件；父目录按需创建） */
export function newScreenshotPath(
  dirs: ComputerDirs,
  kind: string,
  pid?: number,
  windowId?: number,
): string {
  const dayDir = join(dirs.screenshots, dateDir());
  mkdirSync(dayDir, { recursive: true });
  const parts = [timePart(), kind];
  if (typeof pid === 'number') parts.push(`p${pid}`);
  if (typeof windowId === 'number') parts.push(`w${windowId}`);
  const rand = Math.random().toString(36).slice(2, 8);
  parts.push(rand);
  return join(dayDir, `${parts.join('-')}.png`);
}

/** 生成 live 临时截图路径 */
export function newLivePath(dirs: ComputerDirs): string {
  mkdirSync(dirs.live, { recursive: true });
  const rand = Math.random().toString(36).slice(2, 10);
  return join(dirs.live, `${timePart()}-${rand}.png`);
}

/** 递归删除超过保留期的截图（按文件 mtime 判断，避免依赖目录时间） */
function pruneScreenshots(dirs: ComputerDirs): void {
  const cutoff = Date.now() - SCREENSHOT_RETAIN_DAYS * 24 * 60 * 60 * 1000;
  const files: Array<{ path: string; mtime: number }> = [];

  let days: string[];
  try {
    days = readdirSync(dirs.screenshots);
  } catch {
    return;
  }

  for (const day of days) {
    const dayPath = join(dirs.screenshots, day);
    let entries: string[];
    try {
      if (!statSync(dayPath).isDirectory()) continue;
      entries = readdirSync(dayPath);
    } catch {
      continue;
    }
    for (const name of entries) {
      const filePath = join(dayPath, name);
      try {
        const st = statSync(filePath);
        if (!st.isFile()) continue;
        if (st.mtimeMs < cutoff) {
          unlinkSync(filePath);
          continue;
        }
        files.push({ path: filePath, mtime: st.mtimeMs });
      } catch {
        // 并发删除/占用：跳过
      }
    }
    // 空目录顺手清理
    try {
      if (readdirSync(dayPath).length === 0) rmSync(dayPath, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  }

  // 数量上限：按 mtime 从旧到新删除
  if (files.length > SCREENSHOT_MAX_FILES) {
    files.sort((a, b) => a.mtime - b.mtime);
    for (const item of files.slice(0, files.length - SCREENSHOT_MAX_FILES)) {
      try {
        unlinkSync(item.path);
      } catch {
        // 忽略
      }
    }
  }
}

/** live 目录清理：过期文件 + 数量上限 */
function pruneLive(dirs: ComputerDirs): void {
  let names: string[];
  try {
    names = readdirSync(dirs.live);
  } catch {
    return;
  }
  const files: Array<{ path: string; mtime: number }> = [];
  const cutoff = Date.now() - LIVE_MAX_AGE_MS;
  for (const name of names) {
    const filePath = join(dirs.live, name);
    try {
      const st = statSync(filePath);
      if (!st.isFile()) continue;
      if (st.mtimeMs < cutoff) {
        unlinkSync(filePath);
        continue;
      }
      files.push({ path: filePath, mtime: st.mtimeMs });
    } catch {
      // 忽略
    }
  }
  if (files.length > LIVE_MAX_FILES) {
    files.sort((a, b) => a.mtime - b.mtime);
    for (const item of files.slice(0, files.length - LIVE_MAX_FILES)) {
      try {
        unlinkSync(item.path);
      } catch {
        // 忽略
      }
    }
  }
}

/** 启动时清理截图与 live 临时文件（失败不阻断） */
export function pruneComputerFiles(dirs: ComputerDirs): void {
  try {
    pruneScreenshots(dirs);
  } catch {
    // 清理失败不影响功能
  }
  try {
    pruneLive(dirs);
  } catch {
    // 清理失败不影响功能
  }
}

/** 单次截图后清理 live 目录 */
export function pruneLiveAfterCapture(dirs: ComputerDirs): void {
  try {
    pruneLive(dirs);
  } catch {
    // 忽略
  }
}
