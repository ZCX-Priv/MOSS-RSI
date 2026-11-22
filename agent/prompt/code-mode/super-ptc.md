## 超级PTC 使用指南（完全体）

完全体已开启：`import`、`fetch`、真实 `process.env`、`Bun`、任意 npm 包、任意 AI API 都可用。
不要假设这些能力不存在，也不要因为能力大就退回多轮原生工具调用。

### 1. 什么时候优先用超级PTC

- 任务需要 2 步以上工具调用，或需要把中间结果留在程序里判断。
- 需要网络请求、抓取、轮询、下载、上传。
- 需要调用 AI API 做决策，再根据决策执行工具。
- 需要循环、重试、并行、限流、批处理、数据清洗。
- 需要读写文件、生成报告、跑本地脚本。
- 需要把一段复杂流程封装成一次调用完成。

### 2. 执行模型

`code` 是一个 async 函数体：

```ts
// import 必须放在最前面
import { readFileSync } from 'node:fs';

const text = readFileSync('README.md', 'utf8');
return { length: text.length };
```

- 支持顶层 `await` 与 `return`。
- `export` 不支持（程序本身就是一个默认导出的入口函数）。
- 只有 `return` 的值与 `console.log` 的文本会回到模型上下文；中间结果留在程序里。
- 工具失败会抛出可 `try/catch` 的 `ToolCallError`，错误对象带 `toolName`。

### 3. 网络请求

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15_000);
try {
  const resp = await fetch('https://example.com/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'moss' }),
    signal: controller.signal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return { status: resp.status, data };
} finally {
  clearTimeout(timer);
}
```

SSE 流式读取：

```ts
const resp = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stream: true }),
});
const reader = resp.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';
let text = '';

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let index: number;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') break;
    const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
    if (delta) text += delta;
  }
}
return { text };
```

### 4. 调用 AI API

AI 调用就是普通 `fetch`，不限制供应商、模型、协议和流式。完整配方见下面的 `AI API 调用配方`：

- OpenAI 兼容 `/chat/completions`
- Anthropic `/v1/messages`
- Gemini `:generateContent`
- 模型返回 `tool_calls` 后执行工具、再回传结果的循环

密钥来源：

- `process.env.OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` 等；
- 或用 `tools.read` 读取本机配置文件；
- 或退出 PTC 用原生 `ask` 向用户索取（PTC 内禁止 `ask`）。

不要把密钥写进 `return` 或日志。

### 5. 工具编排

根据工具结果做 if-else、重试、降级：

```ts
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try {
    const result = await tools.web({ mode: 'search', query: keyword });
    const text = String(result);
    if (text.includes('没有结果')) {
      await sleep(800 * attempt);
      continue;
    }
    return { attempt, text };
  } catch (err) {
    if (attempt === 3) throw err;
  }
}
return { error: '搜索失败' };
```

并行只读、串行写：

```ts
const [a, b] = await Promise.all([
  tools.read({ path: 'a.md' }),
  tools.read({ path: 'b.md' }),
]);

const settled = await Promise.allSettled([
  tools.read({ path: 'x.md' }),
  tools.read({ path: 'y.md' }),
]);
const ok = settled.filter((item) => item.status === 'fulfilled');
const failed = settled.filter((item) => item.status === 'rejected');
return { a, b, ok: ok.length, failed: failed.length };
```

### 6. 嵌套 run_code 与禁用边界

可以在程序内再跑一段 PTC：

```ts
const nested = await tools.run_code({
  code: 'const rows = await tools.read({ path: "package.json" }); return rows;',
  description: '读取 package.json',
});
return { nested };
```

- 顶层算第 1 层，嵌套一次 +1；超过 `maxNestedDepth` 会返回普通工具错误。
- 并发满额会返回可 `catch` 的 `capacity` 错误；`maxConcurrentPrograms=0` 时不限制。
- 嵌套 `run_code` 本身仍受用户确认与 safety 约束。
- `ask` / `agent` / `todo` 仍禁止在 PTC 内调用；需要提问、子代理或待办时退出程序直接调用原生工具。

### 7. 资源治理

- 自己启动的子进程/临时文件用 `try/finally` 清理；程序结束宿主也会杀进程树。
- 不要无限循环；给轮询/重试设置上限和 `sleep`。
- 日志有总量预算，长任务只输出关键节点；大对象先在程序内裁剪。
- 不要调用 `process.exit()`；它会提前结束程序，拿不到 `return` 的结果。

### 8. 常见错误

- `import` 写到程序中间 → 放到程序最前面。
- 相对动态导入没用 `importModule` → `await importModule('./lib.ts')`。
- 忘记 `await` → `tools.*` / `fetch` 返回 Promise。
- 把对象写成 JSON 字符串 → 直接传对象。
- 在 PTC 内调用 `ask / agent / todo` → 会被明确拒绝，退出程序调用原生工具。
- 直接 `process.exit()` → 拿不到返回值。
