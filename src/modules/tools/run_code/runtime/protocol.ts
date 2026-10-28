// src/modules/tools/run_code/runtime/protocol.ts
// 宿主 ↔ 子进程的行分隔 JSON-RPC 协议。
// 设计要点：
//   - 帧一律单行 JSON（字符串内换行会被 JSON.stringify 转义），每帧 ≤ 1MB；
//   - 程序失败是 result 字段（error kind），不是宿主异常；
//   - 工具调用只允许子进程请求，宿主校验 allowlist 后才执行；
//   - 参数/返回值必须是 lossless JSON（拒绝 undefined/函数/BigInt/循环引用/非有限数）。

/** 跨边界 JSON 值 */
export type CodeValue =
  | null
  | boolean
  | number
  | string
  | CodeValue[]
  | { [key: string]: CodeValue };

/** 单次程序执行的预算 */
export interface RunLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  maxCodeChars: number;
  maxParallelSubCalls: number;
}

/** 宿主 → 子进程：启动一次程序 */
export interface RunFrame {
  v: 1;
  type: 'run';
  program: string;
  /** 允许调用的工具名（子进程 Proxy 与宿主双重校验） */
  bindings: string[];
  cwd: string;
  limits: RunLimits;
  uiEnabled: boolean;
}

/** 宿主 → 子进程：工具结果 / 中止 */
export type HostToChild =
  | RunFrame
  | { v: 1; type: 'tool-result'; id: string; ok: true; value: CodeValue }
  | { v: 1; type: 'tool-result'; id: string; ok: false; error: { name: string; message: string } }
  | { v: 1; type: 'abort' };

/** 子进程 → 宿主：就绪 / 日志 / 工具调用 / 结果 / 错误 */
export type ChildToHost =
  | { v: 1; type: 'ready' }
  | { v: 1; type: 'log'; text: string }
  | { v: 1; type: 'call'; id: string; ns: 'tools'; name: string; args: unknown }
  | {
      v: 1;
      type: 'result';
      value?: CodeValue;
      /** 原始 UISpec（宿主 validate.ts 净化后才可使用） */
      ui?: unknown;
      uiDiagnostics?: unknown;
      nestedCalls?: number;
      hasUi?: boolean;
    }
  | { v: 1; type: 'error'; kind: CodeFailureKind; message: string };

/** 失败的语义分类（彼此正交，便于模型自纠） */
export type CodeFailureKind =
  | 'exception'
  | 'timeout'
  | 'abort'
  | 'worker-exit'
  | 'invalid-output'
  | 'output-limit'
  | 'protocol'
  | 'sandbox-unavailable';

/** 单帧字节上限 */
export const MAX_FRAME_BYTES = 1_048_576;

/** 单次工具结果进入程序前的字节上限（防止把巨型文件直接塞进子进程） */
export const MAX_TOOL_RESULT_BYTES = 524_288;

/** 控制帧 call id 形状 */
export const CALL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 子进程 ToolCallError 的 name（宿主回传错误时使用） */
export const TOOL_CALL_ERROR_NAME = 'ToolCallError';

/** lossless JSON 判定（深度上限 32） */
export function isLosslessJsonValue(value: unknown, depth = 0): value is CodeValue {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((v) => v !== undefined && isLosslessJsonValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (v === undefined || !isLosslessJsonValue(v, depth + 1)) return false;
    }
    return true;
  }
  return false;
}

/** 序列化一帧（调用方负责检查字节上限） */
export function encodeFrame(frame: HostToChild | ChildToHost): string {
  return `${JSON.stringify(frame)}\n`;
}

/** 解析一行帧；非法 JSON 或形状不符返回 null */
export function parseFrameLine(line: string): HostToChild | ChildToHost | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const frame = parsed as Record<string, unknown>;
    if (frame.v !== 1 || typeof frame.type !== 'string') return null;
    return parsed as HostToChild | ChildToHost;
  } catch {
    return null;
  }
}

/** UTF-8 字节数 */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 截断字符串到指定字节数以内（按字符回退，避免截断多字节字符） */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

/** 判断字符串是否可作为命名空间全局名（tools/ui；语言可移植标识符） */
export function isPortableNamespaceName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== 'console' && name !== '__proto__';
}
