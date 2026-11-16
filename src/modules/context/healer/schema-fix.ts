// src/modules/context/healer/schema-fix.ts
// JSON Schema 校验 + 自动类型修正（递归版）：
//   - enum 多级近似纠正：大小写/分隔符归一化/唯一前后缀/编辑距离（仅唯一可判定时）
//   - 字符串型数字/布尔 ↔ 目标类型互转（模型常见输出形态）
//   - 单值 → 数组包装（array 参数被模型写成单个标量时）
//   - 嵌套 object / array items 递归校验与修正
//   - required 缺失 / 类型不可修正 → 错误（回传自纠，不猜测补值）
//   - additionalProperties === false 时剔除未知字段，否则保留（保守）

import { editDistance } from './tool-match';

export interface SchemaFixResult {
  /** 修正后的参数（原对象不被修改，返回新对象） */
  args: Record<string, unknown>;
  /** 已执行的自动修正说明 */
  fixes: string[];
  /** 无法自动修正的问题（非空 = valid=false） */
  errors: string[];
  valid: boolean;
}

/** JSON Schema 的鸭子结构（工具 inputSchema 的公共子集） */
interface JsonSchemaLike {
  type?: string | string[];
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  enum?: Array<string | number | boolean | null>;
  additionalProperties?: boolean | JsonSchemaLike;
  items?: JsonSchemaLike;
}

/** 递归上下文：fixes/errors 共享，depth 防止异常 schema 无限展开 */
interface FixContext {
  fixes: string[];
  errors: string[];
  fixEnabled: boolean;
  depth: number;
}

/** 递归深度上限（正常工具 schema 不超过 3 层） */
const MAX_FIX_DEPTH = 4;

/**
 * 校验并尽量修正参数对象。
 * @param args 修复后的参数对象（来自 args-repair）
 * @param inputSchema 工具的 JSON Schema（ToolRegistry.get(name).inputSchema）
 * @param fixEnabled 是否启用自动类型修正（config.context.healer.schemaFix）
 */
export function validateAndFixSchema(
  args: Record<string, unknown>,
  inputSchema: unknown,
  fixEnabled: boolean,
): SchemaFixResult {
  const ctx: FixContext = { fixes: [], errors: [], fixEnabled, depth: 0 };

  if (!inputSchema || typeof inputSchema !== 'object') {
    // 无 schema 可校验：直接放行（工具自行处理）
    return { args, fixes: ctx.fixes, errors: ctx.errors, valid: true };
  }
  const schema = inputSchema as JsonSchemaLike;
  if (schema.type && schema.type !== 'object' && !(Array.isArray(schema.type) && schema.type.includes('object'))) {
    // 非 object 型 schema：跳过校验（当前所有工具均为 object 参数）
    return { args, fixes: ctx.fixes, errors: ctx.errors, valid: true };
  }

  const value = fixNode(args, schema, '', ctx);
  const out = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : args;
  return { args: out, fixes: ctx.fixes, errors: ctx.errors, valid: ctx.errors.length === 0 };
}

/** 标量判定（数组单值包装仅接受非空标量） */
function isNonEmptyScalar(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  return typeof value === 'number' || typeof value === 'boolean';
}

/** 参数路径拼接：根路径为空时不带前缀 */
function childPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

/** 数组元素路径 */
function itemPath(path: string, index: number): string {
  return `${path}[${index}]`;
}

/**
 * 递归修正单个值。
 * @param path 用于错误/修复说明的可读路径（如 edits[0].oldString）
 */
function fixNode(value: unknown, schema: JsonSchemaLike, path: string, ctx: FixContext): unknown {
  if (value === undefined || value === null) return value;
  if (ctx.depth > MAX_FIX_DEPTH) return value; // 异常 schema：放行交给工具自身

  // 1. enum 多级纠正（枚举值一律是标量）
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return fixEnumValue(value, schema.enum, path, ctx);
  }

  // 部分 MCP/自定义 schema 省略 type，但带 properties/required：按 object 处理（保持旧版校验行为）
  const declaredType = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  const type = declaredType ?? (schema.properties || schema.required ? 'object' : undefined);
  if (!type) return value;

  // 2. 数组：单值包装 + items 递归
  if (type === 'array') {
    let arr: unknown[];
    if (Array.isArray(value)) {
      arr = value;
    } else if (isNonEmptyScalar(value) && ctx.fixEnabled) {
      arr = [value];
      ctx.fixes.push(`parameter "${path}": wrapped single ${typeof value} into array`);
    } else {
      ctx.errors.push(`parameter "${path}": expected array, got ${describeType(value)}`);
      return value;
    }
    if (!schema.items) return arr;
    ctx.depth++;
    const fixed = arr.map((item, i) => fixNode(item, schema.items as JsonSchemaLike, itemPath(path, i), ctx));
    ctx.depth--;
    return fixed;
  }

  // 3. 对象：递归 properties / required / additionalProperties
  if (type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      ctx.errors.push(`parameter "${path}": expected object, got ${describeType(value)}`);
      return value;
    }
    ctx.depth++;
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    const props = schema.properties ?? {};
    for (const [key, propSchema] of Object.entries(props)) {
      if (!(key in out)) continue;
      out[key] = fixNode(out[key], propSchema, childPath(path, key), ctx);
    }
    for (const req of schema.required ?? []) {
      if (!(req in out) || out[req] === undefined || out[req] === null) {
        ctx.errors.push(`missing required parameter "${childPath(path, req)}"`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(out)) {
        if (!(key in props)) {
          delete out[key];
          ctx.fixes.push(`removed unknown parameter "${childPath(path, key)}" (schema forbids additional properties)`);
        }
      }
    }
    ctx.depth--;
    return out;
  }

  // 4. 基础类型修正（与原实现保持一致）
  if (type === 'string' && typeof value !== 'string') {
    if (ctx.fixEnabled && (typeof value === 'number' || typeof value === 'boolean')) {
      ctx.fixes.push(`parameter "${path}": converted ${typeof value} to string`);
      return String(value);
    }
    ctx.errors.push(`parameter "${path}": expected string, got ${describeType(value)}`);
    return value;
  }

  if (type === 'number' || type === 'integer') {
    if (typeof value === 'number') {
      if (type === 'integer' && !Number.isInteger(value) && ctx.fixEnabled) {
        ctx.fixes.push(`parameter "${path}": truncated ${value} to integer`);
        return Math.trunc(value);
      }
      return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const num = Number(value);
      if (Number.isFinite(num)) {
        if (ctx.fixEnabled) {
          const final = type === 'integer' ? Math.trunc(num) : num;
          ctx.fixes.push(`parameter "${path}": converted string "${value}" to ${type}`);
          return final;
        }
      }
    }
    ctx.errors.push(`parameter "${path}": expected ${type}, got ${describeType(value)}`);
    return value;
  }

  if (type === 'boolean' && typeof value !== 'boolean') {
    if (ctx.fixEnabled && typeof value === 'string') {
      const lower = value.trim().toLowerCase();
      if (lower === 'true' || lower === 'false') {
        ctx.fixes.push(`parameter "${path}": converted string "${value}" to boolean`);
        return lower === 'true';
      }
    }
    ctx.errors.push(`parameter "${path}": expected boolean, got ${describeType(value)}`);
    return value;
  }

  return value;
}

/** 人类可读类型（数组与 null 不落入 typeof 的 object 歧义） */
function describeType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/** 归一化 enum 比较键：小写 + 去分隔符/空白 */
function normalizeEnumKey(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * enum 多级纠正（仅在唯一可判定时生效）：
 * 精确 → 大小写不敏感 → 归一化 → 唯一前后缀 → 编辑距离唯一最近邻。
 */
function fixEnumValue(
  value: unknown,
  enumValues: Array<string | number | boolean | null>,
  path: string,
  ctx: FixContext,
): unknown {
  if (enumValues.includes(value as string | number | boolean | null)) return value;

  if (ctx.fixEnabled && typeof value === 'string') {
    const raw = value;
    const lower = raw.toLowerCase();

    // 大小写不敏感
    const ci = enumValues.filter((e) => String(e).toLowerCase() === lower);
    if (ci.length === 1) return acceptEnum(ci[0], raw, path, ctx, 'case-insensitive');

    // 分隔符/空白归一化（read_only → readonly）
    const norm = normalizeEnumKey(raw);
    const normalized = enumValues.filter((e) => normalizeEnumKey(String(e)) === norm);
    if (normalized.length === 1) return acceptEnum(normalized[0], raw, path, ctx, 'normalized');

    // 唯一前后缀（exec 是 execute 的前缀；双方至少 3 字符，避免过度猜测）
    const stem = enumValues.filter((e) => {
      const candidate = String(e).toLowerCase();
      if (Math.min(candidate.length, lower.length) < 3) return false;
      return candidate.startsWith(lower) || lower.startsWith(candidate)
        || candidate.endsWith(lower) || lower.endsWith(candidate);
    });
    if (stem.length === 1) return acceptEnum(stem[0], raw, path, ctx, 'prefix');

    // 编辑距离唯一最近邻（长值放宽到 2，短值只允许 1）
    const maxDistance = raw.length >= 8 ? 2 : raw.length >= 4 ? 1 : 0;
    if (maxDistance > 0) {
      const scored = enumValues
        .map((e) => ({ value: e, dist: editDistance(lower, String(e).toLowerCase()) }))
        .filter((x) => x.dist <= maxDistance)
        .sort((a, b) => a.dist - b.dist);
      if (scored.length === 1 || (scored.length > 1 && scored[0].dist < scored[1].dist)) {
        return acceptEnum(scored[0].value, raw, path, ctx, 'fuzzy');
      }
    }
  }

  ctx.errors.push(
    `parameter "${path}": value "${String(value)}" not in enum [${enumValues.map(String).join(', ')}]`,
  );
  return value;
}

/** 接受 enum 纠正：记录修复说明并返回目标值 */
function acceptEnum(
  target: string | number | boolean | null,
  raw: string,
  path: string,
  ctx: FixContext,
  reason: string,
): unknown {
  ctx.fixes.push(
    `parameter "${path}": corrected "${raw}" to enum value "${String(target)}" (${reason})`,
  );
  return target;
}
