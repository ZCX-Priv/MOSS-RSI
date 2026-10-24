// src/cli/commands.ts
// CLI 命令路由：start/stop/status/restart/mcp/update/version

import { Microkernel } from '../core/kernel';
import { detectEnvironment } from '../core/env';
import {
  readPidFile,
  removePidFile,
  inspectPid,
  killProcess,
  writePidFile,
  currentProcessIdentity,
  type PidInspection,
} from '../utils/pid';
import { ServiceNames, type LogLevel, type Logger } from '../core/types';
import type { ServerInstance } from '../modules/server/types';
import { startMcpStdio } from '../modules/mcp/stdio';
import { t } from '../core/i18n';

export interface ParsedArgs {
  command: string;
  foreground: boolean;
  logLevel?: LogLevel;
  /** 额外参数 */
  rest: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // 跳过 node/bun + script
  if (args.length === 0) {
    return { command: 'start', foreground: false, rest: [] };
  }

  let command = 'start';
  const rest: string[] = [];
  let foreground = false;
  let logLevel: LogLevel | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--foreground' || a === '-f') {
      foreground = true;
    } else if (a === '--log-level' || a === '-l') {
      logLevel = args[++i] as LogLevel;
    } else if (!a.startsWith('-')) {
      // 第一个非 flag 参数是命令
      if (command === 'start' && rest.length === 0) {
        command = a;
      } else {
        rest.push(a);
      }
    } else {
      rest.push(a);
    }
  }

  return { command, foreground, logLevel, rest };
}

const VALID_COMMANDS = new Set([
  'start',
  'stop',
  'status',
  'restart',
  'update',
  'version',
  'help',
  'mcp',
]);

export async function runCommand(parsed: ParsedArgs): Promise<number> {
  const { command } = parsed;
  if (!VALID_COMMANDS.has(command)) {
    console.error(t('cli.unknownCommand', { command }));
    printHelp();
    return 1;
  }

  switch (command) {
    case 'start':
      return cmdStart(parsed);
    case 'stop':
      return cmdStop();
    case 'status':
      return cmdStatus();
    case 'restart':
      return cmdRestart();
    case 'update':
      return cmdUpdate();
    case 'version':
      return cmdVersion();
    case 'mcp':
      return cmdMcp(parsed);
    case 'help':
      printHelp();
      return 0;
    default:
      return 1;
  }
}

// ============================================================================
// 各命令实现
// ============================================================================

async function cmdStart(parsed: ParsedArgs): Promise<number> {
  const env = detectEnvironment();

  // 单例检测：必须是「活着的 MOSS」才算真的在运行。
  // 只判 PID 存在会把 Windows 重启后复用该号的 svchost.exe 当成 MOSS，导致
  // 明明没跑也弹「已在运行」并直接退出。
  const existing = readPidFile(env.pidFile);
  if (existing) {
    const inspection = inspectPid(existing);
    if (inspection.isMoss) {
      console.error(t('cli.alreadyRunning', { pid: existing.pid }));
      console.error(t('cli.useStatusOrRestart'));
      return 1;
    }
    // 过期 / 被他人占用：自动清理并继续启动（绝不因残留文件阻断 dev）。
    logStalePid(inspection);
    removePidFile(env.pidFile);
  }

  // 前台模式：直接启动内核
  if (parsed.foreground) {
    return startForeground(parsed);
  }

  // 后台守护进程模式：fork 子进程后父进程退出
  return startDaemon();
}

async function startForeground(parsed: ParsedArgs): Promise<number> {
  const env = detectEnvironment();
  const kernel = new Microkernel();
  try {
    const ctx = await kernel.start({
      foreground: true,
      logLevel: parsed.logLevel,
    });

    // 进程级异常兜底（守护进程保活）必须在服务对外可用后立即生效：
    // 长程任务（小时级 / 数千轮工具调用）期间任意一处逃逸异常都不应让整台机器上
    // 所有任务一起丢。仅常驻服务路径注册，`moss mcp`（stdio，客户端托管）保持默认行为。
    installProcessGuards(ctx.logger);

    // 从 ServerInstance 服务读取实际监听端口，写入 PID 文件（修复 moss status 不显示端口的 bug）
    const serverInstance = ctx.services.tryResolve<ServerInstance>(ServiceNames.SERVER_INSTANCE);
    const port = serverInstance?.port;

    // 写 PID 文件
    writePidFile(env.pidFile, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      port,
      ...currentProcessIdentity(),
    });

    console.log(t('cli.started', { pid: process.pid }));

    // 注册退出钩子
    const cleanup = async () => {
      await kernel.stop();
      removePidFile(env.pidFile);
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('SIGHUP', cleanup);

    // 保持进程运行
    return new Promise<number>(() => {
      // 永不 resolve，由信号处理退出
    });
  } catch (err) {
    console.error(t('cli.failedToStart', { error: err instanceof Error ? err.message : String(err) }));
    await kernel.stop().catch(() => {});
    return 1;
  }
}

async function startDaemon(): Promise<number> {
  const env = detectEnvironment();
  // 用 Bun.spawn detached 模式启动子进程
  // 子进程执行 moss start --foreground
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const BunAny = Bun as any;
  const args = [process.argv[1], 'start', '--foreground'];
  const subprocess = BunAny.spawn({
    cmd: [process.execPath, ...args],
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
    windowsHide: true,
  });
  // 父进程 unref 后退出
  try {
    subprocess.unref?.();
  } catch {
    // 静默
  }

  // 等待子进程写 PID 文件（最多 5 秒）；同样要求身份校验通过，避免把复用该号的
  // 系统进程误认为刚拉起的守护进程。
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const info = readPidFile(env.pidFile);
    if (info && inspectPid(info).isMoss) {
      console.log(t('cli.daemonStarted', { pid: info.pid }));
      return 0;
    }
    await sleep(200);
  }
  console.error(t('cli.daemonPidFileMissing'));
  return 1;
}

/**
 * 打印 PID 文件失效的具体原因。
 * 开机后常见情形是 reason=image-mismatch（PID 号被 svchost.exe 等系统进程复用），
 * 此时必须让用户看清楚「不是 MOSS 占了号」，而不是笼统报「已在运行」。
 */
function logStalePid(inspection: PidInspection): void {
  switch (inspection.reason) {
    case 'image-mismatch':
      console.error(
        t('cli.pidReusedByOther', {
          pid: inspection.pid,
          imageName: inspection.imageName ?? 'unknown',
        }),
      );
      break;
    case 'stale-across-boot':
      console.error(t('cli.pidStaleAcrossBoot', { pid: inspection.pid }));
      break;
    case 'not-running':
      console.error(t('cli.processNotAlive', { pid: inspection.pid }));
      break;
    default:
      break;
  }
}

async function cmdStop(): Promise<number> {
  const env = detectEnvironment();
  const info = readPidFile(env.pidFile);
  if (!info) {
    console.log(t('cli.notRunningNoPid'));
    return 0;
  }

  const inspection = inspectPid(info);
  if (!inspection.isMoss) {
    // ⚠️ 身份不符时绝不调用 killProcess：该号可能已被 svchost.exe 等系统进程复用，
    // taskkill /T /F 会直接打穿系统服务。只清理过期 PID 文件。
    logStalePid(inspection);
    removePidFile(env.pidFile);
    console.log(t('cli.stalePidCleaned', { pid: info.pid }));
    return 0;
  }

  console.log(t('cli.stopping', { pid: info.pid }));
  const ok = await killProcess(info.pid, 5000, info);
  if (ok) {
    removePidFile(env.pidFile);
    console.log(t('cli.stopped'));
    return 0;
  }
  console.error(t('cli.failedToStop'));
  return 1;
}

async function cmdStatus(): Promise<number> {
  const env = detectEnvironment();
  const info = readPidFile(env.pidFile);
  if (!info) {
    console.log(t('cli.statusNotRunningNoPid'));
    return 0;
  }
  const alive = inspectPid(info);
  if (!alive.isMoss) {
    // 区分「进程已没了」与「该号被其他程序占用」，避免用户对着 svchost 的 PID 发愁。
    if (alive.reason === 'image-mismatch') {
      console.log(
        t('cli.statusPidReused', {
          pid: info.pid,
          imageName: alive.imageName ?? 'unknown',
        }),
      );
    } else if (alive.reason === 'stale-across-boot') {
      console.log(t('cli.statusPidStaleAcrossBoot', { pid: info.pid }));
    } else {
      console.log(t('cli.statusNotRunningStalePid', { pid: info.pid }));
    }
    return 0;
  }
  console.log(t('cli.statusRunning'));
  console.log(t('cli.statusPid', { pid: info.pid }));
  console.log(t('cli.statusStartedAt', { startedAt: info.startedAt }));
  if (info.port) console.log(t('cli.statusPort', { port: info.port }));
  console.log(t('cli.statusDataDir', { dataDir: env.dataDir }));

  // 尝试通过 /api/health 获取运行时信息（模块计数、服务列表）
  if (info.port) {
    const health = await fetchHealthInfo(info.port).catch(() => null);
    if (health) {
      const moduleCount = typeof health.modules === 'number' ? health.modules : 0;
      const serviceCount = Array.isArray(health.services) ? health.services.length : 0;
      console.log(t('cli.statusModules', { count: moduleCount }));
      console.log(t('cli.statusServices', { count: serviceCount }));
    }
  }
  return 0;
}

interface HealthInfo {
  modules?: number;
  services?: string[];
}

/** 调用本地 /api/health 获取运行时统计 */
async function fetchHealthInfo(port: number): Promise<HealthInfo | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as HealthInfo & { status?: string };
    return data;
  } catch {
    return null;
  }
}

async function cmdRestart(): Promise<number> {
  const stopCode = await cmdStop();
  // 即使 stop 失败也尝试 start
  await sleep(500);
  const startCode = await cmdStart({ command: 'start', foreground: false, rest: [] });
  return startCode === 0 ? 0 : startCode;
}

async function cmdUpdate(): Promise<number> {
  console.log(t('cli.updateHint'));
  return 0;
}

async function cmdVersion(): Promise<number> {
  // 从 package.json 读取版本
  try {
    const env = detectEnvironment();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs');
    const pkgPath = path.join(env.packageRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    console.log(t('cli.versionMoss', { version: pkg.version }));
    console.log(t('cli.versionRuntime', { version: env.runtimeVersion }));
    console.log(t('cli.versionPlatform', { platform: env.platform, arch: env.arch }));
    return 0;
  } catch (err) {
    console.error(t('cli.failedToReadVersion', { error: err instanceof Error ? err.message : String(err) }));
    return 1;
  }
}

/**
 * `moss mcp`：以 stdio 方式启动 MCP 服务器（供 Claude Desktop / Cursor 等客户端调用）。
 *
 * 与 start 的关键差异：
 * - stdout 是 MCP 协议通道 → 必须先把 console 改道到 stderr，否则日志会污染协议流；
 * - 不起 HTTP 服务（禁用 server/remote），避免与常驻 MOSS 抢端口；daemon/update 与 stdio
 *   会话无关（automation 模块保留，但会因 MOSS_STDIO_MCP 跳过调度器以避免重复触发）；
 * - 不写 PID 文件、不做单例检测（不是守护进程，由客户端拉起）。
 */
async function cmdMcp(parsed: ParsedArgs): Promise<number> {
  redirectConsoleToStderr();
  // 标记 stdio 模式：automation 模块据此跳过调度器（避免与常驻 MOSS 重复触发定时任务）
  process.env.MOSS_STDIO_MCP = '1';
  const kernel = new Microkernel();
  try {
    const ctx = await kernel.start({
      foreground: true,
      logLevel: parsed.logLevel,
      // 不起 HTTP 服务（会与常驻 MOSS 抢端口）；daemon/update 与 stdio 会话无关
      disabledModules: ['server', 'remote', 'daemon', 'update', 'browser'],
    });

    const server = await startMcpStdio(ctx);
    console.error(t('cli.mcpStarted'));

    const cleanup = async (): Promise<void> => {
      await server.close().catch(() => {});
      await kernel.stop().catch(() => {});
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('SIGHUP', cleanup);

    // 常驻：客户端关闭 stdin（断开连接）时由 SDK 结束进程
    return new Promise<number>(() => {
      // 永不 resolve，由信号或 stdin 关闭退出
    });
  } catch (err) {
    console.error(t('cli.mcpFailed', { error: err instanceof Error ? err.message : String(err) }));
    await kernel.stop().catch(() => {});
    return 1;
  }
}

/**
 * 把 console.log/info/debug 改道到 stderr。
 * stdio MCP 传输要求 stdout 只承载 JSON-RPC 消息，而内核与依赖库会往 stdout 打日志；
 * 改道必须发生在 kernel.start() 之前（否则第一条启动日志就已污染协议流）。
 * console.warn/error 本就写 stderr，无需处理。
 */
function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(args.map(formatConsoleArg).join(' ') + '\n');
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

function formatConsoleArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.message;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/**
 * 注册进程级异常兜底（守护进程保活，仅常驻服务路径调用）。
 *
 * 背景：Bun 对未捕获异常 / 未处理拒绝默认终止进程。长程任务（小时级、数千轮工具调用）
 * 期间任意一处逃逸异常（定时器回调 / 事件监听 / fire-and-forget Promise）都会让守护进程
 * 直接死掉 —— 用户侧表现为「长任务跑一半自己停了 + 后端没了 + 前端永久停在响应中」。
 * 这里改为「记录完整堆栈 + 计数 + 不退出」：单点异常不应让整机长任务全部丢失。
 * 前端另有生成态看门狗兜底（后端权威态对账），因此不必在此广播事件。
 */
function installProcessGuards(logger: Logger): void {
  let crashCount = 0;
  const report = (kind: string, err: unknown): void => {
    crashCount++;
    const detail =
      err instanceof Error
        ? { message: err.message, stack: err.stack }
        : { message: String(err) };
    logger.error(`process:${kind} (kept alive, total=${crashCount})`, detail);
    if (crashCount === 20 || crashCount === 100) {
      logger.error(
        `process:${kind} 频繁发生（累计 ${crashCount} 次）：守护进程仍在运行但稳定性已受影响，建议导出 ~/.moss/logs 排查`,
      );
    }
  };
  process.on('uncaughtException', (err) => report('uncaughtException', err));
  process.on('unhandledRejection', (reason) => report('unhandledRejection', reason));
}

function printHelp(): void {
  console.log(t('cli.helpText'));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
