// scripts/build.mjs
// MOSS 构建脚本：构建后端 (Bun) + 前端 (Vite)
// 使用：node scripts/build.mjs

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const DIST = resolve(ROOT, 'dist');
const WEBUI_DIST = resolve(DIST, 'webui');
// 入口产物：outdir + splitting 模式下 Bun 输出 dist/main.js（旧版单文件为 dist/server.js，
// bin/moss.js 会做兼容读取）
const BACKEND_OUT = resolve(DIST, 'main.js');

function log(msg) {
  console.log(`[build] ${msg}`);
}

function error(msg) {
  console.error(`[build] ERROR: ${msg}`);
}

const IS_WIN = process.platform === 'win32';

/** shell 参数转义：仅含安全字符时原样，否则加双引号（路径可能含空格/中文） */
function shellQuote(arg) {
  return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

function spawn(cmd, args, opts = {}) {
  // Windows：npm / npx / bun 均为 .cmd/.ps1 包装器，Node 禁止无 shell 直接 spawn
  // （CVE-2024-27980 之后）；但「args 数组 + shell:true」会触发 DEP0190 弃用警告
  // （参数未转义、仅拼接）。故 Windows 下把命令与参数拼成单条命令串交给 shell。
  // POSIX：直接以「命令 + 参数数组」形态 spawn，避免路径含空格时被错误拆分。
  const options = { stdio: 'inherit', cwd: ROOT, ...opts };
  return IS_WIN
    ? spawnSync([cmd, ...args].map(shellQuote).join(' '), { ...options, shell: true })
    : spawnSync(cmd, args, options);
}

function run(cmd, args, opts = {}) {
  const result = spawn(cmd, args, opts);
  if (result.status !== 0) {
    error(`Command failed: ${cmd} ${args.join(' ')} (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
  return result;
}

function probe(cmd, args) {
  const options = IS_WIN
    ? { shell: true, stdio: 'ignore' }
    : { stdio: 'ignore' };
  return IS_WIN
    ? spawnSync([cmd, ...args].map(shellQuote).join(' '), options)
    : spawnSync(cmd, args, options);
}

function detectBun() {
  // 优先使用直接可用的 bun 命令
  const r = probe('bun', ['--version']);
  if (r.status === 0) return { cmd: 'bun', args: [] };
  // 回退到 npx bun（兼容 bun 以 npm 包形式全局安装但不在 PATH 的场景）
  const r2 = probe('npx', ['bun', '--version']);
  if (r2.status === 0) return { cmd: 'npx', args: ['bun'] };
  return null;
}

function detectNpx() {
  const r = probe('npx', ['--version']);
  if (r.status === 0) return 'npx';
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
// 步骤 2: 构建后端 (Bun build -> dist/server.js)
// ============================================================================
function buildBackend() {
  log('Building backend (Bun)...');
  const bun = detectBun();
  if (!bun) {
    error('bun not found. Please install Bun >= 1.1.0 first.');
    process.exit(1);
  }
  const entry = resolve(ROOT, 'src/main.ts');
  if (!existsSync(entry)) {
    error(`Backend entry not found: ${entry}`);
    process.exit(1);
  }
  // bun build src/main.ts --outdir dist --splitting --target bun
  // 单文件产物 15MB+，Bun 必须解析并求值整棵 import 树后才能进入 CLI（低配机器冷启动慢）。
  // 改为 outdir + splitting：动态 import 的模块（工具实现/重依赖）拆成独立 chunk，
  // 启动只加载关键路径代码。入口产物为 dist/main.js（bin/moss.js 会优先读取它）。
  // --external 保持：sherpa-onnx 原生绑定/IM CJS SDK/ sharp 必须运行时从 node_modules 加载。
  run(bun.cmd, [
    ...bun.args,
    'build',
    entry,
    '--outdir', DIST,
    '--target', 'bun',
    '--format', 'esm',
    // 低配机启动优化：minify 减少解析体积（标识符混淆已通过测试与运行时冒烟）
    '--minify-syntax',
    '--minify-whitespace',
    '--minify-identifiers',
    '--splitting',
    '--external', 'sherpa-onnx-node',
    '--external', 'sharp',
    // IM SDK：均为 CJS/含动态 require，打包会破坏其运行时解析，运行时从 node_modules 加载
    '--external', '@tencent-connect/qqbot-nodejs',
    '--external', '@tencent-connect/qqbot-connector',
  ]);
  if (!existsSync(BACKEND_OUT)) {
    error(`Backend build output not found: ${BACKEND_OUT}`);
    process.exit(1);
  }
  log(`Backend built: ${BACKEND_OUT}`);
}

// ============================================================================
// 步骤 3: 复制 tools 模块目录到 dist（供生产模式动态 import + tool.json 读取）
// 含全部工具子目录 + shared/ 共享模块；顶层 .ts 已打包进 server.js，冗余但无害
// ============================================================================
/**
 * 生成内置工具配置清单（启动性能关键路径）：
 * 启动只读 dist/modules/tools/_config-manifest.json 一个文件，
 * 不再逐个工具目录 readdir/stat/read tool.json。
 */
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
  // 启动只读这两个文件：
  // - _tools.json：完整工具描述符（loadToolDescriptorsFromPrebuilt）
  // - _config-manifest.json：config 段（defaultAppConfig / config-schema）
  const tools = manifests.map(({ manifest }) => ({ name: manifest.name, config: manifest.config }));
  writeFileSync(resolve(destDir, '_tools.json'), JSON.stringify({ version: 1, tools: manifests }, null, 2), 'utf8');
  writeFileSync(resolve(destDir, '_config-manifest.json'), JSON.stringify({ version: 1, tools }, null, 2), 'utf8');
  log(`Tool manifests written: ${tools.length} tools -> ${destDir}`);
}

function copyToolsModule() {
  log('Copying tools module...');
  const src = resolve(ROOT, 'src', 'modules', 'tools');
  const dest = resolve(DIST, 'modules', 'tools');
  if (!existsSync(src)) {
    error(`Tools module source not found: ${src}`);
    process.exit(1);
  }
  // dist 已在 cleanDist 创建；递归复制保留目录结构（含 tool.json + index.ts）
  // Bun 运行时可直接 import .TS，故复制源码即可
  // 排除 *.test.ts：测试文件相对路径在 dist 结构下失效，会被 bun test 误扫报错
  cpSync(src, dest, {
    recursive: true,
    filter: (srcPath) => !srcPath.endsWith('.test.ts'),
  });
  log(`Tools module copied: ${dest}`);
}

// ============================================================================
// 步骤 3b: 复制浏览器扩展目录到 dist（browser 模块播种到 ~/.moss/browser/extension）
// ============================================================================
function copyBrowserExtension() {
  log('Copying browser extension...');
  const src = resolve(ROOT, 'browser-extension');
  const dest = resolve(DIST, 'browser-extension');
  if (!existsSync(src)) {
    error(`Browser extension source not found: ${src}`);
    process.exit(1);
  }
  cpSync(src, dest, { recursive: true });
  log(`Browser extension copied: ${dest}`);
}

// ============================================================================
// 步骤 3c: 复制 agent/ 提示词目录到 dist（播种源：首次运行复制到 ~/.moss/agent/，
// 运行时只读用户目录，但种子模板必须随包分发）
// ============================================================================
function copyAgentPrompts() {
  log('Copying agent prompts...');
  const src = resolve(ROOT, 'agent');
  const dest = resolve(DIST, 'agent');
  if (!existsSync(src)) {
    error(`Agent prompts source not found: ${src}`);
    process.exit(1);
  }
  cpSync(src, dest, { recursive: true });
  log(`Agent prompts copied: ${dest}`);
}

// ============================================================================
// 步骤 4: 构建前端 (Vite build -> dist/webui/)
// ============================================================================
function buildFrontend() {
  log('Building webui (Vite)...');
  const uiDir = resolve(ROOT, 'webui');
  if (!existsSync(uiDir)) {
    error(`webui directory not found: ${uiDir}`);
    process.exit(1);
  }
  // 在 webui/ 目录运行 npm run build（webui/ 有独立的 vite.config.ts，产物输出到 ../dist/webui）
  run('npm', ['run', 'build'], { cwd: uiDir });
  if (!existsSync(WEBUI_DIST)) {
    error(`WebUI build output not found: ${WEBUI_DIST}`);
    process.exit(1);
  }
  log(`WebUI built: ${WEBUI_DIST}`);
}

// ============================================================================
// 步骤 4: 校验关键产物
// ============================================================================
function verifyArtifacts() {
  log('Verifying artifacts...');
  const required = [
    BACKEND_OUT,
    WEBUI_DIST,
    resolve(WEBUI_DIST, 'index.html'),
  ];
  for (const p of required) {
    if (!existsSync(p)) {
      error(`Missing artifact: ${p}`);
      process.exit(1);
    }
  }
  log('All artifacts present.');
}

// ============================================================================
// 主流程
// ============================================================================
function main() {
  const startedAt = Date.now();
  console.log('=========================================');
  console.log(' MOSS Build');
  console.log('=========================================');
  cleanDist();
  buildBackend();
  copyToolsModule();
  generateToolConfigManifest();
  copyBrowserExtension();
  copyAgentPrompts();
  buildFrontend();
  verifyArtifacts();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log('=========================================');
  console.log(` Build complete in ${elapsed}s`);
  console.log('=========================================');
}

main();
