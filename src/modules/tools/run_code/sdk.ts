// src/modules/tools/run_code/sdk.ts
// 代码模式的系统提示附加段：JSON Schema → TypeScript SDK 声明 + 使用规则 + ui 构建器声明。
// 输出必须字节稳定（工具按名字排序、固定格式），否则会破坏前缀缓存。

import { buildUiSdkText } from './ui/catalog';

export interface CodeModeToolSchema {
  name: string;
  description: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

/** 与 context/compiler 的 PromptExtraSection 结构兼容（避免 tools → context 的运行时依赖） */
export interface CodeModePromptSection {
  id: string;
  title: string;
  content: string;
}

export interface BuildCodeModePromptInput {
  presentation: 'standard' | 'ptc';
  uiEnabled: boolean;
  tools: CodeModeToolSchema[];
}

/** 生成系统提示附加段；不该出现代码模式时返回 null。 */
export function buildCodeModePromptExtras(input: BuildCodeModePromptInput): CodeModePromptSection | null {
  const tools = input.tools
    .filter((tool) => tool.name !== 'run_code')
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const parts: string[] = [];

  if (input.presentation === 'ptc') {
    parts.push('## 代码模式（PTC）');
    parts.push(
      '本次请求只暴露 `run_code`。所有工具都必须通过程序内的 `await tools.<name>(args)` 调用；直接调用不存在的原生工具会失败。',
    );
    parts.push(buildToolsSdk(tools));
    parts.push(
      '',
      '最小示例（工具名与参数以下方 SDK 声明为准）：',
      '```ts',
      "const a = await tools.read({ path: 'a.txt' });",
      "const b = await tools.read({ path: 'b.txt' });",
      'return { a: String(a).slice(0, 200), b: String(b).slice(0, 200) };',
      '```',
    );
  } else {
    parts.push('## 代码模式');
    parts.push(
      '原生工具仍然可用；当一个任务需要 2 步以上的工具调用、循环、条件分支、并发或结果后处理时，优先写一段 `run_code` 程序，把中间结果留在程序里。',
    );
    parts.push(
      tools.length > 0
        ? `程序内的 \`tools\` 镜像当前原生工具（参数签名见请求中的原生工具 schema）：\n${tools
            .map((tool) => `\`${tool.name}\``)
            .join('、')}`
        : '程序内的 `tools` 镜像当前原生工具（当前没有可用工具）。',
    );
  }

  parts.push(
    '',
    '### 使用规则',
    '- `code` 是一个 async TypeScript 函数体；支持顶层 `await` 与 `return`，类型注解会被剥离。',
    '- 工具失败会在程序内抛出可 `try/catch` 的 `ToolCallError`；错误对象带 `toolName`。',
    '- 只有 `return` 的值与 `console.log` 的文本会回到模型上下文；中间结果不会自动回灌，请主动裁剪。',
    '- 只读工具可以用 `Promise.all` 并发；写操作/终端/子代理等会按提交顺序独占执行。',
    '- 不要 `import`/`require`/`fetch`/使用 `Bun`；程序只应依赖注入的 `tools`、`ui`、`console` 与受限 `process`。',
    '- 返回值必须是 lossless JSON（不能含 undefined/函数/BigInt/循环引用/非有限数）。',
    '- 程序有执行预算与输出字节上限；死循环会被强杀，日志不要打印大对象。',
  );

  if (input.uiEnabled) {
    parts.push('', buildUiSdkText());
    parts.push(
      '',
      '界面会直接渲染在「代码」步骤下方；最终正文用一两句话说明即可，不要复述界面里的内容。',
    );
  } else {
    parts.push('', '### ui 构建器', '本次会话关闭了 Intelligent UI（`ui` 命名空间不可用）。');
  }

  return {
    id: 'code-mode-sdk',
    title: input.presentation === 'ptc' ? '代码模式（PTC）' : '代码模式',
    content: parts.join('\n'),
  };
}

/** 完整 tools SDK（PTC 模式） */
export function buildToolsSdk(tools: CodeModeToolSchema[]): string {
  if (tools.length === 0) {
    return '```ts\ndeclare const tools: Record<string, never>;\n```';
  }
  const lines: string[] = [
    '```ts',
    'type CodeValue = null | boolean | number | string | CodeValue[] | { [key: string]: CodeValue };',
    'class ToolCallError extends Error { readonly toolName: string; }',
    '',
    'declare const tools: {',
  ];
  for (const tool of tools) {
    const doc = sanitizeJsDoc(tool.description);
    if (doc) lines.push(`  /** ${doc} */`);
    lines.push(`  ${JSON.stringify(tool.name)}(args: ${schemaToTsObject(tool.inputSchema, 0)}): Promise<CodeValue>;`);
  }
  lines.push('};', '```');
  return lines.join('\n');
}

/** JSON Schema → TS 对象类型（只用于提示，运行时仍按原 schema 自愈/校验） */
export function schemaToTsObject(schema: unknown, depth: number): string {
  if (!isPlainObject(schema)) return 'Record<string, unknown>';
  const type = schema.type;
  if (type === 'object' || isPlainObject(schema.properties)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === 'string') : []);
    const fields: string[] = [];
    for (const [key, value] of Object.entries(properties)) {
      const optional = required.has(key) ? '' : '?';
      fields.push(`${propertyKey(key)}${optional}: ${schemaToTs(value, depth + 1)}`);
    }
    if (schema.additionalProperties === true) {
      fields.push('[key: string]: unknown');
    }
    return fields.length > 0 ? `{ ${fields.join('; ')} }` : 'Record<string, unknown>';
  }
  return schemaToTs(schema, depth);
}

/** JSON Schema → TS 类型（深度上限 4，无法映射降级为 unknown） */
export function schemaToTs(schema: unknown, depth: number): string {
  if (depth > 4) return 'unknown';
  if (!isPlainObject(schema)) return 'unknown';

  if (Array.isArray(schema.enum)) {
    const literals = schema.enum
      .filter((v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      .slice(0, 30)
      .map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v)));
    if (literals.length > 0) return literals.join(' | ');
    return 'unknown';
  }
  if (schema.const !== undefined) {
    const v = schema.const;
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
    return 'unknown';
  }
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((v) => schemaToTs(v, depth + 1)).join(' | ');
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((v) => schemaToTs(v, depth + 1)).join(' | ');

  const type = schema.type;
  if (Array.isArray(type)) {
    return type
      .filter((v): v is string => typeof v === 'string')
      .map((v) => mapPrimitiveType(v, schema, depth))
      .join(' | ');
  }
  if (typeof type === 'string') return mapPrimitiveType(type, schema, depth);

  if (isPlainObject(schema.properties)) return schemaToTsObject(schema, depth);
  return 'unknown';
}

function mapPrimitiveType(type: string, schema: Record<string, unknown>, depth: number): string {
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const item = schema.items;
      return item === undefined ? 'unknown[]' : `Array<${schemaToTs(item, depth + 1)}>`;
    }
    case 'object':
      return schemaToTsObject(schema, depth);
    default:
      return 'unknown';
  }
}

function propertyKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function sanitizeJsDoc(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '';
  const capped = oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
  return capped.replace(/\*\//g, '* /');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
