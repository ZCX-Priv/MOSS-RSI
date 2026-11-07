// src/modules/tools/run_code/runtime/host.ts
// run_code 宿主：Bun.spawn 子进程 + 行分隔 JSON-RPC + 调度池 + 超时/中止/限额。
//
// 安全模型（必须诚实）：子进程能硬超时/强杀，避免死循环阻塞主服务；但这不是多租户安全沙箱。
// 程序仍以当前用户权限运行，真正的安全边界是外层 run_code 的确认卡 + 嵌套工具逐次 safety 决策。

import { existsSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { Logger } from '../../../../core/types';
import type { RunCodeProgressEvent, ToolResult } from '../../types';
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
import type { SanitizeWarning } from './sanitize';

export interface CodeRunCallRecord {
  id: string;
  name: string;
  /** 调用开始序号（从 1 递增）：顺序的唯一真源，保证与代码中的调用顺序一致 */
  seq: number;
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
  /** 实时进度回调（执行开始 / 日志 / 嵌套调用开始与结束）；异常被吞掉，不影响程序执行 */
  onProgress?: (event: RunCodeProgressEvent) => void;
  logger?: Logger;
}

export interface RunCodeHostResult {
  value?: CodeValue;
  /** 返回值净化警告（undefined/Date/Map/循环引用等） */
  valueWarnings?: SanitizeWarning[];
  logs: string[];
  ui?: unknown;
  uiDiagnostics?: unknown;
  nestedCalls: number;
  hasUi: boolean;
  calls: CodeRunCallRecord[];
  callsTruncated: boolean;
  /** 嵌套工具返回的图片路径（最多 2 张；由工具层读取并内联） */
  images?: Array<{ path: string; mimeType: string }>;
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

/** 单条日志的格式化保护（协议帧硬上限，不是内容预算） */
const MAX_LOG_ENTRY_BYTES = MAX_FRAME_BYTES;
/** 嵌套调用记录条数上限（只限制条数，不截内容） */
const MAX_CALL_RECORDS = 100;
const STDERR_CAP_BYTES = 8_192;
const EXIT_GRACE_MS = 150;
const EXIT_HARD_WAIT_MS = 800;
/** 流式进度帧预算：避免单条嵌套调用把 WS 撑爆（最终外层结果仍完整落库） */
const MAX_PROGRESS_ARGS_BYTES = 16 * 1024;
const MAX_PROGRESS_RESULT_TEXT_BYTES = 32 * 1024;
const MAX_PROGRESS_RESULT_META_BYTES = 64 * 1024;

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
  /** 嵌套工具产生的图片（只保留最后 2 张，随 run_code 结果回到模型） */
  const nestedImages: Array<{ path: string; mimeType: string }> = [];
  /** 调用开始序号：每次 runCall 开始时递增（与并行/完成顺序无关） */
  let callSeq = 0;
  let callsTruncated = false;
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
    /** 日志批量缓冲：避免每条 console.log 都单独发一帧 WS（80ms / 50 条） */
    const logBuffer: string[] = [];
    let logTimer: ReturnType<typeof setTimeout> | null = null;
    /** 程序开始执行的绝对时刻（epoch ms），供前端实时计时 */
    let programStartedAtMs: number | null = null;

    const emitProgress = (event: RunCodeProgressEvent): void => {
      if (!opts.onProgress) return;
      try {
        opts.onProgress(event);
      } catch (err) {
        opts.logger?.debug('run_code: progress callback failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const flushLogs = (): void => {
      if (logTimer) {
        clearTimeout(logTimer);
        logTimer = null;
      }
      if (logBuffer.length === 0) return;
      emitProgress({ phase: 'log', log: logBuffer.join('\n') });
      logBuffer.length = 0;
    };

    const scheduleLog = (text: string): void => {
      logBuffer.push(text);
      if (logBuffer.length >= 50) {
        flushLogs();
        return;
      }
      if (!logTimer) logTimer = setTimeout(flushLogs, 80);
    };

    const writeLine = (line: string): boolean => {
      if (finished) return false;
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
          error: { kind: 'protocol', message: `control frame exceeds ${MAX_FRAME_BYTES} bytes` },
        });
        return false;
      }
      return writeLine(line);
    };

    const appendLog = (text: string): void => {
      if (finished) return;
      const oversized = byteLength(text) > MAX_LOG_ENTRY_BYTES;
      const clean = truncateToBytes(text, MAX_LOG_ENTRY_BYTES);
      const entry = oversized ? `${clean}\n…（单条日志过长，已截断）` : clean;
      logs.push(entry);
      scheduleLog(entry);
    };

    const recordCall = (record: CodeRunCallRecord): void => {
      if (calls.length >= MAX_CALL_RECORDS) {
        callsTruncated = true;
        return;
      }
      calls.push(record);
    };

    /** 调用快照：按开始序号 seq 排序（最终 metadata 与代码调用顺序一致，而非完成顺序） */
    function snapshotCalls(): CodeRunCallRecord[] {
      return [...calls].sort((a, b) => a.seq - b.seq);
    }

    /**
     * 嵌套调用的富数据（前端复用普通工具卡渲染）。
     * 预览完全放开：入参、结果正文、metadata 都不按字节截断。
     */
    const collectCallDetails = (
      args: unknown,
      result?: ToolResult,
      fallbackText?: string,
    ): Pick<CodeRunCallRecord, 'argumentsJson' | 'resultText' | 'resultMetadata'> => {
      const argumentsJson = jsonText(args);
      const rawText = result ? toolResultText(result) : (fallbackText ?? '');
      return {
        ...(argumentsJson ? { argumentsJson } : {}),
        ...(rawText ? { resultText: rawText } : {}),
        ...(result?.metadata ? { resultMetadata: result.metadata } : {}),
      };
    };

    /** 嵌套调用开始进度（参数超过预算时只给 preview，避免单帧过大） */
    const emitCallStart = (call: { id: string; name: string; args: unknown }, seq: number): void => {
      const argsJson = jsonText(call.args);
      emitProgress({
        phase: 'call-start',
        ...(programStartedAtMs ? { elapsedMs: Date.now() - programStartedAtMs } : {}),
        call: {
          id: call.id,
          name: call.name,
          seq,
          argsPreview: previewJson(call.args),
          ...(argsJson && byteLength(argsJson) <= MAX_PROGRESS_ARGS_BYTES
            ? { argumentsJson: argsJson }
            : {}),
          status: 'running',
        },
      });
    };

    /** 嵌套调用结束进度（正文/metadata 超预算时省略，展开最终结果仍可拿到完整内容） */
    const emitCallEnd = (record: CodeRunCallRecord): void => {
      const resultText =
        record.resultText && byteLength(record.resultText) <= MAX_PROGRESS_RESULT_TEXT_BYTES
          ? record.resultText
          : undefined;
      let resultMetadata = record.resultMetadata;
      if (resultMetadata && byteLength(jsonText(resultMetadata) ?? '') > MAX_PROGRESS_RESULT_META_BYTES) {
        resultMetadata = undefined;
      }
      emitProgress({
        phase: 'call-end',
        ...(programStartedAtMs ? { elapsedMs: Date.now() - programStartedAtMs } : {}),
        call: {
          id: record.id,
          name: record.name,
          seq: record.seq,
          argsPreview: record.argsPreview,
          ...(record.durationMs >= 0 ? { durationMs: record.durationMs } : {}),
          ok: record.ok,
          status: record.ok ? 'done' : 'failed',
          ...(record.error ? { error: record.error } : {}),
          ...(record.resultPreview ? { resultPreview: record.resultPreview } : {}),
          ...(resultText ? { resultText } : {}),
          ...(resultMetadata ? { resultMetadata } : {}),
        },
      });
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
        programStartedAtMs = Date.now();
        emitProgress({ phase: 'started', startedAtMs: programStartedAtMs });
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
          calls: snapshotCalls(),
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
      calls: snapshotCalls(),
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
      const seq = (callSeq += 1);
      emitCallStart(call, seq);
      try {
        const result = await opts.invokeTool(call.name, call.args, {
          callId: call.id,
          signal: runController.signal,
        });
        const durationMs = Math.round(performance.now() - started);
        if (result.isError) {
          const message = toolResultErrorMessage(result, call.name);
          const record: CodeRunCallRecord = {
            id: call.id,
            name: call.name,
            seq,
            argsPreview: previewJson(call.args),
            resultPreview: truncateToBytes(message, 400),
            durationMs,
            ok: false,
            error: truncateToBytes(message, 800),
            ...collectCallDetails(call.args, undefined, message),
          };
          recordCall(record);
          emitCallEnd(record);
          writeFrame({
            v: 1,
            type: 'tool-result',
            id: call.id,
            ok: false,
            error: { name: TOOL_CALL_ERROR_NAME, message },
          });
          return;
        }
        // 收集图片供最终 run_code 结果内联（模型无需再单独调用 screenshot）
        for (const part of result.content) {
          if (part.type !== 'image' || !part.path) continue;
          if (nestedImages.some((item) => item.path === part.path)) continue;
          nestedImages.push({ path: part.path, mimeType: part.source.mimeType });
        }
        while (nestedImages.length > 2) nestedImages.shift();

        const value = toolResultToCodeValue(result);
        const frame = { v: 1 as const, type: 'tool-result' as const, id: call.id, ok: true as const, value };
        const line = encodeFrame(frame);
        if (byteLength(line) > MAX_FRAME_BYTES) {
          // 工具结果超过协议硬上限：只让这次调用失败（程序可 catch），不终止整个程序。
          const message =
            `${call.name} result exceeds protocol frame limit (${byteLength(line)} bytes > ${MAX_FRAME_BYTES}); ` +
            'narrow the query or request fewer fields';
          const record: CodeRunCallRecord = {
            id: call.id,
            name: call.name,
            seq,
            argsPreview: previewJson(call.args),
            resultPreview: truncateToBytes(message, 400),
            durationMs,
            ok: false,
            error: truncateToBytes(message, 800),
            ...collectCallDetails(call.args, undefined, message),
          };
          recordCall(record);
          emitCallEnd(record);
          writeFrame({
            v: 1,
            type: 'tool-result',
            id: call.id,
            ok: false,
            error: { name: TOOL_CALL_ERROR_NAME, message },
          });
          return;
        }
        const record: CodeRunCallRecord = {
          id: call.id,
          name: call.name,
          seq,
          argsPreview: previewJson(call.args),
          resultPreview: previewJson(value),
          durationMs,
          ok: true,
          ...collectCallDetails(call.args, result),
        };
        recordCall(record);
        emitCallEnd(record);
        writeLine(line);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const durationMs = Math.round(performance.now() - started);
        const record: CodeRunCallRecord = {
          id: call.id,
          name: call.name,
          seq,
          argsPreview: previewJson(call.args),
          resultPreview: truncateToBytes(message, 400),
          durationMs,
          ok: false,
          error: truncateToBytes(message, 800),
          ...collectCallDetails(call.args, undefined, message),
        };
        recordCall(record);
        emitCallEnd(record);
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
      // 子进程已用 sanitizeForJson 净化返回值；经 JSON 帧传输后必然是合法 JSON，不再按预算拒绝。
      const value = frame.value;
      const valueWarnings = normalizeValueWarnings(frame.valueWarnings);
      hasUi = frame.hasUi === true && frame.ui !== undefined;
      await settle({
        ...(value !== undefined ? { value } : {}),
        ...(valueWarnings.length > 0 ? { valueWarnings } : {}),
        logs: logs.slice(),
        ...(frame.ui !== undefined ? { ui: frame.ui } : {}),
        ...(frame.uiDiagnostics !== undefined ? { uiDiagnostics: frame.uiDiagnostics } : {}),
        nestedCalls: Math.max(calls.length, typeof frame.nestedCalls === 'number' ? frame.nestedCalls : 0),
        hasUi,
        calls: snapshotCalls(),
        callsTruncated,
        truncated: callsTruncated,
      });
    };

    const settle = async (result: Omit<RunCodeHostResult, 'durationMs'>): Promise<void> => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      // 收尾前把缓冲日志发出去；结果帧随后由最终 tool-call-end 统一覆盖
      flushLogs();
      opts.signal?.removeEventListener('abort', onAbort);
      runController.abort();
      try {
        child.stdin.end();
      } catch {
        // 已关闭
      }
      await terminateChild(child);
      resolvePromise({
        ...result,
        ...(nestedImages.length > 0 ? { images: nestedImages.slice() } : {}),
        durationMs: Math.round(performance.now() - startedAt),
      });
    };

    const onAbort = (): void => {
      runController.abort();
      writeFrame({ v: 1, type: 'abort' });
      void settle({
        logs: logs.slice(),
        calls: snapshotCalls(),
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
        calls: snapshotCalls(),
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
            calls: snapshotCalls(),
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
    value === 'syntax' ||
    value === 'output-limit' ||
    value === 'protocol' ||
    value === 'sandbox-unavailable'
  );
}

/** 子进程回传的净化警告：做形状校验与长度保护（仅用于展示） */
function normalizeValueWarnings(value: unknown): SanitizeWarning[] {
  if (!Array.isArray(value)) return [];
  const out: SanitizeWarning[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const warning = item as { path?: unknown; reason?: unknown };
    if (typeof warning.path !== 'string' || typeof warning.reason !== 'string') continue;
    out.push({
      path: warning.path.slice(0, 300),
      reason: warning.reason.slice(0, 300),
    });
    if (out.length >= 100) break;
  }
  return out;
}

/** 完整 JSON 文本（预览完全放开，不再按字节截断）；不可序列化时返回 undefined */
function jsonText(value: unknown): string | undefined {
  try {
    const json: string | undefined = JSON.stringify(value);
    return json === undefined ? undefined : json;
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
