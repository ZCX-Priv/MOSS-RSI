// scripts/build.mjs
// MOSS 构建脚本：构建后端 (Bun) + 前端 (Vite)
// 使用：node scripts/build.mjs

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const DIST = resolve(ROOT, 'dist');
const WEBUI_DIST = resolve(DIST, 'webui');
const BACKEND_OUT = resolve(DIST, 'server.js');

function log(msg) {
  console.log(`[build] ${msg}`);
}

function error(msg) {
  console.error(`[build] ERROR: ${msg}`);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: ROOT,
    ...opts,
  });
  if (result.status !== 0) {
    error(`Command failed: ${cmd} ${args.join(' ')} (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
  return result;
}

function detectBun() {
  // 优先使用直接可用的 bun 命令
  const r = spawnSync('bun', ['--version'], { shell: process.platform === 'win32' });
  if (r.status === 0) return { cmd: 'bun', args: [] };
  // 回退到 npx bun（兼容 bun 以 npm 包形式全局安装但不在 PATH 的场景）
  const r2 = spawnSync('npx', ['bun', '--version'], { shell: process.platform === 'win32' });
  if (r2.status === 0) return { cmd: 'npx', args: ['bun'] };
  return null;
}

function detectNpx() {
  const r = spawnSync('npx', ['--version'], { shell: process.platform === 'win32' });
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
  // bun build src/main.ts --outfile dist/server.js --target bun
  // --external nativefiledialog-for-bun：该库通过 Bun.dlopen 加载 FFI 二进制（nfd.dll 等），
  // 二进制路径基于 import.meta.dir 解析，若打包进 server.js 会指向 dist/ 找不到二进制，
  // 故标记为 external，运行时从 node_modules 加载，由库自行解析同目录的 .dll/.dylib/.so。
  // --external sherpa-onnx-node：同理，其原生 .node 绑定必须从磁盘加载；且这是必需项——
  // 不 external 时 bun 会额外产出一个原生资产文件（sherpa-onnx-*.node），
  // 而 --outfile 只允许单文件输出，构建会直接失败：
  //   error: cannot write multiple output files without an output directory
  run(bun.cmd, [
    ...bun.args,
    'build',
    entry,
    '--outfile', BACKEND_OUT,
    '--target', 'bun',
    '--format', 'esm',
    '--external', 'nativefiledialog-for-bun',
    '--external', 'sherpa-onnx-node',
    '--external', 'sharp',
    // IM SDK：均为 CJS/含动态 require，打包进单文件会破坏其运行时解析，运行时从 node_modules 加载
    '--external', '@wecom/aibot-node-sdk',
    '--external', '@tencent-connect/qqbot-nodejs',
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
// 步骤 3d: 复制 tree-sitter wasm 资产到 dist/vendor（图谱引擎运行时加载）
// 核心 wasm（web-tree-sitter.wasm）+ 常用语言语法 wasm（tree-sitter-wasm 包）。
// 运行时定位顺序：node_modules（开发模式）→ dist/vendor（安装模式），见 file-index/graph-engine/parser.ts。
// ============================================================================
const TREE_SITTER_LANGS = [
  'typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'java',
  'c', 'cpp', 'json', 'yaml', 'toml', 'markdown', 'css', 'html',
  'bash', 'ruby', 'php', 'lua',
];

function copyTreeSitterWasm() {
  log('Copying tree-sitter wasm assets...');
  const vendorDir = resolve(DIST, 'vendor');
  mkdirSync(vendorDir, { recursive: true });

  // 核心 wasm
  const coreSrc = resolve(ROOT, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm');
  if (!existsSync(coreSrc)) {
    error(`web-tree-sitter.wasm not found: ${coreSrc}`);
    process.exit(1);
  }
  cpSync(coreSrc, resolve(vendorDir, 'web-tree-sitter.wasm'));

  // 语言 wasm（按需子集，控制包体积；未拷语言运行时自动降级跳过）
  let copied = 0;
  for (const lang of TREE_SITTER_LANGS) {
    const src = resolve(ROOT, 'node_modules', 'tree-sitter-wasm', 'out', lang, `tree-sitter-${lang}.wasm`);
    if (!existsSync(src)) {
      log(`  (skip) grammar not found: ${lang}`);
      continue;
    }
    const destDir = resolve(vendorDir, 'tree-sitter-wasm', 'out', lang);
    mkdirSync(destDir, { recursive: true });
    cpSync(src, resolve(destDir, `tree-sitter-${lang}.wasm`));
    copied++;
  }
  log(`Tree-sitter wasm copied: core + ${copied} grammars -> ${vendorDir}`);
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
  run('npm', ['run', 'build'], {
    cwd: uiDir,
    shell: process.platform === 'win32',
  });
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
  copyBrowserExtension();
  copyAgentPrompts();
  copyTreeSitterWasm();
  buildFrontend();
  verifyArtifacts();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log('=========================================');
  console.log(` Build complete in ${elapsed}s`);
  console.log('=========================================');
}

main();
