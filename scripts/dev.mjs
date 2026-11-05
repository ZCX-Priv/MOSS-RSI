// scripts/dev.mjs
// MOSS 开发脚本：并行启动后端 (Bun watch) + 前端 (Vite dev)
// 使用：node scripts/dev.mjs
//
// - 后端：bun run --watch src/main.ts start --foreground --log-level debug
//   （文件改动自动重启；注入 MOSS_DEV=1 → 默认仅本机（回环）绑定；开启远程访问后允许 0.0.0.0）
// - 前端：vite（3000 端口，代理 /api 与 /ws 到后端 7766；仅绑 127.0.0.1，不对局域网开放）
//
// dev 默认仅本机可达：127.0.0.1 / localhost。开启「远程访问」后，后端会绑定 0.0.0.0，
// 局域网手机可访问后端端口（页面为 dist/webui 构建产物；前端 Vite 仍仅本机）。
//
// Ctrl+C 优雅退出，关闭所有子进程。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir, uptime } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const isWin = process.platform === 'win32';

/**
 * 读取配置端口：优先用户配置 ~/.moss/config/config.json（运行时实际加载的配置），
 * 回退项目 config/config.json。后端若因占用漂移端口，这里会在启动后以 PID 文件为准。
 */
function readConfiguredPort() {
  const candidates = [
    resolve(homedir(), '.moss', 'config', 'config.json'),
    resolve(ROOT, 'config', 'config.json'),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const cfg = JSON.parse(readFileSync(p, 'utf8'));
      const port = cfg?.server?.port;
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    } catch {
      // 解析失败继续下一个候选
    }
  }
  return 7766;
}

function log(tag, msg) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}] [${tag}] ${msg}`);
}

function hasBun() {
  const r = spawnSync('bun', ['--version'], { shell: isWin });
  return r.status === 0;
}

function hasNpx() {
  const r = spawnSync('npx', ['--version'], { shell: isWin });
  return r.status === 0;
}

/**
 * Windows 下将控制台代码页切换为 UTF-8，避免 MOSS 内核的中文日志乱码。
 * 原因：MOSS 日志以 UTF-8 输出，而 cmd.exe 默认代码页为 936（GBK），
 * 终端按 GBK 解码 UTF-8 字节导致乱码（如"收到"变成"鏀跺埌"）。
 * 一次性同步调用，不参与 Ctrl+C 退出，无批处理弹窗副作用。
 */
function ensureUtf8Console() {
  if (!isWin) return;
  try {
    // chcp 是 cmd 内置命令，需经 cmd.exe 执行
    spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', 'chcp 65001 >nul'], { stdio: 'ignore' });
  } catch {
    // 忽略失败，仅影响日志显示
  }
}

/**
 * 解析 bun 的真实二进制路径（Windows 专用，兼容 npm 全局安装的 bun.cmd shim）。
 * Windows 上 spawn('bun',...) 无 shell 时 CreateProcess 只找 .exe，
 * 若 bun 是 npm 全局安装（只有 bun.cmd shim），会 ENOENT。
 * 本函数通过读取 bun.cmd 内容提取真实二进制路径，直接 spawn 绕开 cmd.exe 批处理，
 * 从而消除 Ctrl+C 时的"终止批处理操作吗(Y/N)?"弹窗。
 */
function resolveBunExe() {
  if (!isWin) return 'bun';
  const candidates = [];

  try {
    const r = spawnSync('where', ['bun'], { encoding: 'utf8' });
    if (r.status === 0) {
      const lines = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      // 1) 优先选 .exe（Bun 官方安装器或其他 PATH 中的 bun.exe）
      const exe = lines.find(l => /\.exe$/i.test(l));
      if (exe) return exe;

      // 2) 只有 .cmd（npm 全局安装）：读取 bun.cmd 内容，提取 %~dp0 后的真实二进制路径
      const cmd = lines.find(l => /\.cmd$/i.test(l));
      if (cmd) {
        try {
          const content = readFileSync(cmd, 'utf8');
          const m = content.match(/%~dp0([^"'`\s]*\.(?:exe|cmd))/i)
            || content.match(/%~dp0([^"'`\s]+)/i);
          if (m) {
            const p = resolve(dirname(cmd), m[1]);
            if (existsSync(p)) return p;
          }
        } catch {
          // 读 shim 失败，继续尝试候选路径
        }
        // 3) 常见候选路径（bun 包结构）
        const base = dirname(cmd);
        candidates.push(
          resolve(base, 'node_modules', 'bun', 'bin', 'bun.exe'),
          resolve(base, 'node_modules', '@oven', 'bun', 'bin', 'bun.exe'),
          resolve(base, 'node_modules', 'bun', 'bun.exe'),
        );
      }
    }

    // 4) npm root -g 兜底（npm 全局安装目录）
    const root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
    if (root.status === 0 && root.stdout.trim()) {
      const g = root.stdout.trim();
      candidates.push(
        resolve(g, 'bun', 'bin', 'bun.exe'),
        resolve(g, '@oven', 'bun', 'bin', 'bun.exe'),
      );
    }
  } catch {
    // where.exe 不可用，继续候选路径
  }

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // 全部失败：回退 'bun'（走 shell），并打印诊断便于定位
  log('backend', 'WARNING: 未能解析 bun.exe 真实路径，将回退到 shell（可能触发批处理弹窗）');
  return 'bun';
}

const children = [];

/**
 * Linux/macOS：sherpa-onnx 原生 addon 依赖的共享库需经 LD_LIBRARY_PATH/DYLD_LIBRARY_PATH 解析
 * （官方文档要求；Windows 的 DLL 与 .node 同目录，自动加载，无需设置）。
 * 因 glibc/dyld 在「进程启动时」读取该变量，必须在 spawn 时注入。
 */
function nativeLibEnv() {
  const libDir = resolve(ROOT, 'node_modules', 'sherpa-onnx-node', 'lib');
  if (process.platform === 'linux') {
    return { LD_LIBRARY_PATH: `${libDir}:${process.env.LD_LIBRARY_PATH ?? ''}` };
  }
  if (process.platform === 'darwin') {
    return { DYLD_LIBRARY_PATH: `${libDir}:${process.env.DYLD_LIBRARY_PATH ?? ''}` };
  }
  return {};
}

function spawnChild(name, cmd, args, opts = {}) {
  log(name, `spawning: ${cmd} ${args.join(' ')}`);
  const child = spawn(cmd, args, {
    stdio: ['inherit', 'inherit', 'inherit'],
    cwd: ROOT,
    ...opts,
  });
  child.on('exit', (code, signal) => {
    log(name, `exited (code=${code}, signal=${signal})`);
  });
  child.on('error', err => {
    log(name, `error: ${err.message}`);
  });
  children.push(child);
  return child;
}

function startBackend() {
  log('backend', 'starting (bun --watch)...');
  if (!hasBun()) {
    log('backend', 'ERROR: bun not found. Install Bun >= 1.1.0 first.');
    process.exit(1);
  }
  const entry = resolve(ROOT, 'src/main.ts');
  if (!existsSync(entry)) {
    log('backend', `ERROR: entry not found: ${entry}`);
    process.exit(1);
  }

  // 预检残留 PID：若 ~/.moss/moss.pid 记录的进程仍存活，
  // foreground 后端会因单例检测直接退出，提前提示用户清理。
  checkStalePid();

  const args = ['run', '--watch', entry, 'start', '--foreground', '--log-level', 'debug'];

  // 解析 bun.exe 真实路径，直接 spawn（无 shell 无 cmd.exe）。
  // 绕开 bun.cmd 批处理中间层——Windows 控制台 Ctrl+C 时执行批处理的 cmd.exe 会弹
  // "终止批处理操作吗(Y/N)?"，直接 spawn bun.exe 可彻底消除该弹窗。
  const bunExe = resolveBunExe();
  log('backend', `using bun: ${bunExe}`);
  if (bunExe === 'bun') {
    log('backend', 'Warning: bun 将以 shell 方式启动，Ctrl+C 时可能出现"终止批处理操作吗"提示');
  }
  const child = spawnChild('backend', bunExe, args, { env: { ...process.env, MOSS_DEV: '1', ...nativeLibEnv() } });
  child.once('error', err => {
    if (err.code === 'ENOENT') {
      log('backend', `${bunExe} not found, retrying with shell...`);
      const idx = children.indexOf(child);
      if (idx >= 0) children.splice(idx, 1);
      spawnChild('backend', 'bun', args, { shell: isWin, env: { ...process.env, MOSS_DEV: '1', ...nativeLibEnv() } });
    }
  });
  return child;
}

/**
 * 预检残留 PID 文件：只有当该 PID 确实是活着的 MOSS 时才提示冲突；
 * 其余情况（进程已没了 / PID 号被 svchost.exe 等系统进程复用 / 跨重启残留）
 * 一律自动清理后继续启动。绝不因残留文件阻断 dev。
 *
 * ⚠️ 本文件是纯 ESM，无法 import TS，下列判定与 src/utils/pid.ts 的
 * inspectPid / classifyPid / parseTasklistCsv 是等价实现，两处必须同步修改。
 */
function checkStalePid() {
  const pidFile = resolve(homedir(), '.moss', 'moss.pid');
  if (!existsSync(pidFile)) return;
  let info;
  try {
    info = JSON.parse(readFileSync(pidFile, 'utf8'));
  } catch {
    return;
  }
  if (!info || typeof info.pid !== 'number') return;

  const inspection = inspectPid(info);
  if (inspection.isMoss) {
    log('backend', `WARNING: live MOSS process detected (PID ${info.pid}) from ${pidFile}.`);
    log('backend', `  The foreground backend will exit due to single-instance check.`);
    log('backend', `  Run "moss stop" or kill PID ${info.pid} first, then restart dev.`);
    return;
  }

  if (inspection.reason === 'image-mismatch') {
    log('backend', `NOTE: PID ${info.pid} in ${pidFile} is held by ${inspection.imageName} (not MOSS).`);
    log('backend', `  Windows reuses PID numbers after reboot; removing the stale PID file.`);
  } else if (inspection.reason === 'stale-across-boot') {
    log('backend', `NOTE: PID file entry (PID ${info.pid}) predates this boot; removing it.`);
  } else {
    log('backend', `NOTE: stale PID file at ${pidFile} (PID ${info.pid} not alive); removing it.`);
  }

  try {
    unlinkSync(pidFile);
    log('backend', `Stale PID file removed: ${pidFile}`);
  } catch (err) {
    log('backend', `WARNING: failed to remove stale PID file: ${err.message}`);
  }
}

// ★ 以下为 src/utils/pid.ts 的等价实现（纯 ESM 无法 import TS），修改时两边同步。
const MOSS_IMAGE_NAMES = new Set(['bun.exe', 'node.exe', 'bun', 'node', 'moss.exe', 'moss']);
const BOOT_TIME_TOLERANCE_MS = 2000;

/** 严格按 CSV 前两列解析（映像名, PID），避开内存列 "34,816 K" 里的数字 */
function parseTasklistCsv(csv) {
  const map = new Map();
  for (const line of csv.split(/\r?\n/)) {
    const m = /^\s*"([^"]*)"\s*,\s*"(\d+)"\s*,/.exec(line);
    if (!m) continue;
    const pid = Number(m[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    map.set(pid, m[1]);
  }
  return map;
}

/** 查询单个 PID 的映像名；查不到返回 null */
function queryImageName(pid) {
  try {
    if (isWin) {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf8',
      });
      return parseTasklistCsv(r.stdout ?? '').get(pid) ?? null;
    }
    process.kill(pid, 0);
    return 'bun';
  } catch {
    return null;
  }
}

/** 判定 PID 文件记录的是否真为活着的 MOSS（PID 存在 ∧ 映像是运行时 ∧ 未跨重启） */
function inspectPid(info) {
  const pid = info.pid;
  const imageName = queryImageName(pid);
  if (!imageName) return { pid, alive: false, isMoss: false, imageName: null, reason: 'not-running' };
  if (!MOSS_IMAGE_NAMES.has(imageName.toLowerCase())) {
    return { pid, alive: true, isMoss: false, imageName, reason: 'image-mismatch' };
  }
  const bootTimeMs = Date.now() - uptime() * 1000;
  const startedAtMs = Date.parse(info.startedAt);
  if (
    Number.isFinite(startedAtMs) &&
    bootTimeMs > 0 &&
    startedAtMs < bootTimeMs - BOOT_TIME_TOLERANCE_MS
  ) {
    return { pid, alive: true, isMoss: false, imageName, reason: 'stale-across-boot' };
  }
  return { pid, alive: true, isMoss: true, imageName, reason: 'ok' };
}

/** 读取并确认「活着的 MOSS 后端」：返回 { pid, port }，否则 null（stale 清理仍由 checkStalePid 负责） */
function readLiveBackend() {
  const pidFile = resolve(homedir(), '.moss', 'moss.pid');
  if (!existsSync(pidFile)) return null;
  let info;
  try {
    info = JSON.parse(readFileSync(pidFile, 'utf8'));
  } catch {
    return null;
  }
  if (!info || typeof info.pid !== 'number') return null;
  const inspection = inspectPid(info);
  if (!inspection.isMoss) return null;
  const rawPort = Number(info.port);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : null;
  return { pid: info.pid, port };
}

function startFrontend(backendPort) {
  log('ui', `starting (vite in webui/)... backend=http://127.0.0.1:${backendPort}`);
  const uiDir = resolve(ROOT, 'webui');
  if (!existsSync(uiDir)) {
    log('ui', `ERROR: webui directory not found: ${uiDir}`);
    process.exit(1);
  }
  // 直接用 Node 运行 vite 的 JS 入口，绕开 Windows 上的 npm.cmd / vite.cmd 批处理。
  // 批处理在 Ctrl+C 时会弹 "终止批处理操作吗(Y/N)?"，导致退出体验恶劣。
  // 等价于 webui/package.json 的 "dev": "vite"，会读取同一 vite.config.ts（端口 3000 + 代理）。
  const viteJs = resolve(uiDir, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteJs)) {
    log('ui', `ERROR: vite not installed. Run "cd webui && npm install" first.`);
    log('ui', `  (expected: ${viteJs})`);
    process.exit(1);
  }
  log('ui', `using node: ${process.execPath}`);
  const child = spawn(process.execPath, [viteJs], {
    stdio: ['inherit', 'inherit', 'inherit'],
    cwd: uiDir,
    // 后端可能因端口占用自动漂移：把实际端口注入 Vite，代理/WS 自动跟随
    env: {
      ...process.env,
      FORCE_COLOR: '1',
      MOSS_DEV: '1',
      MOSS_BACKEND_PORT: String(backendPort),
    },
  });
  child.on('exit', (code, signal) => {
    log('ui', `exited (code=${code}, signal=${signal})`);
  });
  child.on('error', err => {
    log('ui', `error: ${err.message}`);
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function killAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('dev', 'shutting down child processes...');
  for (const c of children) {
    try {
      if (isWin) {
        // Windows: taskkill 子进程树
        spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F']);
      } else {
        c.kill('SIGTERM');
      }
    } catch {
      // ignore
    }
  }
  process.exit(0);
}

process.on('SIGINT', killAll);
process.on('SIGTERM', killAll);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** 读取 PID 文件快照（pid + 实际端口） */
function readPidSnapshot() {
  try {
    const pidFile = resolve(homedir(), '.moss', 'moss.pid');
    if (!existsSync(pidFile)) return null;
    const info = JSON.parse(readFileSync(pidFile, 'utf8'));
    const pid = Number(info?.pid);
    const port = Number(info?.port);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : null,
    };
  } catch {
    return null;
  }
}

/** 探测某个端口是否是已就绪的 MOSS（health 200） */
async function isBackendReady(port) {
  if (!port) return false;
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * 健康门控并发现实际后端端口：
 * 后端可能因 7766 被占用自动切换端口；这里以 PID 文件中的 port 为准探测，
 * 避免 Vite 仍代理旧端口导致 WebUI 全白。
 * backendChild 退出后立即结束等待（单实例冲突等场景不再空等 30 秒）。
 */
async function discoverBackendPort(configuredPort, priorPid, timeoutMs = 30000, backendChild = null) {
  let exited = false;
  const onExit = () => {
    exited = true;
  };
  backendChild?.once('exit', onExit);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited) return null;
      const snapshot = readPidSnapshot();
      const fresh = snapshot !== null && snapshot.pid !== priorPid;
      if (fresh) {
        // 本次启动新写出的 PID 记录：以其中的实际端口为准（可能已漂移）
        if (snapshot.port && (await isBackendReady(snapshot.port))) return snapshot.port;
        if (await isBackendReady(configuredPort)) return configuredPort;
      } else if (!snapshot) {
        // 无 PID 文件（残留已被清理或尚未写出）：探测配置端口
        if (await isBackendReady(configuredPort)) return configuredPort;
      }
      await sleep(250);
    }
    return null;
  } finally {
    backendChild?.off('exit', onExit);
  }
}

async function main() {
  ensureUtf8Console();
  const configuredPort = readConfiguredPort();
  console.log('=========================================');
  console.log(' MOSS Dev');
  console.log(`  Backend: http://127.0.0.1:${configuredPort}（若被占用会自动切换并同步代理）`);
  console.log(' UI: http://127.0.0.1:3000');
  console.log('  Tip: 用 "node scripts/dev.mjs" 启动可 0 弹窗（npm run dev 顶层无法消除）');
  console.log('  Tip: 若日志无 "using bun" 行，说明还在跑旧版，请重启 dev');
  console.log('  Note: dev 默认仅本机；开启远程访问后后端绑 0.0.0.0（手机可访问，页面为 dist 构建产物）');
  console.log('=========================================');
  // 已有活着的 MOSS 后端：直接复用它，不再 spawn 新后端（新后端会因单实例检查退出，
  // 且 discoverBackendPort 在 pid 未变化时会空等 30 秒才启动前端）。
  const live = readLiveBackend();
  if (live) {
    const port = live.port ?? configuredPort;
    const ready = await isBackendReady(port);
    log(
      'backend',
      `reusing running MOSS (PID ${live.pid}) on :${port}${ready ? ' (health 200)' : ' (health not ready; frontend will retry)'}`,
    );
    log('dev', 'Backend reused; code changes require "moss restart" to take effect.');
    startFrontend(port);
    log('dev', 'Press Ctrl+C to stop the frontend (backend keeps running).');
    return;
  }

  const priorPid = readPidSnapshot()?.pid ?? null;
  const backendChild = startBackend();
  log('dev', 'Waiting for backend to be ready...');
  const backendPort = await discoverBackendPort(configuredPort, priorPid, 30000, backendChild);
  if (backendPort) {
    log(
      'backend',
      backendPort === configuredPort
        ? `ready (health 200 on :${backendPort})`
        : `ready on :${backendPort}（配置端口 ${configuredPort} 被占用，已同步 Vite 代理）`,
    );
  } else if (backendChild?.exitCode !== null && backendChild?.exitCode !== undefined) {
    log('backend', 'backend exited before becoming ready; starting frontend anyway (WS proxy may error until backend is up)');
  } else {
    log('backend', `WARNING: not ready after 30s, starting frontend anyway (WS proxy may error until backend is up)`);
  }
  startFrontend(backendPort ?? configuredPort);
  log('dev', 'Press Ctrl+C to stop both.');
}

main();
