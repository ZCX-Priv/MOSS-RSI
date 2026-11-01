// src/modules/tools/run_code/runtime/sanitize.ts
// 跨边界 JSON 值的「净化」而非拒绝：
//   - 程序返回值里的 undefined/Date/Map/Set/BigInt/NaN/循环引用等会被转换为合法 JSON，
//     并记录可读警告（不再让整次运行因 invalid-output 失败）；
//   - 工具参数仍要求 lossless JSON，但 findJsonViolation 会给出精确路径，便于模型自纠。

import type { CodeValue } from './protocol';

export interface SanitizeWarning {
  /** 值路径，如 root.items[2] / root.user */
  path: string;
  /** 转换原因（人类可读） */
  reason: string;
}

export interface SanitizeResult {
  value: CodeValue;
  warnings: SanitizeWarning[];
}

const MAX_DEPTH = 64;
const MAX_WARNINGS = 100;
const OMIT = Symbol('omit');

type Sanitized = CodeValue | typeof OMIT;

/** 判断是否为普通对象（Object 原型或 null 原型） */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 净化任意值到合法 CodeValue；永不抛错。 */
export function sanitizeForJson(input: unknown): SanitizeResult {
  const warnings: SanitizeWarning[] = [];
  const ancestors = new WeakSet<object>();

  const warn = (path: string, reason: string): void => {
    if (warnings.length >= MAX_WARNINGS) return;
    warnings.push({ path, reason });
  };

  const visit = (value: unknown, path: string, depth: number): Sanitized => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (Number.isFinite(value)) return value;
      warn(path, `${String(value)}（非有限数，转为 null）`);
      return null;
    }
    if (typeof value === 'undefined') {
      warn(path, 'undefined（已省略）');
      return OMIT;
    }
    if (typeof value === 'bigint') {
      warn(path, 'BigInt（转为十进制字符串）');
      return value.toString(10);
    }
    if (typeof value === 'function') {
      warn(path, '函数（已省略）');
      return OMIT;
    }
    if (typeof value === 'symbol') {
      warn(path, 'Symbol（已省略）');
      return OMIT;
    }
    if (typeof value !== 'object') {
      warn(path, `${typeof value}（已转为字符串）`);
      return String(value);
    }

    if (depth > MAX_DEPTH) {
      warn(path, `嵌套超过 ${MAX_DEPTH} 层（已截断）`);
      return '[MaxDepth]';
    }

    // 循环引用：用祖先集合判断（同一对象在不同分支重复出现是合法的）
    if (ancestors.has(value)) {
      warn(path, '循环引用（转为 "[Circular]"）');
      return '[Circular]';
    }

    if (value instanceof Date) {
      warn(path, 'Date（转为 ISO 字符串）');
      const time = value.getTime();
      if (Number.isNaN(time)) return 'Invalid Date';
      return value.toISOString();
    }
    if (value instanceof RegExp) {
      warn(path, 'RegExp（转为字符串）');
      return value.toString();
    }
    if (value instanceof Error) {
      warn(path, 'Error（转为对象）');
      const converted: { [key: string]: CodeValue } = {
        name: value.name || 'Error',
        message: value.message,
      };
      if (typeof value.stack === 'string') converted.stack = value.stack;
      return converted;
    }
    if (value instanceof Map) {
      warn(path, 'Map（转为二维数组）');
      ancestors.add(value);
      const entries: CodeValue[] = [];
      for (const [key, entryValue] of value.entries()) {
        const cleanKey = visit(key, `${path}[key]`, depth + 1);
        const cleanValue = visit(entryValue, `${path}[value]`, depth + 1);
        entries.push([cleanKey === OMIT ? null : cleanKey, cleanValue === OMIT ? null : cleanValue]);
      }
      ancestors.delete(value);
      return entries;
    }
    if (value instanceof Set) {
      warn(path, 'Set（转为数组）');
      ancestors.add(value);
      const items: CodeValue[] = [];
      let index = 0;
      for (const entryValue of value.values()) {
        const clean = visit(entryValue, `${path}[${index}]`, depth + 1);
        items.push(clean === OMIT ? null : clean);
        index += 1;
      }
      ancestors.delete(value);
      return items;
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      warn(path, '二进制数据（转为描述对象）');
      const bytes = value instanceof ArrayBuffer ? value.byteLength : value.byteLength;
      return { type: value.constructor?.name ?? 'Binary', byteLength: bytes };
    }

    ancestors.add(value);
    let result: Sanitized;
    if (Array.isArray(value)) {
      const items: CodeValue[] = [];
      for (let i = 0; i < value.length; i++) {
        const clean = visit(value[i], `${path}[${i}]`, depth + 1);
        items.push(clean === OMIT ? null : clean);
      }
      result = items;
    } else if (isPlainObject(value)) {
      const out: { [key: string]: CodeValue } = {};
      for (const [key, entryValue] of Object.entries(value)) {
        const clean = visit(entryValue, `${path}.${key}`, depth + 1);
        if (clean !== OMIT) out[key] = clean;
      }
      result = out;
    } else {
      // 类实例：按自有可枚举属性转普通对象（保留数据，不保留原型行为）
      warn(path, `${value.constructor?.name ?? 'Object'} 实例（转为普通对象）`);
      const out: { [key: string]: CodeValue } = {};
      for (const [key, entryValue] of Object.entries(value)) {
        const clean = visit(entryValue, `${path}.${key}`, depth + 1);
        if (clean !== OMIT) out[key] = clean;
      }
      result = out;
    }
    ancestors.delete(value);
    return result;
  };

  let root: Sanitized = null;
  try {
    root = visit(input, 'root', 0);
  } catch (err) {
    warn('root', `净化失败：${err instanceof Error ? err.message : String(err)}（已回退为 null）`);
    root = null;
  }
  return { value: root === OMIT ? null : root, warnings };
}

/**
 * 找出第一个不符合 lossless JSON 的值（工具参数用）。
 * 返回 undefined 表示完全合法；否则给出精确路径与原因。
 */
export function findJsonViolation(
  input: unknown,
  path = 'args',
): { path: string; reason: string } | null {
  const ancestors = new WeakSet<object>();

  const visit = (value: unknown, currentPath: string, depth: number): { path: string; reason: string } | null => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? null : { path: currentPath, reason: `${String(value)} is not a finite number` };
    }
    if (typeof value === 'undefined') return { path: currentPath, reason: 'undefined is not allowed' };
    if (typeof value === 'function') return { path: currentPath, reason: 'function is not allowed' };
    if (typeof value === 'symbol') return { path: currentPath, reason: 'symbol is not allowed' };
    if (typeof value === 'bigint') return { path: currentPath, reason: 'BigInt is not allowed (convert to string)' };
    if (typeof value !== 'object') return { path: currentPath, reason: `${typeof value} is not allowed` };
    if (depth > 32) return { path: currentPath, reason: 'nesting exceeds 32 levels' };
    if (ancestors.has(value)) return { path: currentPath, reason: 'cyclic reference is not allowed' };

    if (!Array.isArray(value) && !isPlainObject(value)) {
      return {
        path: currentPath,
        reason: `${value.constructor?.name ?? 'object'} is not allowed (use a plain object/array/scalar)`,
      };
    }

    ancestors.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const hit = visit(value[i], `${currentPath}[${i}]`, depth + 1);
        if (hit) {
          ancestors.delete(value);
          return hit;
        }
      }
    } else {
      for (const [key, entryValue] of Object.entries(value)) {
        const hit = visit(entryValue, `${currentPath}.${key}`, depth + 1);
        if (hit) {
          ancestors.delete(value);
          return hit;
        }
      }
    }
    ancestors.delete(value);
    return null;
  };

  try {
    return visit(input, path, 0);
  } catch (err) {
    return {
      path,
      reason: `arguments could not be inspected: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
