// scripts/install-webui.mjs
// 目的：让根目录的一条 `npm install` 就装齐「后端（根） + 前端（webui/）」两棵依赖树。
//
// 做法：由根 package.json 的 postinstall 调用本脚本，在 webui/ 内执行一次 npm install。
// 为什么不用 npm workspaces：根与 webui 存在版本冲突的重复依赖
//   （vite 5/8、react 18/19、@vitejs/plugin-react 4/6、typescript 5/6），
//   workspaces 会把这些包重新提升/嵌套，可能破坏当前可用的前端构建；
//   且 scripts/dev.mjs 与 scripts/build.mjs 都按「两棵独立依赖树」定位
//   webui/node_modules，改为 workspaces 需连带改造这两个脚本。
//
// 跳过条件（防止在「本包作为依赖被安装」或显式跳过时误触发）：
//   1) webui/package.json 不存在（发布包 files 白名单不含 webui/ 与 scripts/）
//   2) 环境变量 MOSS_SKIP_WEBUI_INSTALL=1
//
// 注：webui/ 内没有 postinstall，不存在递归调用。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEBUI = resolve(ROOT, 'webui');
const isWin = process.platform === 'win32';

function log(msg) {
  console.log(`[install-webui] ${msg}`);
}

if (process.env.MOSS_SKIP_WEBUI_INSTALL === '1') {
  log('skipped (MOSS_SKIP_WEBUI_INSTALL=1)');
  process.exit(0);
}

if (!existsSync(resolve(WEBUI, 'package.json'))) {
  log('skipped: webui/package.json not found (installed-as-dependency case)');
  process.exit(0);
}

log('installing webui dependencies (npm install in webui/)...');
// 跨平台调用 npm（两个陷阱必须同时避开）：
//  1) Windows：npm 是 npm.cmd，经 CVE-2024-27980 修复后 Node 不允许无 shell 直接 spawn .cmd
//     → 必须 shell:true；同时用「单命令串」而非「参数数组」以规避 DEP0190 弃用警告。
//  2) POSIX（Linux / macOS / Termux）：shell:false 时 Node 会把整串命令（含空格）
//     当成「可执行文件名」而不拆分参数 → ENOENT、status=null。
//     这正是旧实现在 Termux 上报 `(exit null)` 的根因；必须用「命令 + 参数数组」形态。
const NPM_ARGS = ['install', '--no-audit', '--no-fund'];
const result = isWin
  ? spawnSync(`npm ${NPM_ARGS.join(' ')}`, { cwd: WEBUI, stdio: 'inherit', shell: true })
  : spawnSync('npm', NPM_ARGS, { cwd: WEBUI, stdio: 'inherit', shell: false });

if (result.error || result.status !== 0) {
  // 完整原因上报：spawn 失败（error）/ 被信号杀死（signal）/ 普通非零码，三者形态不同
  const reason = result.error
    ? `${result.error.code ?? result.error.name}: ${result.error.message}`
    : result.signal
      ? `killed by signal ${result.signal}`
      : `exit ${result.status}`;
  console.error(`[install-webui] ERROR: npm install failed in webui/ (${reason})`);
  if (result.error?.code === 'ENOENT') {
    console.error('[install-webui] npm not found on PATH. Termux: `pkg install nodejs`; then retry.');
  }
  process.exit(result.status ?? 1);
}

log('webui dependencies installed.');