// scripts/build.mjs
// MOSS 构建脚本：构建后端 (Bun) + 前端 (Vite) + 静态资产拷贝
// 使用：node scripts/build.mjs
//
// 性能设计：
// - 全部子进程并发执行（后端打包 / 前端打包 / 前端类型检查 / 资产拷贝互不依赖）；
// - 直接调用 node + vite/typescript 的入口 JS，绕开 npm.cmd / cmd.exe 包装层
//   （Windows 上少两层进程，且避免 shell 包装器残留句柄导致构建完成后终端不返回）；
// - 每个阶段输出耗时，便于定位卡点；
// - 产物校验完成后显式 process.exit(0)，保证终端立即回到命令行。

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const DIST = resolve(ROOT, 'dist');
const WEBUI = resolve(ROOT, 'webui');
const WEBUI_DIST = resolve(DIST, 'webui');
// 入口产物：outdir + splitting 模式下 Bun 输出 dist/main.js（旧版单文件为 dist/server.js，
// bin/moss.js 会做兼容读取）
const BACKEND_OUT = resolve(DIST, 'main.js');

const IS_WIN = process.platform === 'win32';
const STARTED_AT = Date.now();

function elapsed() {
  return ((Date.now() - STARTED_AT) / 1000).toFixed(2);
}

function log(msg) {
  console.log(`[build +${elapsed()}s] ${msg}`);
}

function error(msg) {
  console.error(`[build +${elapsed()}s] ERROR: ${msg}`);
}

function shellQuote(arg) {
  return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * 异步 spawn：等待进程真正退出（close 而非 exit，stdio 全部结算后才返回）。
 * Windows 下 windowsHide 避免弹窗；shell 默认关闭，避免 cmd.exe 包装层。
 */
function spawnAsync(command, args, opts = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: ROOT,
        stdio: 'inherit',
        windowsHide: true,
        shell: false,
        ...opts,
      });
    } catch (err) {
      resolvePromise({ code: -1, error: err });
      return;
    }
    child.on('error', (err) => resolvePromise({ code: -1, error: err }));
    child.on('close', (code, signal) => resolvePromise({ code: code ?? -1, signal }));
  });
}

/** Windows 下需要 shell 的兜底（npm 包装器） */
function spawnShellAsync(commandLine, opts = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(commandLine, { cwd: ROOT, stdio: 'inherit', windowsHide: true, shell: true, ...opts });
    } catch (err) {
      resolvePromise({ code: -1, error: err });
      return;
    }
    child.on('error', (err) => resolvePromise({ code: -1, error: err }));
    child.on('close', (code, signal) => resolvePromise({ code: code ?? -1, signal }));
  });
}

class BuildFailure extends Error {}

async function runTask(label, command, args, opts = {}) {
  const taskStart = Date.now();
  const result = await spawnAsync(command, args, opts);
  const cost = ((Date.now() - taskStart) / 1000).toFixed(2);
  if (result.error) {
    throw new BuildFailure(`${label} failed to spawn: ${result.error.message}`);
  }
  if (result.code !== 0) {
    throw new BuildFailure(
      `${label} exited with ${result.code === -1 ? `signal ${result.signal ?? 'unknown'}` : `code ${result.code}`}`,
    );
  }
  log(`${label} done in ${cost}s`);
  return cost;
}

function runSyncTask(label, fn) {
  const taskStart = Date.now();
  const value = fn();
  const cost = ((Date.now() - taskStart) / 1000).toFixed(2);
  log(`${label} done in ${cost}s`);
  return value;
}

/**
 * 解析 bun 真实可执行文件路径（与 bin/moss.js 同策略）：
 * Windows 上 bun 常以 npm 全局 shim 安装，直接 spawn('bun') 会 ENOENT。
 */
function resolveBunExecutable() {
  const exe = IS_WIN ? 'bun.exe' : 'bun';
  const candidates = [];
  if (process.env.BUN_INSTALL) candidates.push(join(process.env.BUN_INSTALL, 'bin', exe));
  candidates.push(join(os.homedir(), '.bun', 'bin', exe));
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    candidates.push(join(dir, exe));
    candidates.push(join(dir, 'node_modules', 'bun', 'bin', exe));
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // 继续探测下一个候选
    }
  }
  return null;
}

// ============================================================================
// 步骤 1: 清理 dist
// ============================================================================
function cleanDist() {
  log('Cleaning dist/');
  if (existsSync(DIST)) {
    rmSync(DIST, { recursive: true, force: true });
  }
  mkdirSync(DIST, { recursive: true });
}

// ============================================================================
// 步骤 2: 构建后端 (Bun build -> dist/main.js)
// ============================================================================
async function buildBackend() {
  const bunPath = resolveBunExecutable();
  const entry = resolve(ROOT, 'src/main.ts');
  if (!existsSync(entry)) {
    throw new BuildFailure(`Backend entry not found: ${entry}`);
  }

  const args = [
    'build',
    entry,
    '--outdir',
    DIST,
    '--target',
    'bun',
    '--format',
    'esm',
    // 低配机启动优化：minify 减少解析体积
    '--minify-syntax',
    '--minify-whitespace',
    '--minify-identifiers',
    '--splitting',
    // 原生绑定 / CJS SDK：运行时从 node_modules 加载，不能打包
    '--external',
    'sherpa-onnx-node',
    '--external',
    'sharp',
    '--external',
    '@tencent-connect/qqbot-nodejs',
    '--external',
    '@tencent-connect/qqbot-connector',
  ];

  if (bunPath) {
    await runTask('backend (bun)', bunPath, args);
  } else if (IS_WIN) {
    // 兜底：PATH 中没有真实 bun.exe 时退回 shell 包装器
    const result = await spawnShellAsync(`bun ${args.map(shellQuote).join(' ')}`);
    if (result.code !== 0) {
      throw new BuildFailure('backend (bun) failed: bun not found (install Bun >= 1.1.0)');
    }
    log('backend (bun) done via shell fallback');
  } else {
    await runTask('backend (bun)', 'bun', args);
  }

  if (!existsSync(BACKEND_OUT)) {
    throw new BuildFailure(`Backend build output not found: ${BACKEND_OUT}`);
  }
}

// ============================================================================
// 步骤 3: 复制 tools / 扩展 / prompts，并生成工具清单
// ============================================================================
function generateToolConfigManifest() {
  log('Generating tool config manifest...');
  const src = resolve(ROOT, 'src', 'modules', 'tools');
  const destDir = resolve(DIST, 'modules', 'tools');
  const manifests = [];
  let entries = [];
  try {
    entries = readdirSync(src, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const toolJson = resolve(src, entry.name, 'tool.json');
    if (!existsSync(toolJson)) continue;
    try {
      const manifest = JSON.parse(readFileSync(toolJson, 'utf8'));
      if (typeof manifest.name !== 'string') continue;
      manifests.push({ dir: entry.name, manifest });
    } catch {
      // 无效 tool.json 由运行时工具加载器单独告警
    }
  }
  const tools = manifests.map(({ manifest }) => ({ name: manifest.name, config: manifest.config }));
  writeFileSync(resolve(destDir, '_tools.json'), JSON.stringify({ version: 1, tools: manifests }, null, 2), 'utf8');
  writeFileSync(resolve(destDir, '_config-manifest.json'), JSON.stringify({ version: 1, tools }, null, 2), 'utf8');
  log(`Tool manifests written: ${tools.length} tools -> ${destDir}`);
}

function copyToolsModule() {
  const src = resolve(ROOT, 'src', 'modules', 'tools');
  const dest = resolve(DIST, 'modules', 'tools');
  if (!existsSync(src)) {
    throw new BuildFailure(`Tools module source not found: ${src}`);
  }
  // dist 已在 cleanDist 创建；Bun 运行时可直接 import .TS，故复制源码即可。
  // 排除 *.test.ts：测试文件相对路径在 dist 结构下失效，会被 bun test 误扫报错。
  cpSync(src, dest, {
    recursive: true,
    filter: (srcPath) => !srcPath.endsWith('.test.ts'),
  });
}

function copyBrowserExtension() {
  const src = resolve(ROOT, 'browser-extension');
  const dest = resolve(DIST, 'browser-extension');
  if (!existsSync(src)) {
    throw new BuildFailure(`Browser extension source not found: ${src}`);
  }
  cpSync(src, dest, { recursive: true });
}

function copyAgentPrompts() {
  const src = resolve(ROOT, 'agent');
  const dest = resolve(DIST, 'agent');
  if (!existsSync(src)) {
    throw new BuildFailure(`Agent prompts source not found: ${src}`);
  }
  // 先清空旧产物：cpSync 只增量覆盖，已删除的源目录会残留在 dist
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}

// ============================================================================
// 步骤 4: 构建前端 (Vite build -> dist/webui/)
// ============================================================================
function resolveWebuiBin(relativePath) {
  const full = resolve(WEBUI, relativePath);
  return existsSync(full) ? full : null;
}

/**
 * 前端打包 + 类型检查（并行）。
 * tsc 与 vite 同时执行，任一失败都会让整体构建失败。
 * 运行时顺带记录 index.html / sw.js 首次出现时间，用于观察 PWA 收尾阶段耗时。
 */
async function buildFrontend() {
  const viteBin = resolveWebuiBin('node_modules/vite/bin/vite.js');
  const tscBin = resolveWebuiBin('node_modules/typescript/bin/tsc');
  if (!existsSync(resolve(WEBUI, 'package.json'))) {
    throw new BuildFailure(`webui directory not found: ${WEBUI}`);
  }

  let htmlAt = 0;
  let swAt = 0;
  const indexHtml = resolve(WEBUI_DIST, 'index.html');
  const swFile = resolve(WEBUI_DIST, 'sw.js');
  const watcher = setInterval(() => {
    if (!htmlAt && existsSync(indexHtml)) htmlAt = Date.now();
    if (!swAt && existsSync(swFile)) swAt = Date.now();
  }, 200);

  const viteStart = Date.now();
  const viteTask = viteBin
    ? runTask('webui (vite)', process.execPath, [viteBin, 'build'], { cwd: WEBUI })
    : (() => {
        log('webui vite bin missing, fallback to npm run build');
        return spawnShellAsync('npm run build', { cwd: WEBUI }).then((result) => {
          if (result.code !== 0) throw new BuildFailure(`webui (vite) exited with code ${result.code}`);
          log('webui (vite) done via npm fallback');
        });
      })();

  const typecheckTask = tscBin
    ? runTask('webui typecheck (tsc)', process.execPath, [tscBin, '--noEmit'], { cwd: WEBUI })
    : (() => {
        log('webui tsc bin missing, fallback to npm run typecheck');
        return spawnShellAsync('npm run typecheck', { cwd: WEBUI }).then((result) => {
          if (result.code !== 0) throw new BuildFailure(`webui typecheck exited with code ${result.code}`);
          log('webui typecheck done via npm fallback');
        });
      })();

  try {
    await Promise.all([viteTask, typecheckTask]);
  } finally {
    clearInterval(watcher);
  }

  if (htmlAt && swAt && swAt > htmlAt) {
    log(`PWA stage: index.html +${((htmlAt - viteStart) / 1000).toFixed(1)}s, sw.js +${((swAt - viteStart) / 1000).toFixed(1)}s`);
  }
  if (!existsSync(WEBUI_DIST)) {
    throw new BuildFailure(`WebUI build output not found: ${WEBUI_DIST}`);
  }
}

// ============================================================================
// 步骤 5: 校验关键产物
// ============================================================================
function verifyArtifacts() {
  log('Verifying artifacts...');
  const required = [BACKEND_OUT, WEBUI_DIST, resolve(WEBUI_DIST, 'index.html')];
  for (const p of required) {
    if (!existsSync(p)) {
      throw new BuildFailure(`Missing artifact: ${p}`);
    }
  }
  log('All artifacts present.');
}

// ============================================================================
// 主流程
// ============================================================================
async function main() {
  console.log('=========================================');
  console.log(' MOSS Build');
  console.log('=========================================');

  cleanDist();

  const backendTask = buildBackend();
  const frontendTask = buildFrontend();
  const assetsTask = Promise.resolve().then(() => {
    runSyncTask('copy tools', () => {
      log('Copying tools module...');
      copyToolsModule();
    });
    runSyncTask('tool manifest', generateToolConfigManifest);
    runSyncTask('copy browser extension', () => {
      log('Copying browser extension...');
      copyBrowserExtension();
    });
    runSyncTask('copy agent prompts', () => {
      log('Copying agent prompts...');
      copyAgentPrompts();
    });
  });

  const results = await Promise.allSettled([backendTask, frontendTask, assetsTask]);
  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    for (const failure of failures) {
      error(failure.reason instanceof Error ? failure.reason.message : String(failure.reason));
    }
    process.exit(1);
  }

  verifyArtifacts();

  console.log('=========================================');
  console.log(` Build complete in ${elapsed()}s`);
  console.log('=========================================');

  // 显式退出：所有产物已校验，第三方依赖可能残留句柄，不能依赖事件循环自然清空
  if (process.env.MOSS_BUILD_DEBUG === '1') {
    const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : [];
    const requests = typeof process._getActiveRequests === 'function' ? process._getActiveRequests() : [];
    console.log(`[build] active handles=${handles.length} requests=${requests.length}`);
  }
  process.exit(0);
}

main().catch((err) => {
  error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
