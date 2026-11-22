# PTC / 代码模式最佳实践

## 适用场景与入口判据

满足任一条件优先写 `run_code`（PTC）程序，而不是多轮原生工具调用：

- 涉及 2 步以上工具调用。
- 需要并行/并发、循环、条件分支或结果后处理。
- 需要「动作 → 等待 → 截图 → 判断 → 再动作」的连续闭环（浏览器/桌面实时操作）。
- 多个独立只读调用（搜索多个关键词、并行读文件/网页、批量抓取）。

单步操作或需要即时确认的交互，直接用原生工具。

## 推荐流程

1. 先确认 `tools` 中目标工具的签名与参数（按请求里的 schema 逐字核对）。
2. 并行只读用 `Promise.all`；允许部分失败用 `Promise.allSettled`，逐项检查 `status === "rejected"` 并读取 `reason.toolName` / `reason.message`。
3. 写工具/终端按提交顺序串行，不要并发写同一文件。
4. 程序内聚合/裁剪中间结果，只 `return` 必要字段。
5. 失败时读 `ToolCallError` 的 `toolName` 与错误提示，修正参数后重试一次；仍失败换策略。

## 运行规则

- `code` 是 async TypeScript 函数体，支持顶层 `await` 与 `return`。
- `tools.*` 返回 Promise，必须 `await`；参数直接传对象，不要传 JSON 字符串。
- 参数名逐字照签名复制（`snake_case` 不要改 camelCase）；数字/布尔不要加引号；枚举值照抄。
- 只有 `return` 的值与 `console.log` 的文本会回到模型上下文；中间结果不会自动回灌。
- 返回值中的 `undefined`/函数/BigInt/Date/Map/Set/NaN/循环引用会被自动净化；只返回需要的字段。
- 程序有执行时间预算；返回值有 64MB 协议硬上限，不设输出字节预算。
- 语法/转译错误会给出程序自身行号、列号与代码片段；只改对应语句，不要整段重写。

## 并行与失败隔离

```ts
const results = await Promise.allSettled([
  tools.read({ path: 'a.txt' }),
  tools.read({ path: 'b.txt' }),
]);
const texts = results.map((r) => (r.status === "fulfilled" ? r.value : null));
for (const r of results) if (r.status === "rejected") console.log(r.reason.toolName, r.reason.message);
return { texts };
```

## 嵌套与限额

- `tools.run_code` 可以嵌套调用；顶层算第 1 层，嵌套一次 +1。
- 最大嵌套层数由设置中的 `agent.codeMode.maxNestedDepth` 控制（0 = 不限制）。
- 同时运行的 `run_code` 子进程上限由 `agent.codeMode.maxConcurrentPrograms` 控制（0 = 不限制）。
- 最大并行子调用数由 `maxParallelSubCalls` 控制。

## 完全体（fullAccess）

完全体开启时程序以原生 Bun TypeScript 模块执行：

- `import` 必须放在程序最前面；支持 `node:*`、npm 包、本地 `.ts`/`.js`。
- 相对动态导入用 `await importModule('./lib.ts')`。
- `fetch` / `WebSocket` / `AbortController` / `Bun` / 真实 `process.env` / `process.cwd()` 可用。
- 程序结束、超时或中止时，宿主会杀掉本次子进程及其派生进程树；不要依赖长期后台进程。
- 日志有总量预算（约 4MB），长任务只输出关键节点。
- 不要调用 `process.exit()`；会提前结束程序，导致拿不到 `return` 结果。
- 完全体等同本机运行任意 TypeScript；删除/覆盖/外发数据等不可逆操作先退出 PTC，用原生 `ask` 确认。

## UI 与产物

- 需要渲染智能界面时使用 `ui` 命名空间（如 `ui.render`）；大段 UI 先按块建变量再组装。
- UI SDK 的完整说明在 `agent/prompt/code-mode/ui-sdk.md`，需要时再读取。
- 任务产出文件或修改代码时，在最终总结末尾用独立行列出关键产物路径。

## 常见失误

- 漏必填参数或拼错参数名：按签名逐字核对。
- 忘记 `await`：会拿到 `{}` 或触发未处理拒绝。
- 在 PTC 内调用 `ask` / `agent` / `todo`：这些必须直接调用原生工具（agent 的 status/message/manage 也禁止）。
- 返回超大对象：先在程序内聚合/裁剪。
- 同一调用失败后原样重试：读错误提示，改参数后再试。
- 不确定返回结构：先写最小探针（单次调用 + `console.log`），再批量执行。

## 相关源码与提示词

- `agent/prompt/code-mode/ptc.md`、`super-ptc.md`、`runtime-full.md`、`runtime-sandbox.md`、`ai-recipes.md`、`ui-sdk.md`
- `src/modules/tools/run_code/`
