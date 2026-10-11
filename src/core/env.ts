// src/core/env.ts
// 环境检测：平台、架构、路径解析。

import { homedir, platform, arch } from 'node:os';
import { join } from 'node:path';
import type { Environment, Platform } from './types';

/**
 * 探测运行环境并返回标准 Environment 对象。
 * packageRoot 解析策略：
 *  1. 开发模式：从 cwd 向上查找 package.json
 *  2. 安装模式：从 __dirname（编译产物 dist/server.js）向上回退到包根
 */
export function detectEnvironment(): Environment {
  const nodePlatform = platform();
  // Android 检测：Termux/proot 下 process.platform 仍为 'linux'，需靠环境特征区分。
  // 依据（任一命中即判定）：Android 框架导出的 ANDROID_ROOT/ANDROID_DATA；Termux 的
  // TERMUX_VERSION；Termux 前缀（PREFIX 指向 com.termux）。避免误伤普通 Linux。
  const isAndroid =
    nodePlatform === 'linux' &&
    (!!process.env.ANDROID_ROOT ||
      !!process.env.ANDROID_DATA ||
      !!process.env.TERMUX_VERSION ||
      (process.env.PREFIX ?? '').includes('com.termux'));
  let p: Platform = 'other';
  if (nodePlatform === 'win32') p = 'win32';
  else if (nodePlatform === 'darwin') p = 'darwin';
  else if (isAndroid) p = 'android';
  else if (nodePlatform === 'linux') p = 'linux';

  const home = homedir();
  const dataDir = join(home, '.moss');
  // 一次性迁移：旧目录 .moss → .moss（仅当新目录不存在且旧目录存在时）
  migrateLegacyDataDir(join(home, '.moss'), dataDir);
  const configDir = join(dataDir, 'config');
  const logsDir = join(dataDir, 'logs');
  const pidFile = join(dataDir, 'moss.pid');

  const packageRoot = resolvePackageRoot();

  return {
    platform: p,
    arch: arch(),
    isWindows: p === 'win32',
    isMac: p === 'darwin',
    isLinux: p === 'linux',
    isAndroid: p === 'android',
    homeDir: home,
    dataDir,
    configDir,
    logsDir,
    pidFile,
    runtimeVersion: typeof Bun !== 'undefined' ? Bun.version : 'unknown',
    pid: process.pid,
    packageRoot,
  };
}

function resolvePackageRoot(): string {
  // 优先：从当前文件位置向上查找 package.json
  // 当前文件位于 src/core/env.ts，开发模式下回退 3 层到包根
  // 编译后位于 dist/server.js，回退 1 层到包根
  const candidates = [
    // 编译产物路径
    import.meta.dir,
    // 开发模式：src/core -> 回退 3 层
    join(import.meta.dir, '..', '..', '..'),
    // 编译模式：dist -> 回退 1 层
    join(import.meta.dir, '..'),
    process.cwd(),
  ];

  for (const candidate of candidates) {
    const root = findUpPackageJson(candidate);
    if (root) return root;
  }
  return process.cwd();
}

function findUpPackageJson(start: string): string | null {
  let current = start;
  for (let i = 0; i < 10; i++) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fs = require('node:fs');
      const path = require('node:path');
      const pkgPath = path.join(current, 'package.json');
      if (fs.existsSync(pkgPath)) {
        // 校验 package name = moss，避免误判上级目录
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'moss') return current;
      }
    } catch {
      // 继续
    }
    const parent = require('node:path').dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * 一次性迁移：将旧的 ~/.moss 目录重命名为 ~/.moss。
 * 仅当新目录不存在且旧目录存在时执行，避免覆盖已有数据或重复迁移。
 */
function migrateLegacyDataDir(oldDir: string, newDir: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fs = require('node:fs');
    if (!fs.existsSync(newDir) && fs.existsSync(oldDir)) {
      fs.renameSync(oldDir, newDir);
      // 迁移成功不打印（此时 logger 尚未创建），仅静默完成
    }
  } catch {
    // 迁移失败不阻断启动，后续 mkdirRecursive 会创建新目录
  }
}

/**
 * 是否开发模式：scripts/dev.mjs 以 MOSS_DEV=1 启动后端时为 true。
 * 开发模式强制仅本机（回环）绑定，避免把 dev 环境暴露到局域网。
 */
export function isDevMode(): boolean {
  return process.env.MOSS_DEV === '1';
}
