#!/usr/bin/env node
// bin/moss.js
// MOSS npm 包入口（npm bin "moss"）。
//
// 行为：
// - 优先使用构建产物 dist/main.js（生产发布）
// - 若构建产物不存在，回退到源码 src/main.ts（开发态直接 npm link）
// - 通过 Bun 运行时执行
//
// 用法：moss <command> [options]
//   moss start            后台启动守护进程
//   moss start -f         前台运行
//   moss stop / status / restart / update / version
//
// 启动性能：
// - 不再 spawnSync('bun --version') 探测（每次探测都是一个额外进程，Windows 低配机上是纯开销）；
// - 直接 spawn bun，仅在 ENOENT 时回退 node（构建产物才允许 node 回退）；
// - 注入 MOSS_BOOT_AT，供启动仪表计算「进程 spawn → ready」的真实耗时。

// 注意：package.json 为 "type": "module"，本文件会被 Node 按 ESM 解析，
// 因此必须使用 import 语法（不能使用 require，否则 `node bin/moss.js` 直接报错）。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 新构建产物为 dist/main.js（outdir + splitting）；兼容旧版单文件 dist/server.js
const BUILT = path.join(ROOT, 'dist', 'main.js');
const LEGACY_BUILT = path.join(ROOT, 'dist', 'server.js');
const SRC = path.join(ROOT, 'src', 'main.ts');

const BOOT_AT = String(Date.now());

function fail(msg) {
  console.error(`[moss] ${msg}`);
  process.exit(1);
}

// 选择入口文件
function resolveEntry() {
  if (fs.existsSync(BUILT)) return BUILT;
  if (fs.existsSync(LEGACY_BUILT)) return LEGACY_BUILT;
  if (fs.existsSync(SRC)) return SRC;
  fail(`No entry found. Looked for:\n  ${BUILT}\n  ${LEGACY_BUILT}\n  ${SRC}`);
}

/**
 * Linux/macOS：sherpa-onnx 原生 addon 的共享库需经 LD_LIBRARY_PATH/DYLD_LIBRARY_PATH 解析
 * （官方文档要求；Windows 自动加载，无需设置）。glibc/dyld 在进程启动时读取，故须在 spawn 时注入。
 */
function nativeLibEnv() {
  const libDir = path.resolve(ROOT, 'node_modules', 'sherpa-onnx-node', 'lib');
  if (process.platform === 'linux') {
    return { LD_LIBRARY_PATH: `${libDir}:${process.env.LD_LIBRARY_PATH ?? ''}` };
  }
  if (process.platform === 'darwin') {
    return { DYLD_LIBRARY_PATH: `${libDir}:${process.env.DYLD_LIBRARY_PATH ?? ''}` };
  }
  return {};
}

/**
 * 解析 bun 真实可执行文件路径。
 * Windows 上 bun 常以 npm 全局 shim（bun.cmd/bun.ps1）形式安装，Node 直接 spawn('bun')
 * 会 ENOENT；这里按 PATH 目录探测真实 bun.exe（含 npm shim 的 node_modules/bun/bin 布局），
 * 命中即 shell:false 启动（省一次 cmd.exe，低配机上是可观开销）。
 */
function resolveBunExecutable() {
  const exe = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const candidates = [];
  if (process.env.BUN_INSTALL) candidates.push(path.join(process.env.BUN_INSTALL, 'bin', exe));
  candidates.push(path.join(os.homedir(), '.bun', 'bin', exe));
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, exe));
    // npm 全局包布局：<prefix>/node_modules/bun/bin/bun.exe
    candidates.push(path.join(dir, 'node_modules', 'bun', 'bin', exe));
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 继续
    }
  }
  return null;
}

function run(runtime, entry, fwdArgs, shell = false) {
  return spawnSync(runtime, [entry, ...fwdArgs], {
    stdio: 'inherit',
    cwd: ROOT,
    windowsHide: true,
    shell,
    env: { ...process.env, ...nativeLibEnv(), MOSS_BOOT_AT: BOOT_AT },
  });
}

function main() {
  const entry = resolveEntry();
  const fwdArgs = process.argv.slice(2);
  const isTs = entry.endsWith('.ts');

  // 源码模式必须用 bun；构建产物优先 bun，缺失时回退 node（可能因 Bun API 失败，但至少能报错）
  const bun = resolveBunExecutable();
  let result = bun
    ? run(bun, entry, fwdArgs, false)
    : run('bun', entry, fwdArgs, process.platform === 'win32');
  if (result.error && result.error.code === 'ENOENT') {
    if (isTs) {
      fail('Bun runtime is required to run from source. Install Bun >= 1.1.0 or run "npm run build" first.');
    }
    result = run(process.execPath, entry, fwdArgs, false);
  }
  if (result.error) {
    fail(`Failed to spawn runtime: ${result.error.message}`);
  }
  process.exit(result.status ?? 1);
}

main();
