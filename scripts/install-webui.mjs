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
// 单字符串 + shell：Windows 上 npm 是 npm.cmd（Node 不允许无 shell 直接 spawn .cmd），
// 且避免 `shell:true` + 参数数组触发的 DEP0190 弃用警告。命令为常量，无注入面。
const result = spawnSync('npm install --no-audit --no-fund', {
  cwd: WEBUI,
  stdio: 'inherit',
  shell: isWin,
});

if (result.status !== 0) {
  console.error(`[install-webui] ERROR: npm install failed in webui/ (exit ${result.status})`);
  process.exit(result.status ?? 1);
}

log('webui dependencies installed.');