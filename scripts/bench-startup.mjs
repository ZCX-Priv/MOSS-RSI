// scripts/bench-startup.mjs
// 启动基准：spawn 生产构建产物（dist/main.js start --foreground），轮询 /api/health，
// 记录「进程 spawn → 健康可用 → agent 就绪 → 23 模块全部 active」的耗时。
//
// 用法：node scripts/bench-startup.mjs [--runs=5] [--keep]
// 说明：每次运行使用独立临时数据目录（MOSS_DATA_DIR），不会污染真实 ~/.moss；
//       端口自动选择空闲值并写入临时 config.json，避免与已运行的 MOSS 冲突。

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ENTRY = join(ROOT, 'dist', 'main.js');
const RUNS = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 5);
const KEEP = process.argv.includes('--keep');

if (!existsSync(ENTRY)) {
  console.error(`[bench] 找不到 ${ENTRY}，请先执行 npm run build`);
  process.exit(1);
}

/** 解析 bun 真实可执行文件（npm 全局 shim 下 Node spawn('bun') 会 ENOENT） */
function resolveBun() {
  const exe = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const candidates = [];
  if (process.env.BUN_INSTALL) candidates.push(join(process.env.BUN_INSTALL, 'bin', exe));
  candidates.push(join(homedir(), '.bun', 'bin', exe));
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    candidates.push(join(dir, exe));
    candidates.push(join(dir, 'node_modules', 'bun', 'bin', exe));
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

const BUN = resolveBun();
if (!BUN) {
  console.error('[bench] 未找到 bun 可执行文件，请安装 Bun >= 1.1.0');
  process.exit(1);
}

function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolvePort(port));
    });
  });
}

function prepareDataDir(port) {
  const dir = join(tmpdir(), `moss-bench-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(dir, 'config'), { recursive: true });
  for (const name of ['config.json', 'api.json']) {
    const src = join(ROOT, 'config', name);
    if (!existsSync(src)) continue;
    const dest = join(dir, 'config', name);
    if (name === 'config.json') {
      const cfg = JSON.parse(readFileSync(src, 'utf8'));
      cfg.server = { ...cfg.server, host: '127.0.0.1', port, autoPort: false };
      writeFileSync(dest, JSON.stringify(cfg, null, 2));
    } else {
      cpSync(src, dest);
    }
  }
  return dir;
}

async function pollHealth(port, deadlineMs) {
  const startedAt = Date.now();
  const deadline = startedAt + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(250),
      });
      if (resp.ok) return { at: Date.now(), body: await resp.json() };
    } catch {
      // 启动窗口内连接失败属正常
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // 静默
  }
}

async function runOnce(runIndex) {
  const port = await findFreePort();
  const dataDir = prepareDataDir(port);
  const logPath = join(dataDir, 'logs', 'moss-bench.log');
  const bootAt = Date.now();
  const child = spawn(BUN, [ENTRY, 'start', '--foreground'], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      MOSS_DATA_DIR: dataDir,
      MOSS_BOOT_AT: String(bootAt),
      MOSS_STARTUP_QUIET: '1',
    },
  });

  let health = null;
  let allActiveAt = null;
  let modulesTotal = 0;
  try {
    health = await pollHealth(port, 120_000);
    if (!health) throw new Error('120s 内健康检查未就绪');
    // 预期模块总数：正常启动为 23（critical 12 + deferred 11）。
    // 只等所有已枚举模块 active 会在 deferred 尚未加载时提前收工，必须要求总数达标。
    const EXPECTED_MODULES = 23;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const list = Object.values(health.body.moduleStates ?? {});
      modulesTotal = list.length;
      if (list.length >= EXPECTED_MODULES && list.every((s) => s === 'active')) {
        allActiveAt = health.at;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
      const next = await pollHealth(port, 2_000);
      if (next) health = next;
    }
  } finally {
    killTree(child);
  }

  const tHealth = health ? health.at - bootAt : null;
  const tAllActive = allActiveAt ? allActiveAt - bootAt : null;
  const summary = health?.body.startup ?? null;

  if (!KEEP) {
    // 保留日志便于失败排查（成功时整体删除）
    if (tHealth !== null) rmSync(dataDir, { recursive: true, force: true });
    else console.log(`[bench] 失败数据目录保留：${dataDir}`);
  } else {
    console.log(`[bench] 数据目录保留：${dataDir}`);
  }

  return {
    run: runIndex,
    tHealth,
    tAllActive,
    agentReady: health?.body.agentReady ?? false,
    modules: modulesTotal,
    activeModules: Object.values(health?.body.moduleStates ?? {}).filter((s) => s === 'active').length,
    fromSpawnMs: summary?.fromSpawnMs ?? null,
    maxLagMs: summary?.maxEventLoopLagMs ?? null,
    logPath: existsSync(logPath) ? logPath : null,
  };
}

function pct(values, p) {
  const arr = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
  return arr[idx];
}

const results = [];
for (let i = 1; i <= RUNS; i++) {
  const r = await runOnce(i);
  results.push(r);
  console.log(
    `[bench] run ${i}: health=${r.tHealth}ms allActive=${r.tAllActive}ms agentReady=${r.agentReady} modules=${r.activeModules}/${r.modules} lagMax=${r.maxLagMs}ms`,
  );
}

const healthTimes = results.map((r) => r.tHealth);
const activeTimes = results.map((r) => r.tAllActive);
const cold = healthTimes[0] ?? null;
const p50 = pct(healthTimes, 50);
const p95 = pct(healthTimes, 95);
const activeP95 = pct(activeTimes, 95);

console.log('\n[bench] ===== 汇总 =====');
console.log(`[bench] health: cold=${cold}ms P50=${p50}ms P95=${p95}ms`);
console.log(`[bench] 全模块 active P95=${activeP95}ms`);
if (typeof activeP95 === 'number' && activeP95 > 3000) {
  console.error('[bench] 未达到 3s 目标（全模块 active P95 > 3000ms）');
  process.exitCode = 1;
}
