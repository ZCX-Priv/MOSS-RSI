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
        for (const key of Object.keys(value)) {
          if (!Object.prototype.hasOwnProperty.call(properties, key)) {
            return `${path}.${key} 不是该工具支持的参数`;
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

/** 生成可读的工具签名：name(required: type, optional?: type) */
export function buildToolSignature(name: string, schema: unknown): string {
  if (!isSchemaObject(schema) || !isPlainObject(schema.properties)) {
    return `${name}()`;
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const params = Object.entries(schema.properties).map(([key, prop]) => {
    const propSchema = isSchemaObject(prop) ? prop : {};
    let type = 'unknown';
    if (Array.isArray(propSchema.type)) type = propSchema.type.join('|');
    else if (typeof propSchema.type === 'string') type = propSchema.type;
    else if (Array.isArray(propSchema.enum)) type = 'enum';
    else if (propSchema.anyOf || propSchema.oneOf) type = 'union';
    return `${key}${required.has(key) ? '' : '?'}: ${type}`;
  });
  return `${name}(${params.join(', ')})`;
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
    // 非对象 schema（极少数 MCP 工具）：只做类型检查
    const error = validateValue(args, schema, `${toolName} 参数`);
    return error ? { ok: false, message: formatError(toolName, error, args, schema) } : { ok: true, args };
  }

  let normalized = args;
  let note: string | undefined;
  if (typeof normalized === 'string') {
    const trimmed = normalized.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isPlainObject(parsed)) {
          normalized = parsed;
          note = '字符串参数已自动解析为对象';
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

  const error = validateValue(normalized, schema, toolName);
  if (error) {
    return { ok: false, message: formatError(toolName, error, normalized, schema) };
  }
  return note ? { ok: true, args: normalized, note } : { ok: true, args: normalized };
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
  return (
    `工具 ${toolName} 参数不合法：${error}。\n` +
    `期望签名：${signature}\n` +
    `实际收到：${received || '（undefined）'}`
  );
}
