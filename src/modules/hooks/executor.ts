// src/modules/hooks/executor.ts
// 钩子执行器：终端命令（JSON stdin/stdout 协议）与 TS 模块（Bun 动态 import）。
// 决策协议：
//   exit 0 = 放行（stdout 可为 JSON {decision,reason} 结构化决策）
//   exit 2 = 阻止（stderr 作为原因反馈给 LLM）
//   其他 exit / 超时 / 异常 = fail-open 放行 + 告警（用户扩展不能瘫痪主循环）
// TS 模块：export default async (input) => ({decision, reason}) | void

import { statSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import type { Environment, Logger } from '../../core/types';
import type { HookInput, HookOutput, ScopedHookRecord } from './types';
import { scriptsDir } from './storage';

/** TS 模块钩子的模块签名 */
export interface HookModule {
  default: (input: HookInput) => Promise<HookOutput | void> | HookOutput | void;
}

export interface HookExecutionOutcome {
  ok: boolean;
  output: HookOutput | null;
  /** 原始 stdout（SessionStart/Stop 事件的上下文注入文本） */
  stdout: string;
  error?: string;
  durationMs: number;
}

/** 命令行 ~ 展开与变量环境 */
function expandCommand(command: string, env: Environment, cwd: string): string {
  let cmd = command;
  if (cmd.startsWith('~/') || cmd.startsWith('~\\') || cmd === '~') {
    cmd = env.homeDir + cmd.slice(1);
  }
  return cmd;
}

/** 解析 stdout 为结构化决策（无 JSON 返回 null） */
function parseStructuredOutput(stdout: string): HookOutput | null {
  const trimmed = stdout.trim();
  if (trimmed === '') return null;
  // 容错提取：找首个 { 到末个 } 的 JSON 对象
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Partial<HookOutput>;
    if (parsed.decision === 'allow' || parsed.decision === 'deny') {
      return { decision: parsed.decision, ...(parsed.reason ? { reason: parsed.reason } : {}) };
    }
  } catch {
    // 非 JSON stdout：视为纯文本
  }
  return null;
}

/** 终端命令执行（带超时） */
async function execTerminal(
  command: string,
  input: HookInput,
  timeoutMs: number,
  env: Environment,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const interpreter = env.isWindows ? 'cmd' : 'sh';
  const argFlag = env.isWindows ? '/c' : '-c';
  const proc = Bun.spawn([interpreter, argFlag, command], {
    cwd: input.cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, MOSS_HOOK_EVENT: input.event, MOSS_SESSION_ID: input.sessionId },
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, Math.max(1000, timeoutMs));

  try {
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** TS 模块缓存（路径 → {mtime, module}；文件变更即失效） */
const moduleCache = new Map<string, { mtimeMs: number; mod: HookModule }>();

/** 加载 TS 模块钩子（Bun.import + mtime 缓存） */
async function loadHookModule(modulePath: string, hooksDir: string): Promise<HookModule> {
  const abs = isAbsolute(modulePath) ? modulePath : resolvePath(scriptsDir(hooksDir), modulePath);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(abs).mtimeMs;
  } catch {
    throw new Error(`hook module not found: ${modulePath}`);
  }
  const cached = moduleCache.get(abs);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.mod;
  }
  const mod = (await import(`file://${abs.replace(/\\/g, '/')}`)) as HookModule;
  if (typeof mod.default !== 'function') {
    throw new Error(`hook module has no default export: ${modulePath}`);
  }
  moduleCache.set(abs, { mtimeMs, mod });
  return mod;
}

/**
 * 执行单个钩子（统一超时与 fail-open 语义）。
 * @param hooksDir 钩子所属作用域目录（module 相对路径解析基准）
 */
export async function executeHook(
  hook: ScopedHookRecord,
  input: HookInput,
  opts: {
    env: Environment;
    logger: Logger;
    defaultTimeout: number;
    hooksDir: string;
  },
): Promise<HookExecutionOutcome> {
  const startedAt = Date.now();
  const timeoutMs = hook.timeout > 0 ? hook.timeout : opts.defaultTimeout;

  try {
    if (hook.type === 'terminal') {
      if (!hook.command) {
        return { ok: false, output: null, stdout: '', error: 'empty command', durationMs: 0 };
      }
      const { exitCode, stdout, stderr, timedOut } = await execTerminal(
        expandCommand(hook.command, opts.env, input.cwd),
        input,
        timeoutMs,
        opts.env,
      );
      const durationMs = Date.now() - startedAt;

      if (timedOut) {
        return {
          ok: false,
          output: null,
          stdout,
          error: `timed out after ${timeoutMs}ms`,
          durationMs,
        };
      }
      if (exitCode === 2) {
        return {
          ok: true,
          output: {
            decision: 'deny',
            reason: stderr.trim() || `blocked by hook ${hook.name}`,
          },
          stdout,
          durationMs,
        };
      }
      if (exitCode !== 0) {
        return {
          ok: false,
          output: null,
          stdout,
          error: `exit code ${exitCode}: ${stderr.trim()}`,
          durationMs,
        };
      }
      return {
        ok: true,
        output: parseStructuredOutput(stdout),
        stdout,
        durationMs,
      };
    }

    // TS 模块钩子
    const mod = await loadHookModule(hook.modulePath, opts.hooksDir);
    const result = await Promise.race([
      Promise.resolve(mod.default(input)),
      new Promise<HookOutput | void>(resolve =>
        setTimeout(() => resolve(undefined), timeoutMs),
      ),
    ]);
    const durationMs = Date.now() - startedAt;
    if (result && (result.decision === 'allow' || result.decision === 'deny')) {
      return { ok: true, output: result, stdout: '', durationMs };
    }
    return { ok: true, output: null, stdout: '', durationMs };
  } catch (err) {
    return {
      ok: false,
      output: null,
      stdout: '',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}
