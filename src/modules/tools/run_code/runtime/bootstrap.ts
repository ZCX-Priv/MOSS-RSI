// src/modules/tools/run_code/runtime/bootstrap.ts
// run_code 子进程入口（由 host.ts 以 `bun bootstrap.ts` 启动）。
//
// 职责：
//   1. 从 stdin 读取宿主控制帧（ready / run / tool-result / abort）；
//   2. 用 Bun.Transpiler 剥离 TS 类型，AsyncFunction 执行模型写的 async 函数体；
//   3. 注入 tools（Proxy → 宿主完整工具管线）、ui（UISpec 构建器）、console（日志帧）、受限 process shim；
//   4. 把程序返回值 / UISpec / 错误以行分隔 JSON 帧写回 stdout。
//
// 注意：这不是安全沙箱。参数遮蔽（fetch/Bun/Function/globalThis）只提高门槛，
// 真正的边界是外层 run_code 的用户确认与嵌套工具的逐次 safety 决策。

import {
  createDisabledUiNamespace,
  createUiBuilder,
  type UiNamespace,
} from '../ui/builder';
import type { UIDiagnostic, UINode, UIStateValue, UISpec } from '../ui/spec';
import {
  isLosslessJsonValue,
  parseFrameLine,
  type ChildToHost,
  type CodeValue,
  type HostToChild,
  type RunLimits,
} from './protocol';
import { ToolCallError } from './value';

const realProcess = process;
const stdoutSink = Bun.stdout.writer();

/** 写一帧到 stdout（宿主按行读取）。写失败（宿主已退出）返回 false。 */
async function writeFrame(frame: ChildToHost): Promise<boolean> {
  try {
    const line = `${JSON.stringify(frame)}\n`;
    stdoutSink.write(line);
    await stdoutSink.flush();
    return true;
  } catch {
    return false;
  }
}

interface PendingCall {
  name: string;
  resolve: (value: CodeValue) => void;
  reject: (err: Error) => void;
}

interface RunState {
  started: boolean;
  limits: RunLimits;
  cwd: string;
  uiEnabled: boolean;
}

const state: RunState = {
  started: false,
  limits: {
    timeoutMs: 120_000,
    maxOutputBytes: 262_144,
    maxCodeChars: 20_000,
    maxParallelSubCalls: 10,
  },
  cwd: realProcess.cwd(),
  uiEnabled: false,
};

const pending = new Map<string, PendingCall>();
let callSeq = 0;

/** 构造 tools Proxy：属性访问时校验 allowlist，调用时发 call 帧并等待宿主结果。 */
function createToolsProxy(allowlist: string[]): Record<string, (args?: unknown) => Promise<CodeValue>> {
  const allowed = new Set(allowlist);
  return new Proxy(Object.create(null) as Record<string, (args?: unknown) => Promise<CodeValue>>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (!allowed.has(prop)) {
        throw new Error(`Unknown tool "${prop}". Only tools listed in the SDK are available inside run_code.`);
      }
      return async (args?: unknown): Promise<CodeValue> => {
        if (args !== undefined && !isLosslessJsonValue(args)) {
          throw new ToolCallError(prop, 'arguments must be lossless JSON (no undefined/function/BigInt/non-finite number)');
        }
        const id = `c${++callSeq}`;
        return await new Promise<CodeValue>((resolve, reject) => {
          pending.set(id, { name: prop, resolve, reject });
          void writeFrame({
            v: 1,
            type: 'call',
            id,
            ns: 'tools',
            name: prop,
            args: args ?? {},
          });
        });
      };
    },
  });
}

/** console → 日志帧；不直接写 stdout，避免污染控制通道。 */
function createConsoleShim(): Record<'log' | 'info' | 'warn' | 'error' | 'debug', (...args: unknown[]) => void> {
  const emit = (args: unknown[]): void => {
    const text = args.map(formatLogArg).join(' ');
    void writeFrame({ v: 1, type: 'log', text });
  };
  return {
    log: (...args: unknown[]) => emit(args),
    info: (...args: unknown[]) => emit(args),
    warn: (...args: unknown[]) => emit(args),
    error: (...args: unknown[]) => emit(args),
    debug: (...args: unknown[]) => emit(args),
  };
}

function formatLogArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/** 受限 process shim：env 为空、无 stdout/exit，只有 cwd/platform/arch/argv。 */
function createProcessShim(cwd: string): Record<string, unknown> {
  return Object.freeze({
    env: Object.freeze({}),
    cwd: () => cwd,
    platform: realProcess.platform,
    arch: realProcess.arch,
    argv: [],
    versions: Object.freeze({}),
  });
}

/** 执行 run 帧：编译 → 注入命名空间 → 执行 → 回传结果。 */
async function executeRun(frame: Extract<HostToChild, { type: 'run' }>): Promise<void> {
  if (state.started) {
    await writeFrame({ v: 1, type: 'error', kind: 'protocol', message: 'duplicate run frame' });
    return;
  }
  state.started = true;
  state.limits = frame.limits;
  state.cwd = frame.cwd;
  state.uiEnabled = frame.uiEnabled;

  if (typeof frame.program !== 'string' || frame.program.length === 0) {
    await writeFrame({ v: 1, type: 'error', kind: 'exception', message: 'program is empty' });
    return;
  }
  if (frame.program.length > frame.limits.maxCodeChars) {
    await writeFrame({
      v: 1,
      type: 'error',
      kind: 'exception',
      message: `program exceeds maxCodeChars (${frame.limits.maxCodeChars})`,
    });
    return;
  }

  // 用 async 函数声明包裹：既允许程序使用顶层 await/return，又避开
  // Bun.Transpiler 对「ECMAScript module 顶层 return」的拒绝。
  // 注：Bun.Transpiler 会裁剪裸表达式语句，因此必须用函数声明而不是 IIFE 表达式。
  const wrapped = [
    'async function __moss_run_program_2026__(tools, ui, console, process, require, fetch, Bun, globalThis, Function, setTimeout, setInterval, clearTimeout, clearInterval) {',
    '"use strict";',
    frame.program,
    '}',
  ].join('\n');

  let js: string;
  try {
    js = new Bun.Transpiler({ loader: 'ts' }).transformSync(wrapped);
  } catch (err) {
    await writeFrame({
      v: 1,
      type: 'error',
      kind: 'exception',
      message: `TypeScript transform failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const builder = createUiBuilder();
  const ui: UiNamespace = frame.uiEnabled ? builder.ui : createDisabledUiNamespace();
  const tools = createToolsProxy(frame.bindings);
  const consoleShim = createConsoleShim();
  const processShim = createProcessShim(frame.cwd);

  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    // 只编译一次：new Function 返回转译后的 async 函数声明。
    fn = new Function(`"use strict";\n${js}\nreturn __moss_run_program_2026__;`)() as (
      ...args: unknown[]
    ) => Promise<unknown>;
  } catch (err) {
    await writeFrame({
      v: 1,
      type: 'error',
      kind: 'exception',
      message: `failed to compile program: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  let value: unknown;
  try {
    value = await fn(
      tools,
      ui,
      consoleShim,
      processShim,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
    await writeFrame({ v: 1, type: 'error', kind: 'exception', message });
    return;
  }

  if (value !== undefined && !isLosslessJsonValue(value)) {
    await writeFrame({
      v: 1,
      type: 'error',
      kind: 'invalid-output',
      message: 'program return value is not lossless JSON (no undefined field/function/BigInt/cyclic reference)',
    });
    return;
  }

  const built = builder.getResult();
  const spec: UISpec | undefined = built.hasUi && built.root
    ? {
        version: 1,
        ...(built.title ? { title: built.title } : {}),
        root: built.root as UINode,
        state: built.state as Record<string, UIStateValue>,
      }
    : undefined;
  const diagnostics: UIDiagnostic[] = built.diagnostics;

  await writeFrame({
    v: 1,
    type: 'result',
    ...(value !== undefined ? { value: value as CodeValue } : {}),
    ...(spec ? { ui: spec } : {}),
    uiDiagnostics: diagnostics,
    nestedCalls: callSeq,
    hasUi: !!spec,
  });
}

/** 处理一行宿主帧。 */
function handleHostFrame(line: string): void {
  const frame = parseFrameLine(line);
  if (!frame) {
    void writeFrame({ v: 1, type: 'error', kind: 'protocol', message: 'invalid host frame' });
    return;
  }
  if (frame.type === 'run') {
    void executeRun(frame);
    return;
  }
  if (frame.type === 'tool-result') {
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    if (frame.ok) entry.resolve(frame.value);
    else {
      const err = new ToolCallError(entry.name, frame.error.message);
      err.name = frame.error.name || 'ToolCallError';
      entry.reject(err);
    }
    return;
  }
  if (frame.type === 'abort') {
    for (const [, entry] of pending) {
      entry.reject(new ToolCallError(entry.name, 'aborted'));
    }
    pending.clear();
    realProcess.exit(0);
  }
}

/** 主循环：读 stdin → 分发帧；stdin 关闭后退出。 */
async function main(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  void writeFrame({ v: 1, type: 'ready' });

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim() !== '') handleHostFrame(line);
      idx = buffer.indexOf('\n');
    }
  }
  realProcess.exit(0);
}

void main().catch((err: unknown) => {
  void writeFrame({
    v: 1,
    type: 'error',
    kind: 'exception',
    message: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
  realProcess.exit(1);
});
