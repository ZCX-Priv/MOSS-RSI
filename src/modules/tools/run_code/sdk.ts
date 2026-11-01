// src/modules/tools/run_code/sdk.ts
// 代码模式的系统提示附加段：工具清单 + 使用规则 + PTC 并行主推 + ui 构建器声明。
// 输出必须字节稳定（工具按名字排序、固定格式），否则会破坏前缀缓存。

import { buildUiSdkText } from './ui/catalog';
import { isPtcForbiddenTool, PTC_FORBIDDEN_TOOL_LABEL } from './forbidden';

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
  uiEnabled: boolean;
  tools: CodeModeToolSchema[];
}

/** 生成系统提示附加段；不该出现代码模式时返回 null。 */
export function buildCodeModePromptExtras(input: BuildCodeModePromptInput): CodeModePromptSection | null {
  const tools = input.tools
    .filter((tool) => tool.name !== 'run_code' && !isPtcForbiddenTool(tool.name))
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const parts: string[] = [];

  parts.push('## 代码模式（PTC）');
  parts.push(
    '原生工具仍然可用；但涉及 2 步以上工具调用、并行/并发、循环、条件分支或结果后处理时，优先写一段 `run_code` 程序（PTC），把中间结果留在程序里。',
  );
  parts.push(
    '并行任务优先使用 PTC：多个独立的只读调用（例如同时搜索多个关键词、并行读取多个文件或网页、批量抓取）应放在同一个程序中用 `Promise.all` 并发执行，不要拆成多轮原生工具调用。单步操作或需要即时确认的交互可直接使用原生工具。',
  );
  parts.push(
    tools.length > 0
      ? `程序内的 \`tools\` 镜像当前原生工具（参数签名见请求中的原生工具 schema）：\n${tools
          .map((tool) => `\`${tool.name}\``)
          .join('、')}`
      : '程序内的 `tools` 镜像当前原生工具（当前没有可用工具）。',
  );
  parts.push(
    `硬限制：程序内禁止调用 ${PTC_FORBIDDEN_TOOL_LABEL}（\`tools.ask\` / \`tools.agent\` / \`tools.todo\` 不存在）。需要提问、派发子代理或维护待办时，直接调用原生 \`ask\` / \`agent\` / \`todo\`，不要写进 run_code 程序。`,
  );
  parts.push(
    '',
    '最小示例（并行只读调用；工具名与参数以请求中的原生工具 schema 为准）：',
    '```ts',
    'const [a, b] = await Promise.all([',
    "  tools.read({ path: 'a.txt' }),",
    "  tools.read({ path: 'b.txt' }),",
    ']);',
    'return { a, b };',
    '```',
  );

  parts.push(
    '',
    '### 使用规则',
    '- `code` 是一个 async TypeScript 函数体；支持顶层 `await` 与 `return`，类型注解会被剥离。',
    '- 工具失败会在程序内抛出可 `try/catch` 的 `ToolCallError`；错误对象带 `toolName`。',
    '- 只有 `return` 的值与 `console.log` 的文本会回到模型上下文；中间结果不会自动回灌，请主动裁剪。',
    '- 只读工具可以用 `Promise.all` 并发；写操作/终端等会按提交顺序独占执行。',
    `- 代码程序内禁止调用 ${PTC_FORBIDDEN_TOOL_LABEL}；违反会导致程序直接报错。`,
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
    title: '代码模式（PTC）',
    content: parts.join('\n'),
  };
}
