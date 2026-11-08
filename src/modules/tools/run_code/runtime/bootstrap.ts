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
  byteLength,
  MAX_FRAME_BYTES,
  parseFrameLine,
  type ChildToHost,
  type CodeValue,
  type HostToChild,
  type RunLimits,
} from './protocol';
import { findJsonViolation, sanitizeForJson } from './sanitize';
import { calibrateWrapperExtraLines, PROGRAM_SOURCE_URL, rewriteRuntimeStack } from './stack';
import { formatSourceExcerpt, locateChunkFailure, scanStructure } from './syntax';
import { ToolCallError } from './value';

const realProcess = process;
const stdoutSink = Bun.stdout.writer();

/** 写一帧到 stdout（宿主按行读取）。写失败（宿主已退出/超过协议上限）返回 false。 */
async function writeFrame(frame: ChildToHost): Promise<boolean> {
  try {
    const line = `${JSON.stringify(frame)}\n`;
    if (byteLength(line) > MAX_FRAME_BYTES) return false;
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
    maxCodeChars: 20_000,
    maxParallelSubCalls: 10,
  },
  cwd: realProcess.cwd(),
  uiEnabled: false,
};

/** new Function 包装的固定行号偏移（用于运行时错误栈改写） */
const WRAPPER_EXTRA_LINES = calibrateWrapperExtraLines();

const pending = new Map<string, PendingCall>();
let callSeq = 0;

/**
 * 注入给程序的定时能力：
 * - 沙箱内禁用 setTimeout，但交互/游戏脚本需要「动作→等待→观察」。
 * - 实现放在 bootstrap 外层（真实 setTimeout），只暴露受控的 sleep/now。
 */
function sandboxSleep(ms: number): Promise<void> {
  const value = typeof ms === 'number' && Number.isFinite(ms) ? ms : 0;
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, Math.min(600_000, Math.trunc(value))));
  });
}

function sandboxNow(): number {
  return Date.now();
}

/** 编辑距离（工具名拼写纠错用） */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[n];
}

/** 最近邻工具名（最多 3 个；编辑距离 + 前缀加成） */
function closestToolNames(input: string, allowed: Set<string>): string[] {
  const needle = input.toLowerCase();
  const scored: Array<{ name: string; score: number }> = [];
  for (const name of allowed) {
    const lower = name.toLowerCase();
    const distance = editDistance(needle, lower);
    const prefixBonus = lower.startsWith(needle) || needle.startsWith(lower) ? 0 : 1;
    scored.push({ name, score: distance + prefixBonus });
  }
  scored.sort((a, b) => a.score - b.score);
  const threshold = Math.max(2, Math.floor(needle.length / 3));
  return scored
    .filter((entry) => entry.score <= threshold)
    .slice(0, 3)
    .map((entry) => entry.name);
}

/** 构造 tools Proxy：属性访问时校验 allowlist，调用时发 call 帧并等待宿主结果。 */
function createToolsProxy(allowlist: string[]): Record<string, (args?: unknown) => Promise<CodeValue>> {
  const allowed = new Set(allowlist);
  return new Proxy(Object.create(null) as Record<string, (args?: unknown) => Promise<CodeValue>>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (!allowed.has(prop)) {
        const suggestions = closestToolNames(prop, allowed);
        const available = [...allowed].slice(0, 30).join(', ');
        throw new Error(
          `Unknown tool "${prop}".` +
            (suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '') +
            ` Available: ${available}${allowed.size > 30 ? ' …' : ''}`,
        );
      }
      return async (args?: unknown): Promise<CodeValue> => {
        const violation = args === undefined ? null : findJsonViolation(args, `tools.${prop}(...)`);
        if (violation) {
          throw new ToolCallError(prop, `${violation.path}: ${violation.reason}`);
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
  const wrapped = wrapProgram(frame.program);

  let js: string;
  try {
    js = new Bun.Transpiler({ loader: 'ts' }).transformSync(wrapped);
  } catch (err) {
    // 转译器只给 Parse error，没有位置；失败时再用结构扫描器补充精确行列。
    // 以转译结果为准：扫描器只在转译失败时参与诊断，避免正则启发式误报阻止合法代码。
    const issue = scanStructure(frame.program);
    const detail = describeTranspileErrors(err);
    await writeFrame({
      v: 1,
      type: 'error',
      kind: 'syntax',
      message: issue.ok
        ? buildTranspileFailure(frame.program, err)
        : `${formatSyntaxIssue(issue.issue)}${detail ? `\nTS 解析器信息：${detail}` : ''}`,
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
    // sourceURL 让运行时栈固定显示 moss-run-code.js，便于行号回写。
    const body = `"use strict";\n${js}\nreturn __moss_run_program_2026__;\n//# sourceURL=${PROGRAM_SOURCE_URL}`;
    fn = new Function(body)() as (...args: unknown[]) => Promise<unknown>;
  } catch (err) {
    await writeFrame({
      v: 1,
      type: 'error',
      kind: 'syntax',
      message: buildCompileFailure(frame.program, err),
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
      blockedCallable('require'),
      blockedCallable('fetch'),
      blockedObject('Bun'),
      blockedObject('globalThis'),
      blockedCallable('Function'),
      blockedCallable('setTimeout'),
      blockedCallable('setInterval'),
      blockedCallable('clearTimeout'),
      blockedCallable('clearInterval'),
      sandboxSleep,
      sandboxNow,
    );
  } catch (err) {
    const rawStack = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
    const message = rewriteRuntimeStack(rawStack, js, frame.program, WRAPPER_EXTRA_LINES);
    await writeFrame({ v: 1, type: 'error', kind: 'exception', message });
    return;
  }

  // ---- 2) 返回值净化：常见类型自动转换，不再因 invalid-output 整次失败 ----
  let sanitizedValue: CodeValue | undefined;
  let valueWarnings: ReturnType<typeof sanitizeForJson>['warnings'] = [];
  if (value !== undefined) {
    const sanitized = sanitizeForJson(value);
    sanitizedValue = sanitized.value;
    valueWarnings = sanitized.warnings;
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

  const resultLine = `${JSON.stringify({
    v: 1,
    type: 'result',
    ...(sanitizedValue !== undefined ? { value: sanitizedValue } : {}),
    ...(valueWarnings.length > 0 ? { valueWarnings } : {}),
    ...(spec ? { ui: spec } : {}),
    uiDiagnostics: diagnostics,
    nestedCalls: callSeq,
    hasUi: !!spec,
  })}\n`;
  if (byteLength(resultLine) > MAX_FRAME_BYTES) {
    await writeFrame({
      v: 1,
      type: 'error',
      kind: 'output-limit',
      message:
        `program result exceeds protocol frame limit (${byteLength(resultLine)} bytes > ${MAX_FRAME_BYTES}); ` +
        'return fewer fields or aggregate inside the program',
    });
    return;
  }
  try {
    stdoutSink.write(resultLine);
    await stdoutSink.flush();
  } catch {
    // 宿主已退出
  }
}

/** 程序包裹函数头（转译与执行共用，保证定位一致） */
const PROGRAM_FUNCTION_HEADER =
  'async function __moss_run_program_2026__(tools, ui, console, process, require, fetch, Bun, globalThis, Function, setTimeout, setInterval, clearTimeout, clearInterval, sleep, now) {';

function wrapProgram(program: string): string {
  return [PROGRAM_FUNCTION_HEADER, program, '}'].join('\n');
}

function formatSyntaxIssue(issue: {
  line: number;
  column: number;
  message: string;
  excerpt: string;
  hint?: string;
}): string {
  return [
    `语法错误：第 ${issue.line} 行第 ${issue.column} 列：${issue.message}`,
    issue.excerpt,
    ...(issue.hint ? [`提示：${issue.hint}`] : []),
  ].join('\n');
}

/** 把 Bun.Transpiler 的 AggregateError 拍平成可读文本 */
function describeTranspileErrors(err: unknown): string {
  const errors = (err as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors
      .slice(0, 6)
      .map((item) => (item instanceof Error ? item.message : String(item)))
      .filter((message) => message.trim() !== '');
    if (messages.length > 0) return messages.join('；');
  }
  return err instanceof Error ? err.message : String(err);
}

/** 程序行数概览：短程序全量、长程序取头尾（都带行号） */
function codeOverview(program: string): string {
  const lines = program.split(/\r\n|\r|\n/);
  const width = String(lines.length).length;
  if (lines.length <= 60) {
    return lines.map((text, index) => `${String(index + 1).padStart(width)} | ${text}`).join('\n');
  }
  const head = lines.slice(0, 30).map((text, index) => `${String(index + 1).padStart(width)} | ${text}`);
  const tail = lines
    .slice(-10)
    .map((text, index) => `${String(lines.length - 10 + index + 1).padStart(width)} | ${text}`);
  return [...head, '…（中间省略）', ...tail].join('\n');
}

/** 转译失败：先按顶层语句二分定位，再给出 TS 解析细节 */
function buildTranspileFailure(program: string, err: unknown): string {
  const detail = describeTranspileErrors(err);
  const located = locateChunkFailure(program, (candidate) => {
    new Bun.Transpiler({ loader: 'ts' }).transformSync(wrapProgram(candidate));
  });
  if (located) {
    const head = located.chunk.split(/\r\n|\r|\n/).slice(0, 8).join('\n');
    return [
      `TypeScript 解析失败：第 ${located.line} 行起的语句无法解析`,
      formatSourceExcerpt(program, located.line, 1),
      `该语句开头：\n${head}`,
      `TS 解析器信息：${detail || 'Parse error'}`,
      '提示：检查该语句的括号/引号/类型注解是否完整；大段 UI 建议拆成变量逐步组装。',
    ].join('\n');
  }
  return [
    'TypeScript 解析失败（无法定位到具体语句）',
    codeOverview(program),
    `TS 解析器信息：${detail || 'Parse error'}`,
  ].join('\n');
}

/** new Function 编译失败：同样按顶层语句二分定位 */
function buildCompileFailure(program: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const located = locateChunkFailure(program, (candidate) => {
    const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(wrapProgram(candidate));
    new Function(`"use strict";\n${js}\nreturn __moss_run_program_2026__;\n//# sourceURL=moss-compile.js`);
  });
  if (located) {
    return [
      `JavaScript 编译失败：第 ${located.line} 行起的语句无法编译`,
      formatSourceExcerpt(program, located.line, 1),
      `编译错误：${detail}`,
      '提示：检查该语句是否使用了子进程不可用的语法（如 import）。',
    ].join('\n');
  }
  return ['JavaScript 编译失败', codeOverview(program), `编译错误：${detail}`].join('\n');
}

/** 被禁用的可调用全局（调用时给出明确原因） */
function blockedCallable(name: string): (...args: unknown[]) => never {
  return (..._args: unknown[]): never => {
    throw new Error(`${name} is not available inside run_code; use tools.* / ui.* instead.`);
  };
}

/** 被禁用的对象型全局（任何属性访问都给出明确原因） */
function blockedObject(name: string): Record<string, never> {
  return new Proxy(Object.create(null) as Record<string, never>, {
    get(): never {
      throw new Error(`${name} is not available inside run_code; use tools.* / ui.* instead.`);
    },
    has(): boolean {
      throw new Error(`${name} is not available inside run_code; use tools.* / ui.* instead.`);
    },
    ownKeys(): Array<string | symbol> {
      throw new Error(`${name} is not available inside run_code; use tools.* / ui.* instead.`);
    },
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
