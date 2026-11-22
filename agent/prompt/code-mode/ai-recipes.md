## AI API 调用配方（直接用 fetch）

超级PTC 不提供专用的 `ai.*` 接口：AI 调用就是网络调用，模型、供应商、协议、流式方式都由程序自己决定。
下面示例都假设密钥来自 `process.env`；没有密钥时先退出 PTC 用原生 `ask` 向用户索取，或读取本机配置文件。

### 1. OpenAI 兼容（/chat/completions）

适用于 OpenAI、DeepSeek、Qwen、Kimi、GLM、本地 vLLM / Ollama 兼容网关等。

```ts
const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const key = process.env.OPENAI_API_KEY;
if (!key) return { error: '缺少 OPENAI_API_KEY' };

const resp = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
  },
  body: JSON.stringify({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: '你是决策器，只输出 JSON。' },
      {
        role: 'user',
        content: `目标：${goal}\n返回 {"action":"search|read|stop","arg":"..."}`,
      },
    ],
    temperature: 0,
  }),
});

if (!resp.ok) throw new Error(`AI HTTP ${resp.status}: ${await resp.text()}`);
const data = await resp.json();
const text = data.choices?.[0]?.message?.content ?? '';
const decision = JSON.parse(text);
return { decision };
```

如果模型输出带 Markdown 围栏，先清洗：

```ts
function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[{[]/);
    if (start < 0) throw new Error(`模型没有返回 JSON：${trimmed.slice(0, 300)}`);
    return JSON.parse(trimmed.slice(start));
  }
}
```

### 2. Anthropic（/v1/messages）

```ts
const key = process.env.ANTHROPIC_API_KEY;
if (!key) return { error: '缺少 ANTHROPIC_API_KEY' };

const resp = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  }),
});

if (!resp.ok) throw new Error(`Anthropic HTTP ${resp.status}: ${await resp.text()}`);
const data = await resp.json();
const text = data.content?.map((part: { text?: string }) => part.text ?? '').join('') ?? '';
return { text };
```

### 3. Gemini（generateContent）

```ts
const key = process.env.GEMINI_API_KEY;
if (!key) return { error: '缺少 GEMINI_API_KEY' };

const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const resp = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  },
);

if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text()}`);
const data = await resp.json();
const text = data.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? '').join('') ?? '';
return { text };
```

### 4. 工具调用循环（AI 决策 → tools 执行 → 再决策）

```ts
const toolDefs = [
  {
    type: 'function',
    function: {
      name: 'web',
      description: '搜索或抓取网页',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['search', 'fetch'] },
          query: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: '读取本地文件',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
];

const messages: Array<Record<string, unknown>> = [
  { role: 'user', content: `目标：${task}\n需要时调用工具，完成后直接回答。` },
];

for (let step = 0; step < 12; step += 1) {
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, tools: toolDefs, tool_choice: 'auto' }),
  });
  if (!resp.ok) throw new Error(`AI HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('AI 返回缺少 message');

  messages.push(message);
  if (!message.tool_calls?.length) return { answer: message.content };

  for (const call of message.tool_calls) {
    const name = call.function?.name;
    const args = JSON.parse(call.function?.arguments || '{}');
    const fn = (tools as Record<string, (input: unknown) => Promise<unknown>>)[name];
    if (!fn) {
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({ error: `未知工具 ${name}` }),
      });
      continue;
    }
    const result = await fn(args);
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(result),
    });
  }
}
return { error: '超过决策轮数' };
```

要点：

- 第一次请求把 `tools` 定义传给模型；后续每轮都把完整的 `messages`（含 assistant 的 `tool_calls` 与 tool 结果）回传。
- `tool_call_id` 必须与模型返回的 `id` 对应。
- 工具结果用 `JSON.stringify` 转成字符串；不要直接把对象塞进 `content`。
- 给循环设置上限，避免模型无限调用工具。

### 5. 流式（SSE）

```ts
const resp = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({ model, messages, stream: true }),
});
if (!resp.ok) throw new Error(`AI HTTP ${resp.status}: ${await resp.text()}`);

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

### 6. 错误处理与重试

```ts
async function postJson(url: string, body: unknown, headers: Record<string, string>) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      if (resp.status === 429 || resp.status >= 500) {
        lastError = new Error(`HTTP ${resp.status}: ${await resp.text()}`);
        await sleep(500 * attempt);
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      return await resp.json();
    } catch (err) {
      lastError = err;
      await sleep(500 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
```
