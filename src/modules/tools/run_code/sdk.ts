// src/modules/tools/run_code/sdk.ts
// 代码模式的系统提示附加段：工具清单 + 使用规则 + PTC 并行主推 + ui 构建器声明。
// 输出必须字节稳定（工具按名字排序、固定格式），否则会破坏前缀缓存。

import { buildUiSdkText } from './ui/catalog';
import { isPtcForbiddenTool, PTC_FORBIDDEN_TOOL_LABEL } from './forbidden';
import { buildToolSignature } from './runtime/schema';

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
  /** 是否允许内嵌页面引用外部 CDN 资源（决定提示词与运行时拦截口径） */
  allowCdn: boolean;
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
    '并行写法按失败语义选择：全部成功才继续用 `Promise.all`；允许部分失败用 `Promise.allSettled` 逐项检查 `status === "rejected"`，拿到 `reason.toolName` 与 `reason.message` 后决定重试或跳过。写工具/terminal 会按提交顺序串行，不要并发写同一文件。',
    '',
    '并行与失败隔离示例：',
    '```ts',
    'const results = await Promise.allSettled([',
    "  tools.read({ path: 'a.txt' }),",
    "  tools.read({ path: 'b.txt' }),",
    ']);',
    'const texts = results.map((r) => (r.status === "fulfilled" ? r.value : null));',
    'for (const r of results) if (r.status === "rejected") console.log(r.reason.toolName, r.reason.message);',
    'return { texts };',
    '```',
  );
  parts.push(
    '连续/实时操作优先使用 PTC：需要「动作 → 等待 → 截图 → 判断 → 再动作」的浏览器或桌面任务（游戏、拖拽、连续按键、逐步表单），写一段程序在单次调用内完成一小段闭环，再用返回截图/帧差决定下一步；不要每按一个键就单独调用一次工具。',
  );
  if (tools.length > 0) {
    const signatures = tools
      .map((tool) => `- \`${buildToolSignature(tool.name, tool.inputSchema)}\``)
      .join('\n');
    parts.push(`程序内的 \`tools\` 镜像当前原生工具；按下面的签名传对象参数：\n${signatures}`);
  } else {
    parts.push('程序内的 `tools` 镜像当前原生工具（当前没有可用工具）。');
  }
  if (input.uiEnabled) {
    const tsxLine = input.allowCdn
      ? '- `page.mode = "tsx"`：`page.source` 是单文件 TSX，必须 `export default function App()`；react/react-dom 由内置运行时提供，可 `import` npm 包（自动经 https://esm.sh 解析）或完整 https ESM URL（react 系库会自动复用同一份 React）；样式写 `<style>{`…`}</style>`（不要 import CSS）；生成完成后编译渲染，非流式。'
      : '- `page.mode = "tsx"`：`page.source` 是单文件 TSX，必须 `export default function App()`；只允许 `import ... from "react"` / `"react-dom"`，不要 import 其他包；样式写 `<style>{`…`}</style>`（不要 import CSS）；生成完成后编译渲染，非流式。';
    const resourceLine = input.allowCdn
      ? '- 可使用 CDN 资源（`<script src="https://…">`、`<link rel="stylesheet">`、Web Fonts）；图片可用 http(s) 绝对地址；页面默认高度 560，可用 `page.height`（240-1200）调整。'
      : '- 不引用外部 CSS/JS/CDN/字体；图片可用 http(s) 绝对地址；页面默认高度 560，可用 `page.height`（240-1200）调整。';
    parts.push(
      '',
      '### 内嵌页面（page 参数）',
      '需要任意 CSS/动画/像素级视觉（游戏、海报式看板、复杂网页）时，给 run_code 的 `page` 参数传一个自包含页面；此时 `code` 可以省略（纯页面不启动子进程）。',
      '- `page.mode = "html"`（推荐）：`page.source` 是完整 HTML 文档（从 `<!doctype html>` 开始），样式放 `<style>`、脚本放 `<script>`；生成过程中前端会边生成边渲染，元素逐步出现。',
      tsxLine,
      resourceLine,
      '- 简单指标/表单/筛选优先 `ui.*`（可读 state、体积小）；不要为了用页面而用页面。',
    );
  }
  parts.push(
    '',
    '### 回复末尾的产物入口',
    '- 任务产出文件或修改了代码时，在最终总结末尾用独立行列出关键产物路径；前端会把真实存在的文件路径渲染为可点击卡片（本轮 diff 汇总卡会自动出现）。',
    '- 需要用户点开的网页链接独占一行（`[标题](https://…)` 或裸 URL），前端会渲染为 Globe 卡片；不要埋在句子中间。',
    '- 是否挂载这些入口由你决定；只在确实有产物/来源时列出，不要为了凑卡片编造路径或链接。',
  );
  parts.push(
    `硬限制：程序内禁止调用 ${PTC_FORBIDDEN_TOOL_LABEL}（\`tools.ask\` / \`tools.agent\` / \`tools.todo\` 不存在）。需要提问、派发/查询/对话子代理或维护待办时，直接调用原生 \`ask\` / \`agent\` / \`todo\`，不要写进 run_code 程序。`,
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
    '',
    '交互闭环示例（游戏/连续 UI：一次程序内按住 → 等待 → 截图）：',
    '```ts',
    "const before = await tools.browser({ action: 'screenshot', tab: 't1', frame: 'auto' });",
    "await tools.browser({ action: 'hold', tab: 't1', frame: 'auto', keys: ['ArrowRight'], duration_ms: 600 });",
    'await sleep(250);',
    "const after = await tools.browser({ action: 'wait_change', tab: 't1', frame: 'auto', timeout_ms: 800 });",
    'return { after, note: before.text };',
    '```',
    '嵌套工具返回的截图会自动附加到 run_code 结果（最多 2 张）；不需要再单独调用 screenshot 取图。',
  );

  parts.push(
    '',
    '### 常见失误（调用前自检）',
    '- 漏必填参数或参数名拼错：按上面的签名逐字核对；宿主会拒绝并回传「期望签名 + 修复示例 + 实际入参」。',
    '- 参数名逐字照签名复制（snake_case 不要改 camelCase）；数字/布尔不要加引号；枚举值照抄。宿主会自动纠正一次，但不要依赖。',
    '- 同一调用失败后不要原样重试：读错误里的「期望签名 + 修复示例」，改参数后重试一次；仍失败就换策略并在正文说明。',
    '- 忘记 `await`：`tools.*` 返回 Promise，不 `await` 会拿到 `{}` 或触发未处理拒绝。',
    '- 把对象写成 JSON 字符串：宿主会自动解析一次，但不要依赖；直接传对象。',
    '- 返回超大对象：只返回必要字段，先在程序内聚合/裁剪。',
    '- 在 PTC 里调用 `agent` / `ask` / `todo`：这些必须直接调用原生工具（agent 的 status/message/manage 也在程序内禁止）。',
  );
  parts.push(
    '',
    '### 使用规则',
    '- `code` 是一个 async TypeScript 函数体；支持顶层 `await` 与 `return`，类型注解会被剥离。',
    '- 定时用注入的 `sleep(ms)` 与 `now()`；沙箱内 `setTimeout` 不可用（不要尝试）。',
    '- 工具失败会在程序内抛出可 `try/catch` 的 `ToolCallError`；错误对象带 `toolName`。',
    '- 只有 `return` 的值与 `console.log` 的文本会回到模型上下文；中间结果不会自动回灌，请主动裁剪。',
    '- 只读工具可以用 `Promise.all` 并发；写操作/终端等会按提交顺序独占执行。',
    `- 代码程序内禁止调用 ${PTC_FORBIDDEN_TOOL_LABEL}；违反会导致程序直接报错。`,
    '- 不要 `import`/`require`/`fetch`/使用 `Bun`；程序只应依赖注入的 `tools`、`ui`、`console` 与受限 `process`。',
    '- 返回值对象里的 undefined/函数/BigInt/Date/Map/Set/NaN/循环引用会被自动净化并给出警告，不需要手工清洗；只返回需要的字段即可。',
    '- 程序有执行时间预算；返回值不设输出字节预算，会完整返回（仅 64MB 协议硬上限）。只返回必要字段，避免上下文被无用数据占满。',
    '- 语法/转译错误会给出程序自身的行号、列号与代码片段；按提示只改对应语句，不要在未定位前整段重写。',
    '- 大段 UI 建议先按块建变量，再组装，最后 `ui.render`；超深嵌套容易造成括号错配。',
    '- 不确定工具返回结构时，先写最小探针（单次调用 + `console.log`）确认，再批量执行。',
  );

  const hasWeb = tools.some((tool) => tool.name === 'web');
  const hasTerminal = tools.some((tool) => tool.name === 'terminal');
  if (hasWeb || hasTerminal) {
    parts.push('', '### 工具返回形态（仅 run_code 内）');
    if (hasWeb) {
      parts.push(
        "- `tools.web({ mode: 'search' })` → 结构化对象：`items`（当前页完整条目，含正文摘录）、`pool`（本轮已抓到的全部结果，最多 100 条）、`searchId`、`totalAvailable`、`hasMore`、`nextOffset`。需要更多时带 `searchId + offset` 翻页；`pageSize` 建议 20。",
        "- `tools.web({ mode: 'fetch' })` → `{ url, finalUrl, status, title?, text, truncated, links }`，`text` 为完整正文（受 maxFetchChars 限制）。",
      );
    }
    if (hasTerminal) {
      parts.push(
        "- `tools.terminal({ raw: true })` → `{ stdout, stderr, exitCode, timedOut, aborted, truncated }`，原始输出不折行。需要解析 JSON/CSV/长行时必须用 `raw: true`。",
        '- 非 raw 的终端输出会按终端列宽硬折行，禁止用来解析 JSON/CSV；它只适合人看的命令输出。',
      );
    }
    parts.push(
      '- MCP 工具：有 structured output 时返回对象；否则返回文本。',
      '- 其它工具默认返回文本；若整段文本是合法 JSON，会自动解析为对象。',
    );
  }

  if (input.uiEnabled) {
    parts.push('', buildUiSdkText());
    parts.push(
      '',
      '界面会直接渲染在「代码」步骤下方；最终正文用一两句话说明即可，不要复述界面里的内容。',
    );
  } else {
    parts.push('', '### 智能界面', '本次会话关闭了智能界面（`ui` 命名空间与 `page` 参数不可用）。');
  }

  return {
    id: 'code-mode-sdk',
    title: '代码模式（PTC）',
    content: parts.join('\n'),
  };
}
