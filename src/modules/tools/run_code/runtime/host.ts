// src/modules/tools/run_code/runtime/host.ts
// run_code 宿主：Bun.spawn 子进程 + 行分隔 JSON-RPC + 调度池 + 超时/中止/限额。
//
// 安全模型（必须诚实）：子进程能硬超时/强杀，避免死循环阻塞主服务；但这不是多租户安全沙箱。
// 程序仍以当前用户权限运行，真正的安全边界是外层 run_code 的确认卡 + 嵌套工具逐次 safety 决策。

import { existsSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { Logger } from '../../../../core/types';
import type { ToolResult } from '../../types';
import {
  byteLength,
  CALL_ID_RE,
  encodeFrame,
  isLosslessJsonValue,
  MAX_FRAME_BYTES,
  parseFrameLine,
  TOOL_CALL_ERROR_NAME,
  truncateToBytes,
  type ChildToHost,
  type CodeFailureKind,
  type CodeValue,
  type HostToChild,
  type RunLimits,
} from './protocol';
import { toolResultErrorMessage, toolResultText, toolResultToCodeValue } from './value';

export interface CodeRunCallRecord {
  id: string;
  name: string;
  argsPreview: string;
  resultPreview: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  /** 完整入参 JSON（≤16KB；前端合成 ToolCall.arguments 复原预览/源码） */
  argumentsJson?: string;
  /** 结果正文（≤32KB；前端合成 ToolResult.content） */
  resultText?: string;
  /** 结果 metadata（diff / terminal / 搜索结果等富预览依据，单条 ≤64KB） */
  resultMetadata?: ToolResult['metadata'];
}

export interface RunCodeHostOptions {
  program: string;
  bindings: string[];
  cwd: string;
  limits: RunLimits;
  uiEnabled: boolean;
  signal?: AbortSignal;
  /** 由 AgentEngine 注入：完整 safety/hooks 管线后的工具结果 */
  invokeTool: (name: string, args: unknown, opts: { callId: string; signal: AbortSignal }) => Promise<ToolResult>;
  /** 保守并发判定：只有 readOnly 且非 destructive 的工具可重叠 */
  isConcurrencySafe: (name: string) => boolean;
  logger?: Logger;
}

export interface RunCodeHostResult {
  value?: CodeValue;
  logs: string[];
  ui?: unknown;
  uiDiagnostics?: unknown;
  nestedCalls: number;
  hasUi: boolean;
  calls: CodeRunCallRecord[];
  callsTruncated: boolean;
  error?: { kind: CodeFailureKind; message: string };
  durationMs: number;
  truncated: boolean;
}

/** Bun.spawn 的子进程最小结构（stdio 为 pipe 时的实际形状；避免 ReturnType 重载联合） */
interface ChildProcessLike {
  stdin: { write(data: string): number; flush(): Promise<unknown>; end(): void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  pid: number;
  kill(signal?: number | NodeJS.Signals): void;
}

/** 子进程日志/结果共享的预算上限 */
const MAX_LOG_ENTRY_BYTES = 16_384;
const MAX_CALL_RECORDS = 100;
/** 嵌套调用富数据（供前端渲染普通工具卡） */
const MAX_CALL_ARG_BYTES = 16 * 1024;
const MAX_CALL_RESULT_TEXT_BYTES = 32 * 1024;
const MAX_CALL_METADATA_BYTES = 64 * 1024;
/** 单次 run_code 所有嵌套调用富数据总量：超限后退回 preview 简版，避免 transcript 膨胀 */
const MAX_CALL_DETAIL_TOTAL_BYTES = 192 * 1024;
const STDERR_CAP_BYTES = 8_192;
const EXIT_GRACE_MS = 150;
const EXIT_HARD_WAIT_MS = 800;

/** 执行一段程序；程序失败作为 result.error 返回，不 reject。 */
export async function runCodeProgram(opts: RunCodeHostOptions): Promise<RunCodeHostResult> {
  const startedAt = performance.now();
  const bootstrapPath = resolvePath(import.meta.dir, 'bootstrap.ts');
  if (!existsSync(bootstrapPath)) {
    return {
      logs: [],
      calls: [],
      callsTruncated: false,
      nestedCalls: 0,
      hasUi: false,
      durationMs: 0,
      truncated: false,
      error: {
        kind: 'sandbox-unavailable',
        message: `runtime bootstrap not found: ${bootstrapPath}`,
      },
    };
  }

  if (opts.signal?.aborted) {
    return {
      logs: [],
      calls: [],
      callsTruncated: false,
      nestedCalls: 0,
      hasUi: false,
      durationMs: Math.round(performance.now() - startedAt),
      truncated: false,
      error: { kind: 'abort', message: 'aborted before execution' },
    };
  }

  const cwd = resolveCwd(opts.cwd);
  const runController = new AbortController();
  const logs: string[] = [];
  const calls: CodeRunCallRecord[] = [];
  let callsTruncated = false;
  let logBytes = 0;
  let callDetailBytes = 0;
  let stderr = '';
  let finished = false;
  let runSent = false;
  let hasUi = false;

  let child: ChildProcessLike;
  try {
    child = Bun.spawn([process.execPath, bootstrapPath], {
      cwd,
      env: minimalEnv(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }) as unknown as ChildProcessLike;
  } catch (err) {
    return {
      logs: [],
      calls: [],
      callsTruncated: false,
      nestedCalls: 0,
      hasUi: false,
      durationMs: Math.round(performance.now() - startedAt),
      truncated: false,
      error: {
        kind: 'sandbox-unavailable',
        message: `failed to spawn Bun subprocess: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const bindingSet = new Set(opts.bindings);

  return await new Promise<RunCodeHostResult>((resolvePromise) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const writeFrame = (frame: HostToChild): boolean => {
      if (finished) return false;
      const line = encodeFrame(frame);
      if (byteLength(line) > MAX_FRAME_BYTES) {
        void settle({
          logs,
          calls,
          callsTruncated,
          nestedCalls: calls.length,
          hasUi,
          truncated: true,
          error: { kind: 'protocol', message: `frame exceeds ${MAX_FRAME_BYTES} bytes` },
        });
        return false;
      }
      try {
        child.stdin.write(line);
        void child.stdin.flush();
        return true;
      } catch (err) {
        void settle({
          logs,
          calls,
          callsTruncated,
          nestedCalls: calls.length,
          hasUi,
          truncated: true,
          error: {
            kind: 'worker-exit',
            message: `failed to write control frame: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
        return false;
      }
    };

    const appendLog = (text: string): void => {
      if (finished) return;
      const clean = truncateToBytes(text, MAX_LOG_ENTRY_BYTES);
      const bytes = byteLength(clean) + 1;
      if (logBytes + bytes > opts.limits.maxOutputBytes) {
        void settle({
          logs,
          calls,
          callsTruncated,
          nestedCalls: calls.length,
          hasUi,
          truncated: true,
          error: {
            kind: 'output-limit',
            message: `logs exceeded maxOutputBytes (${opts.limits.maxOutputBytes})`,
          },
        });
        return;
      }
      logBytes += bytes;
      logs.push(clean);
    };

    const recordCall = (record: CodeRunCallRecord): void => {
      if (calls.length >= MAX_CALL_RECORDS) {
        callsTruncated = true;
        return;
      }
      calls.push(record);
    };

    /**
     * 嵌套调用的富数据（前端复用普通工具卡渲染）。
     * 单条按字段上限裁剪，整次 run_code 再受总预算约束；超预算的调用退回 preview 简版。
     */
    const collectCallDetails = (
      args: unknown,
      result?: ToolResult,
      fallbackText?: string,
    ): Pick<CodeRunCallRecord, 'argumentsJson' | 'resultText' | 'resultMetadata'> => {
      const argumentsJson = safeJsonText(args, MAX_CALL_ARG_BYTES);
      const rawText = result ? toolResultText(result) : (fallbackText ?? '');
      const resultText = rawText ? truncateToBytes(rawText, MAX_CALL_RESULT_TEXT_BYTES) : undefined;
      const resultMetadata = capCallMetadata(result?.metadata);
      const bytes =
        (argumentsJson ? byteLength(argumentsJson) : 0) +
        (resultText ? byteLength(resultText) : 0) +
        (resultMetadata ? byteLength(JSON.stringify(resultMetadata)) : 0);
      if (callDetailBytes + bytes > MAX_CALL_DETAIL_TOTAL_BYTES) return {};
      callDetailBytes += bytes;
      return {
        ...(argumentsJson ? { argumentsJson } : {}),
        ...(resultText ? { resultText } : {}),
        ...(resultMetadata ? { resultMetadata } : {}),
      };
    };

    const handleLine = (line: string): void => {
      if (finished) return;
      if (byteLength(line) > MAX_FRAME_BYTES) {
        void settle(protocolError(`frame exceeds ${MAX_FRAME_BYTES} bytes`));
        return;
      }
      const frame = parseFrameLine(line);
      if (!frame) {
        void settle(protocolError('invalid JSON control frame'));
        return;
      }
      if (frame.type === 'ready') {
        if (runSent) {
          void settle(protocolError('duplicate ready frame'));
          return;
        }
        runSent = true;
        writeFrame({
          v: 1,
          type: 'run',
          program: opts.program,
          bindings: opts.bindings,
          cwd,
          limits: opts.limits,
          uiEnabled: opts.uiEnabled,
        });
        return;
      }
      if (frame.type === 'log') {
        if (!runSent) {
          void settle(protocolError('log frame before run'));
          return;
        }
        appendLog(typeof frame.text === 'string' ? frame.text : String(frame.text));
        return;
      }
      if (frame.type === 'call') {
        if (!runSent) {
          void settle(protocolError('call frame before run'));
          return;
        }
        if (typeof frame.id !== 'string' || !CALL_ID_RE.test(frame.id)) {
          void settle(protocolError('invalid call id'));
          return;
        }
        if (frame.ns !== 'tools') {
          void settle(protocolError(`unsupported namespace: ${String(frame.ns)}`));
          return;
        }
        if (typeof frame.name !== 'string' || !bindingSet.has(frame.name)) {
          void settle(protocolError(`tool not in allowlist: ${String(frame.name)}`));
          return;
        }
        if (!isLosslessJsonValue(frame.args)) {
          writeFrame({
            v: 1,
            type: 'tool-result',
            id: frame.id,
            ok: false,
            error: {
              name: TOOL_CALL_ERROR_NAME,
              message: 'tool arguments must be lossless JSON (no undefined/function/BigInt/non-finite number)',
            },
          });
          return;
        }
        enqueueCall({ id: frame.id, name: frame.name, args: frame.args });
        return;
      }
      if (frame.type === 'result') {
        void settleSuccess(frame);
        return;
      }
      if (frame.type === 'error') {
        const kind = isFailureKind(frame.kind) ? frame.kind : 'exception';
        void settle({
          logs: logs.slice(),
          calls: calls.slice(),
          callsTruncated,
          nestedCalls: calls.length,
          hasUi,
          truncated: false,
          error: { kind, message: typeof frame.message === 'string' ? frame.message : 'unknown error' },
        });
        return;
      }
      void settle(protocolError(`unknown frame type: ${String(frame.type)}`));
    };

    const protocolError = (message: string): Omit<RunCodeHostResult, 'durationMs'> => ({
      logs: logs.slice(),
      calls: calls.slice(),
      callsTruncated,
      nestedCalls: calls.length,
      hasUi,
      truncated: true,
      error: { kind: 'protocol', message: stderr ? `${message}\n${stderr}` : message },
    });

    // ---- 调度池 ----
    interface QueuedCall {
      id: string;
      name: string;
      args: unknown;
    }
    const queue: QueuedCall[] = [];
    let active = 0;

    const enqueueCall = (call: QueuedCall): void => {
      queue.push(call);
      pump();
    };

    const pump = (): void => {
      while (!finished && queue.length > 0) {
        const head = queue[0];
        const safe = opts.isConcurrencySafe(head.name);
        if (safe) {
          if (active >= opts.limits.maxParallelSubCalls) return;
        } else if (active > 0) {
          return;
        }
        queue.shift();
        active += 1;
        void runCall(head).finally(() => {
          active -= 1;
          pump();
        });
      }
    };

    const runCall = async (call: QueuedCall): Promise<void> => {
      const started = performance.now();
      try {
        const result = await opts.invokeTool(call.name, call.args, {
          callId: call.id,
          signal: runController.signal,
        });
        const durationMs = Math.round(performance.now() - started);
        if (result.isError) {
          const message = toolResultErrorMessage(result, call.name);
          recordCall({
            id: call.id,
            name: call.name,
            argsPreview: previewJson(call.args),
            resultPreview: truncateToBytes(message, 400),
            durationMs,
            ok: false,
            error: truncateToBytes(message, 800),
            ...collectCallDetails(call.args, undefined, message),
          });
          writeFrame({
            v: 1,
            type: 'tool-result',
            id: call.id,
            ok: false,
            error: { name: TOOL_CALL_ERROR_NAME, message },
          });
          return;
        }
        const value = toolResultToCodeValue(result);
        recordCall({
          id: call.id,
          name: call.name,
          argsPreview: previewJson(call.args),
          resultPreview: previewJson(value),
          durationMs,
          ok: true,
          ...collectCallDetails(call.args, result),
        });
        writeFrame({ v: 1, type: 'tool-result', id: call.id, ok: true, value });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const durationMs = Math.round(performance.now() - started);
        recordCall({
          id: call.id,
          name: call.name,
          argsPreview: previewJson(call.args),
          resultPreview: truncateToBytes(message, 400),
          durationMs,
          ok: false,
          error: truncateToBytes(message, 800),
          ...collectCallDetails(call.args, undefined, message),
        });
        writeFrame({
          v: 1,
          type: 'tool-result',
          id: call.id,
          ok: false,
          error: {
            name: err instanceof Error && err.name ? err.name : TOOL_CALL_ERROR_NAME,
            message,
          },
        });
      }
    };

    const settleSuccess = async (frame: Extract<ChildToHost, { type: 'result' }>): Promise<void> => {
      const value = frame.value;
      if (value !== undefined && !isLosslessJsonValue(value)) {
        await settle({
          logs: logs.slice(),
          calls: calls.slice(),
          callsTruncated,
          nestedCalls: calls.length,
          hasUi: false,
          truncated: false,
          error: { kind: 'invalid-output', message: 'program return value is not lossless JSON' },
        });
        return;
      }
      const valueBytes = value === undefined ? 0 : byteLength(JSON.stringify(value));
      if (logBytes + valueBytes > opts.limits.maxOutputBytes) {
        await settle({
          logs: logs.slice(),
          calls: calls.slice(),
          callsTruncated,
          nestedCalls: calls.length,
          hasUi: false,
          truncated: true,
          error: {
            kind: 'output-limit',
            message: `result + logs exceeded maxOutputBytes (${opts.limits.maxOutputBytes})`,
          },
        });
        return;
      }
      hasUi = frame.hasUi === true && frame.ui !== undefined;
      await settle({
        ...(value !== undefined ? { value } : {}),
        logs: logs.slice(),
        ...(frame.ui !== undefined ? { ui: frame.ui } : {}),
        ...(frame.uiDiagnostics !== undefined ? { uiDiagnostics: frame.uiDiagnostics } : {}),
        nestedCalls: Math.max(calls.length, typeof frame.nestedCalls === 'number' ? frame.nestedCalls : 0),
        hasUi,
        calls: calls.slice(),
        callsTruncated,
        truncated: callsTruncated,
      });
    };

    const settle = async (result: Omit<RunCodeHostResult, 'durationMs'>): Promise<void> => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      runController.abort();
      try {
        child.stdin.end();
      } catch {
        // 已关闭
      }
      await terminateChild(child);
      resolvePromise({ ...result, durationMs: Math.round(performance.now() - startedAt) });
    };

    const onAbort = (): void => {
      runController.abort();
      writeFrame({ v: 1, type: 'abort' });
      void settle({
        logs: logs.slice(),
        calls: calls.slice(),
        callsTruncated,
        nestedCalls: calls.length,
        hasUi: false,
        truncated: false,
        error: { kind: 'abort', message: 'aborted by caller' },
      });
    };

    opts.signal?.addEventListener('abort', onAbort, { once: true });

    timer = setTimeout(() => {
      runController.abort();
      void settle({
        logs: logs.slice(),
        calls: calls.slice(),
        callsTruncated,
        nestedCalls: calls.length,
        hasUi: false,
        truncated: false,
        error: {
          kind: 'timeout',
          message: `program did not finish within ${opts.limits.timeoutMs}ms (subprocess terminated)`,
        },
      });
    }, opts.limits.timeoutMs);

    // ---- stdout 行读取 ----
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > MAX_FRAME_BYTES * 4) {
            await settle(protocolError('stdout buffer overflow without newline'));
            return;
          }
          let idx = buffer.indexOf('\n');
          while (idx >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.trim() !== '') handleLine(line);
            if (finished) return;
            idx = buffer.indexOf('\n');
          }
        }
        if (!finished) {
          await child.exited;
          await settle({
            logs: logs.slice(),
            calls: calls.slice(),
            callsTruncated,
            nestedCalls: calls.length,
            hasUi: false,
            truncated: true,
            error: {
              kind: 'worker-exit',
              message: `subprocess exited before returning a result${stderr ? `\n${stderr}` : ''}`,
            },
          });
        }
      } catch (err) {
        await settle(protocolError(`stdout read failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    })();

    // ---- stderr 读取（只用于诊断，不进入模型日志） ----
    void (async () => {
      try {
        const errReader = child.stderr.getReader();
        const errDecoder = new TextDecoder();
        for (;;) {
          const { done, value } = await errReader.read();
          if (done) break;
          stderr += errDecoder.decode(value, { stream: true });
          if (stderr.length > STDERR_CAP_BYTES * 2) stderr = stderr.slice(-STDERR_CAP_BYTES);
        }
      } catch {
        // stderr 不可读时忽略
      }
    })();

    opts.logger?.debug('run_code: subprocess started', {
      pid: child.pid,
      cwd,
      timeoutMs: opts.limits.timeoutMs,
    });
  });
}

function resolveCwd(cwd: string): string {
  try {
    const abs = isAbsolute(cwd) ? cwd : resolvePath(cwd);
    return abs;
  } catch {
    return process.cwd();
  }
}

/** 最小环境变量：保留系统运行必需项，清空用户业务变量；程序内 process.env 也是空 shim。 */
function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const keys = process.platform === 'win32'
    ? ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH']
    : ['PATH', 'TMPDIR'];
  for (const key of keys) {
    const v = process.env[key];
    if (typeof v === 'string' && v.length > 0) env[key] = v;
  }
  return env;
}

async function terminateChild(child: ChildProcessLike): Promise<void> {
  const exited = await Promise.race([
    child.exited.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), EXIT_GRACE_MS)),
  ]);
  if (exited) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // 已退出
  }
  await Promise.race([
    child.exited,
    new Promise<void>((r) => setTimeout(r, EXIT_HARD_WAIT_MS)),
  ]);
}

function isFailureKind(value: unknown): value is CodeFailureKind {
  return (
    value === 'exception' ||
    value === 'timeout' ||
    value === 'abort' ||
    value === 'worker-exit' ||
    value === 'invalid-output' ||
    value === 'output-limit' ||
    value === 'protocol' ||
    value === 'sandbox-unavailable'
  );
}

/** 完整 JSON 文本（带字节上限）；不可序列化时返回 undefined */
function safeJsonText(value: unknown, maxBytes: number): string | undefined {
  try {
    const json: string | undefined = JSON.stringify(value);
    if (json === undefined) return undefined;
    return truncateToBytes(json, maxBytes);
  } catch {
    return undefined;
  }
}

/** 结果 metadata 体积保护：超过单条上限直接丢弃（前端退回文本预览） */
function capCallMetadata(metadata: ToolResult['metadata']): ToolResult['metadata'] | undefined {
  if (!metadata) return undefined;
  try {
    const json: string | undefined = JSON.stringify(metadata);
    if (json === undefined || byteLength(json) > MAX_CALL_METADATA_BYTES) return undefined;
    return metadata;
  } catch {
    return undefined;
  }
}

function previewJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return truncateToBytes(json ?? 'null', 400);
  } catch {
    return '[unserializable]';
  }
}
