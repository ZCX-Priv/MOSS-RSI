// src/modules/tools/run_code/runtime/schema.ts
// PTC 嵌套调用的轻量 JSON Schema 校验与工具签名生成。
//
// 目标：在宿主分发前拦住「缺必填 / 类型错 / 参数名拼错」的高频失误，
// 并把「期望签名 + 实际入参」回给程序内的 catch，模型一次即可修正。
// 约束：只校验明确声明的关键字；未知关键字 / 未声明字段默认放行（兼容宽松 MCP schema）。

export interface ValidationOk {
  ok: true;
  args: unknown;
  /** 规范化提示（如字符串化 JSON 被自动解析） */
  note?: string;
}

export interface ValidationFail {
  ok: false;
  message: string;
}

export type ValidationResult = ValidationOk | ValidationFail;

interface JsonSchemaLike {
  type?: string | string[];
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  items?: JsonSchemaLike;
  enum?: unknown[];
  anyOf?: JsonSchemaLike[];
  oneOf?: JsonSchemaLike[];
  additionalProperties?: boolean | JsonSchemaLike;
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSchemaObject(value: unknown): value is JsonSchemaLike {
  return isPlainObject(value);
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      // 未知类型不拒绝（如某些 MCP schema 使用自定义关键字）
      return true;
  }
}

function matchesTypeList(value: unknown, type: string | string[] | undefined): boolean {
  if (!type) return true;
  if (Array.isArray(type)) return type.some((t) => matchesType(value, t));
  return matchesType(value, type);
}

function matchesEnum(value: unknown, values: unknown[]): boolean {
  return values.some((candidate) => {
    if (Object.is(candidate, value)) return true;
    try {
      return JSON.stringify(candidate) === JSON.stringify(value);
    } catch {
      return false;
    }
  });
}

function valueLabel(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (isPlainObject(value)) return 'object';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
}

/** 递归校验；返回第一条可读错误，通过返回 null */
function validateValue(
  value: unknown,
  schema: JsonSchemaLike,
  path: string,
): string | null {
  if (schema.enum && Array.isArray(schema.enum) && !matchesEnum(value, schema.enum)) {
    return `${path} 必须是 ${schema.enum.map((v) => JSON.stringify(v)).join(' | ')}（收到 ${valueLabel(value)}）`;
  }

  const combinator = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(combinator) && combinator.length > 0) {
    const passed = combinator.some((candidate) => validateValue(value, candidate, path) === null);
    if (!passed) {
      return `${path} 不匹配任何候选结构（收到 ${valueLabel(value)}）`;
    }
  }

  if (!matchesTypeList(value, schema.type)) {
    return `${path} 应为 ${Array.isArray(schema.type) ? schema.type.join('|') : schema.type}（收到 ${valueLabel(value)}）`;
  }

  if (isPlainObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
        return `${path}.${key} 为必填参数（缺少）`;
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : undefined;
    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) continue;
        const child = validateValue(value[key], propSchema, `${path}.${key}`);
        if (child) return child;
      }
      if (schema.additionalProperties === false) {
        const allowed = Object.keys(properties).join(', ');
        for (const key of Object.keys(value)) {
          if (!Object.prototype.hasOwnProperty.call(properties, key)) {
            return `${path}.${key} 不是该工具支持的参数（可用参数：${allowed}）`;
          }
        }
      }
    }
  }

  if (Array.isArray(value) && isSchemaObject(schema.items)) {
    for (let i = 0; i < value.length && i < 100; i++) {
      const child = validateValue(value[i], schema.items, `${path}[${i}]`);
      if (child) return child;
    }
  }

  return null;
}

/** 生成可读的工具签名：name(required: type, optional?: type = default) */
export function buildToolSignature(name: string, schema: unknown): string {
  if (!isSchemaObject(schema) || !isPlainObject(schema.properties)) {
    return `${name}()`;
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const params = Object.entries(schema.properties).map(([key, prop]) => {
    const propSchema = isSchemaObject(prop) ? prop : {};
    const type = describeSchemaType(propSchema, 1);
    const fallback = propSchema.default;
    const suffix = fallback === undefined ? '' : ` = ${formatDefault(fallback)}`;
    return `${key}${required.has(key) ? '' : '?'}: ${type}${suffix}`;
  });
  // 不截断：签名必须完整（截断会隐藏后面的必填参数，反而制造调用错误）
  return `${name}(${params.join(', ')})`;
}

/** 类型描述：枚举内联（最多 5 个值）、对象展开一层、数组元素类型 */
function describeSchemaType(schema: JsonSchemaLike, depth: number): string {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum.slice(0, 5).map((v) => JSON.stringify(v)).join('|');
    return schema.enum.length > 5 ? `${values}|…` : values;
  }
  if (Array.isArray(schema.type)) return schema.type.join('|');
  const type = typeof schema.type === 'string' ? schema.type : undefined;
  if (type === 'object' && depth > 0 && isPlainObject(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const entries = Object.entries(schema.properties);
    const inner = entries
      .slice(0, 6)
      .map(([key, prop]) => {
        const propSchema = isSchemaObject(prop) ? prop : {};
        return `${key}${required.has(key) ? '' : '?'}: ${describeSchemaType(propSchema, depth - 1)}`;
      })
      .join('; ');
    return `{ ${inner}${entries.length > 6 ? '; …' : ''} }`;
  }
  if (type === 'array' && depth > 0 && isSchemaObject(schema.items)) {
    return `${describeSchemaType(schema.items, depth - 1)}[]`;
  }
  if (typeof type === 'string') return type;
  if (schema.anyOf || schema.oneOf) return 'union';
  return 'unknown';
}

function formatDefault(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** 键名归一：忽略下划线/连字符/空格与大小写（timeout_ms ↔ timeoutMs） */
function normalizeKeyName(key: string): string {
  return key.replace(/[_\-\s]/g, '').toLowerCase();
}

function levenshtein(a: string, b: string): number {
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

interface NormalizeNotes {
  notes: string[];
}

/**
 * 参数宽松修复：键名别名/近匹配、类型转换、枚举归一、默认值补齐。
 * 只修「明显可修」的问题；修不了的原样留下，由 validateValue 给出可读错误。
 */
function coerceArguments(
  value: unknown,
  schema: JsonSchemaLike,
  path: string,
  state: NormalizeNotes,
  depth = 0,
): unknown {
  if (depth > 8) return value;

  // 枚举归一（字符串大小写/空白；数字/布尔同理）
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    for (const candidate of schema.enum) {
      if (Object.is(candidate, value)) return value;
      if (typeof candidate === 'string' && typeof value === 'string') {
        if (candidate.trim().toLowerCase() === value.trim().toLowerCase()) {
          state.notes.push(`${path}: "${value}" → "${candidate}"`);
          return candidate;
        }
      }
      if (typeof candidate === 'number' && typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        if (Number.isFinite(n) && n === candidate) {
          state.notes.push(`${path}: "${value}" → ${candidate}`);
          return candidate;
        }
      }
      if (typeof candidate === 'boolean' && typeof value === 'string') {
        const lowered = value.trim().toLowerCase();
        if ((candidate && lowered === 'true') || (!candidate && lowered === 'false')) {
          state.notes.push(`${path}: "${value}" → ${candidate}`);
          return candidate;
        }
      }
    }
    return value;
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  // 对象：JSON 字符串 → 解析；键名修复；递归；默认值
  if (type === 'object' || isPlainObject(schema.properties) || Array.isArray(schema.required)) {
    let obj = value;
    if (typeof obj === 'string') {
      const trimmed = obj.trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (isPlainObject(parsed)) {
            state.notes.push(`${path}: 字符串 JSON → 对象`);
            obj = parsed;
          }
        } catch {
          // 保持原样，交给校验报错
        }
      }
    }
    if (!isPlainObject(obj)) return obj;

    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const fixed: Record<string, unknown> = {};
    const normalizedToProps = new Map<string, string>();
    for (const key of Object.keys(properties)) {
      normalizedToProps.set(normalizeKeyName(key), key);
    }

    for (const [rawKey, rawValue] of Object.entries(obj)) {
      let key = rawKey;
      if (!Object.prototype.hasOwnProperty.call(properties, rawKey)) {
        const normalized = normalizeKeyName(rawKey);
        const exact = normalizedToProps.get(normalized);
        if (exact && !Object.prototype.hasOwnProperty.call(obj, exact)) {
          state.notes.push(`${path}.${rawKey} → ${exact}`);
          key = exact;
        } else {
          // 近匹配（编辑距离 ≤ 1）只在唯一命中的情况下改名（pth → path）
          const candidates = Object.keys(properties).filter((candidate) => {
            const a = normalizeKeyName(candidate);
            return a !== normalized && levenshtein(a, normalized) <= 1;
          });
          if (candidates.length === 1 && !Object.prototype.hasOwnProperty.call(obj, candidates[0])) {
            state.notes.push(`${path}.${rawKey} → ${candidates[0]}`);
            key = candidates[0];
          }
        }
      }
      const propSchema = isSchemaObject(properties[key]) ? properties[key] : undefined;
      fixed[key] = propSchema
        ? coerceArguments(rawValue, propSchema, `${path}.${key}`, state, depth + 1)
        : rawValue;
    }

    // 缺失但 schema 声明了 default → 补齐
    for (const [key, prop] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(fixed, key)) continue;
      const propSchema = isSchemaObject(prop) ? prop : {};
      if (propSchema.default !== undefined) {
        fixed[key] = propSchema.default;
        state.notes.push(`${path}.${key}: 补默认值 ${formatDefault(propSchema.default)}`);
      }
    }
    return fixed;
  }

  // 数组：单值 → [单值]；逐项递归
  if (type === 'array') {
    let list = value;
    if (!Array.isArray(list)) {
      list = [list];
      state.notes.push(`${path}: 单值 → 数组`);
    }
    const items = isSchemaObject(schema.items) ? schema.items : undefined;
    return items
      ? (list as unknown[]).map((item, index) => coerceArguments(item, items, `${path}[${index}]`, state, depth + 1))
      : list;
  }

  // 数字
  if (type === 'number' || type === 'integer') {
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      if (Number.isFinite(n)) {
        state.notes.push(`${path}: "${value}" → ${n}`);
        return type === 'integer' ? Math.trunc(n) : n;
      }
    }
    if (typeof value === 'boolean') {
      state.notes.push(`${path}: ${value} → ${value ? 1 : 0}`);
      return value ? 1 : 0;
    }
    return value;
  }

  // 布尔
  if (type === 'boolean') {
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      if (lowered === 'true') {
        state.notes.push(`${path}: "true" → true`);
        return true;
      }
      if (lowered === 'false') {
        state.notes.push(`${path}: "false" → false`);
        return false;
      }
    }
    if (typeof value === 'number' && (value === 0 || value === 1)) {
      state.notes.push(`${path}: ${value} → ${value === 1}`);
      return value === 1;
    }
    return value;
  }

  // 字符串：不做数字→文本的隐式转换（避免把 path: 123 静默变成 "123" 造成误操作）；
  // 反方向的「数字字符串 → 数字」是安全且高频的，已在上方处理。
  return value;
}

/** 校验并规范化 PTC 嵌套调用参数 */
export function validateToolArguments(
  toolName: string,
  args: unknown,
  schema: unknown,
): ValidationResult {
  if (!isSchemaObject(schema)) {
    return { ok: true, args };
  }
  const expectsObject =
    schema.type === 'object' ||
    isPlainObject(schema.properties) ||
    Array.isArray(schema.required);
  if (!expectsObject) {
    // 非对象 schema（极少数 MCP 工具）：先做宽松修复，再类型检查
    const state: NormalizeNotes = { notes: [] };
    const normalized = coerceArguments(args, schema, toolName, state);
    const error = validateValue(normalized, schema, `${toolName} 参数`);
    if (error) return { ok: false, message: formatError(toolName, error, normalized, schema) };
    return state.notes.length > 0
      ? { ok: true, args: normalized, note: state.notes.join('；') }
      : { ok: true, args: normalized };
  }

  let normalized = args;
  const state: NormalizeNotes = { notes: [] };
  if (normalized === null || normalized === undefined) {
    normalized = {};
  }
  if (typeof normalized === 'string') {
    const trimmed = normalized.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isPlainObject(parsed)) {
          normalized = parsed;
          state.notes.push('字符串参数已自动解析为对象');
        }
      } catch {
        // 下面按「参数应为对象」处理
      }
    }
  }

  if (!isPlainObject(normalized)) {
    return {
      ok: false,
      message: formatError(
        toolName,
        `${toolName} 参数应为对象（收到 ${valueLabel(normalized)}）`,
        normalized,
        schema,
      ),
    };
  }

  const coerced = coerceArguments(normalized, schema, toolName, state);
  const error = validateValue(coerced, schema, toolName);
  if (error) {
    return { ok: false, message: formatError(toolName, error, coerced, schema) };
  }
  return state.notes.length > 0
    ? { ok: true, args: coerced, note: state.notes.join('；') }
    : { ok: true, args: coerced };
}

function formatError(toolName: string, error: string, args: unknown, schema: JsonSchemaLike): string {
  const signature = buildToolSignature(toolName, schema);
  let received = '';
  try {
    received = JSON.stringify(args);
  } catch {
    received = String(args);
  }
  if (received.length > 400) received = `${received.slice(0, 400)}…`;
  const example = buildExampleArgs(schema);
  return (
    `工具 ${toolName} 参数不合法：${error}。\n` +
    `期望签名：${signature}\n` +
    `实际收到：${received || '（undefined）'}` +
    (example ? `\n修复示例：${example}` : '') +
    '\n提示：参数名必须与签名完全一致；数字/布尔不要加引号；枚举值照抄。'
  );
}

/** 按 required 生成最小合法参数示例（最多 6 个字段） */
function buildExampleArgs(schema: JsonSchemaLike): string | undefined {
  if (!isPlainObject(schema.properties)) return undefined;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.length === 0) return undefined;
  const example: Record<string, unknown> = {};
  for (const key of required.slice(0, 6)) {
    const prop = schema.properties[key];
    const propSchema = isSchemaObject(prop) ? prop : {};
    if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) {
      example[key] = propSchema.enum[0];
      continue;
    }
    const type = Array.isArray(propSchema.type) ? propSchema.type[0] : propSchema.type;
    if (type === 'number' || type === 'integer') example[key] = 0;
    else if (type === 'boolean') example[key] = false;
    else if (type === 'array') example[key] = [];
    else if (type === 'object') example[key] = {};
    else example[key] = '<string>';
  }
  try {
    return JSON.stringify(example);
  } catch {
    return undefined;
  }
}
