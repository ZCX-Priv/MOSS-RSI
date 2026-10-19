#!/usr/bin/env bun
// bin/moss.js
// MOSS npm 包入口（npm bin "moss"）。
//
// 行为：
// - 优先使用构建产物 dist/server.js（生产发布）
// - 若构建产物不存在，回退到源码 src/main.ts（开发态直接 npm link）
// - 通过 Bun 运行时执行
//
// 用法：moss <command> [options]
//   moss start            后台启动守护进程
//   moss start -f         前台运行
//   moss stop / status / restart / update / version

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILT = path.join(ROOT, 'dist', 'server.js');
const SRC = path.join(ROOT, 'src', 'main.ts');

function fail(msg) {
  console.error(`[moss] ${msg}`);
  process.exit(1);
}

// 选择入口文件
function resolveEntry() {
  if (fs.existsSync(BUILT)) return BUILT;
  if (fs.existsSync(SRC)) return SRC;
  fail(`No entry found. Looked for:\n  ${BUILT}\n  ${SRC}`);
}

// 选择运行时：优先 bun，否则 node（仅对构建产物有效）
function resolveRuntime(entry) {
  const isTs = entry.endsWith('.ts');
  if (isTs) {
    // 源码模式必须用 bun
    const r = spawnSync('bun', ['--version'], { shell: process.platform === 'win32' });
    if (r.status !== 0) {
      fail('Bun runtime is required to run from source. Install Bun >= 1.1.0 or run "npm run build" first.');
    }
    return ['bun', [entry]];
  }
  // 构建产物（ESM JS, target=bun）：仍优先用 bun，因为依赖 Bun runtime API
  const r = spawnSync('bun', ['--version'], { shell: process.platform === 'win32' });
  if (r.status === 0) return ['bun', [entry]];
  // 退而求其次用 node 运行（可能因依赖 Bun API 而失败）
  return ['node', [entry]];
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

function main() {
  const entry = resolveEntry();
  const [runtime, runtimeArgs] = resolveRuntime(entry);
  const fwdArgs = process.argv.slice(2);
  const result = spawnSync(runtime, [...runtimeArgs, ...fwdArgs], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: ROOT,
    env: { ...process.env, ...nativeLibEnv() },
  });
  if (result.error) {
    fail(`Failed to spawn ${runtime}: ${result.error.message}`);
  }
  process.exit(result.status ?? 1);
}

main();
