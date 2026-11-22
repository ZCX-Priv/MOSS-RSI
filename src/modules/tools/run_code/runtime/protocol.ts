// src/modules/tools/run_code/runtime/protocol.ts
// 宿主 ↔ 子进程的行分隔 JSON-RPC 协议。
// 设计要点：
//   - 帧一律单行 JSON（字符串内换行会被 JSON.stringify 转义），每帧 ≤ 64MB；
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

/** 单次程序执行的预算（PTC 不设输出字节预算，仅有协议帧崩溃保护） */
export interface RunLimits {
  timeoutMs: number;
  maxCodeChars: number;
  maxParallelSubCalls: number;
  /** 同时运行的 run_code 子进程上限（0 = 不限制；缺省按 4） */
  maxConcurrentPrograms?: number;
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
  /** 超级PTC：完全体运行时 */
  fullAccess: boolean;
  /** 完全体临时模块路径（仅 fullAccess=true 时存在） */
  programPath?: string;
  /** 生成文件行号 → 原程序行号的偏移（仅 fullAccess=true 时存在） */
  programLineOffset?: number;
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
  | { v: 1; type: 'ui'; ui: unknown; uiDiagnostics?: unknown }
  | { v: 1; type: 'call'; id: string; ns: 'tools'; name: string; args: unknown }
  | {
      v: 1;
      type: 'result';
      value?: CodeValue;
      /** 原始 UISpec（宿主 validate.ts 净化后才可使用） */
      ui?: unknown;
      uiDiagnostics?: unknown;
      /** 返回值自动净化记录（undefined/Date/Map/循环引用等） */
      valueWarnings?: unknown;
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
  | 'syntax'
  | 'output-limit'
  | 'protocol'
  | 'capacity'
  | 'sandbox-unavailable';

/**
 * 控制帧前缀：子进程 stdout 同时承载第三方输出，只有带前缀的行才是控制帧。
 * 不带前缀的行一律按普通日志处理，避免库/孙进程输出打断协议。
 */
export const FRAME_PREFIX = '@@MOSS_PTC@@';

/** 是否为控制帧（用于区分普通 stdout 日志与非法控制帧） */
export function isFrameLine(line: string): boolean {
  return line.startsWith(FRAME_PREFIX);
}

/**
 * 单帧字节上限：崩溃保护，不是输出预算。
 * PTC 返回值/工具结果不截断；只有超过该硬上限才明确报错。
 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

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
  return `${FRAME_PREFIX}${JSON.stringify(frame)}\n`;
}

/** 解析一行控制帧；非控制帧、非法 JSON 或形状不符返回 null */
export function parseFrameLine(line: string): HostToChild | ChildToHost | null {
  if (!isFrameLine(line)) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(FRAME_PREFIX.length));
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


