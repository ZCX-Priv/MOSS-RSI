// src/modules/tools/terminal/raw-run.ts
// terminal raw 模式：非 PTY 的一次性子进程，直接捕获 stdout/stderr 原始字节。
//
// 为什么需要它：持久终端是「给人看的屏幕」，PTY 会按列宽硬折行（Windows ConPTY 默认 80 列），
// JSON/CSV/长行输出会被切断（会话 30fca18c 中解析 JSON 失败的根因）。
// raw 模式不经过终端模拟器，所以零折行、零回显；代价是不保留 shell 状态（cd/环境变量不跨调用）。

import { resolveInterpreter } from '../../terminal/interpreter';
import type { InterpreterKind } from '../../terminal/types';

export interface RawRunOptions {
  command: string;
  /** 绝对路径工作目录 */
  cwd: string;
  /** 解释器（缺省用平台默认，与终端工具一致） */
  interpreter?: InterpreterKind;
  timeoutMs: number;
  signal?: AbortSignal;
  /** 捕获上限：仅防 OOM 的崩溃保护，默认 32MB */
  maxCaptureBytes?: number;
}

export interface RawRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** 输出超过捕获上限（不是 PTC 输出预算） */
  truncated: boolean;
  durationMs: number;
  interpreterLabel: string;
}

const DEFAULT_MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

/** 构造非 PTY 一次性调用参数（不要复用交互式 -i / -NoExit） */
function buildRawInvocation(
  shell: 'powershell' | 'cmd' | 'bash' | 'zsh',
  bin: string,
  command: string,
): string[] {
  switch (shell) {
    case 'powershell':
      return [
        bin,
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${command}`,
      ];
    case 'cmd':
      return [bin, '/d', '/s', '/c', `chcp 65001>nul & ${command}`];
    case 'bash':
    case 'zsh':
      return [bin, '-c', command];
  }
}

/** Bun.spawn 返回进程的最小结构（避免依赖 bun-types 的内部泛型名） */
interface RawProcessLike {
  pid: number;
  kill(signal?: number | NodeJS.Signals): void;
}

/** 杀掉进程与子进程树（Windows 用 taskkill /T，POSIX 用 SIGKILL） */
function killTree(proc: RawProcessLike, isWindows: boolean): void {
  try {
    proc.kill('SIGKILL');
  } catch {
    // 已退出
  }
  if (!isWindows) return;
  try {
    Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(proc.pid)], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
  } catch {
    // taskkill 不可用/进程已消失：忽略
  }
}

/** 执行一条命令并返回原始输出（不折行、不回显）。 */
export async function runCommandRaw(opts: RawRunOptions): Promise<RawRunResult> {
  const startedAt = Date.now();
  const isWindows = process.platform === 'win32';
  const interpreter = resolveInterpreter(isWindows, opts.interpreter);
  const argv = buildRawInvocation(interpreter.shell, interpreter.bin, opts.command);
  const maxCaptureBytes = Math.max(1_024, opts.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES);

  let stdout = '';
  let stderr = '';
  let capturedBytes = 0;
  let truncated = false;
  let timedOut = false;
  let aborted = false;

  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });

  const stop = (): void => {
    killTree(proc, isWindows);
  };

  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timedOut = true;
    stop();
  }, Math.max(1_000, opts.timeoutMs));

  const onAbort = (): void => {
    aborted = true;
    stop();
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      aborted = true;
      stop();
    } else {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const readStream = async (stream: ReadableStream<Uint8Array>, isStderr: boolean): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (capturedBytes >= maxCaptureBytes) {
          truncated = true;
          stop();
          continue;
        }
        const text = decoder.decode(value, { stream: true });
        const bytes = Buffer.byteLength(text, 'utf8');
        capturedBytes += bytes;
        if (isStderr) stderr += text;
        else stdout += text;
        if (capturedBytes > maxCaptureBytes) {
          truncated = true;
          stop();
        }
      }
      const tail = decoder.decode();
      if (tail) {
        if (isStderr) stderr += tail;
        else stdout += tail;
      }
    } catch {
      // 进程被杀/流关闭：保留已捕获内容
    }
  };

  try {
    await Promise.all([readStream(proc.stdout, false), readStream(proc.stderr, true), proc.exited]);
  } finally {
    if (timer) clearTimeout(timer);
    timer = null;
    opts.signal?.removeEventListener('abort', onAbort);
  }

  return {
    stdout,
    stderr,
    exitCode: proc.exitCode ?? null,
    timedOut,
    aborted,
    truncated,
    durationMs: Date.now() - startedAt,
    interpreterLabel: interpreter.label,
  };
}
