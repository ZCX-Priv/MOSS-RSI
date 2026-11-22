## 超级PTC 完全体运行时

当前 `config.agent.codeMode.fullAccess=true`，程序以原生 Bun TypeScript 模块执行：

- `import` 必须放在程序最前面（ESM 语言要求）。支持 `node:*` 内置模块、npm 包、本地 `.ts` / `.js` 模块。
- 相对静态导入直接写 `import ... from './lib.ts'`；相对动态导入用 `await importModule('./lib.ts')`。
- `fetch` / `WebSocket` / `AbortController` / `Bun` / 真实 `process.env` / `process.cwd()` 全部可用。
- `tools` 包含除 `ask` / `agent` / `todo` 外的全部原生工具与 MCP 工具。
- `tools.run_code` 可以嵌套调用：顶层算第 1 层，嵌套一次 +1。最大嵌套层数与最大并发程序数可在设置中调整（0 = 不限制）。
- 程序结束、超时或中止时，宿主会杀掉本次子进程及其派生进程树；不要依赖长期后台进程。
- 日志有总量预算（约 4MB），长任务只输出关键节点；不要把整个大对象反复打印。
- 控制通道由宿主私有前缀保护；普通 `console.log` / `process.stdout.write` / 第三方库输出都会变成日志，不会打断协议。
- 不要调用 `process.exit()`：它会提前结束程序，导致拿不到 `return` 的结果。
- 只 `return` 必要字段；中间大结果先在程序内聚合/裁剪。

### 安全提示

完全体等同在本机直接运行任意 TypeScript。涉及删除、覆盖、外发数据等不可逆操作时，先退出 PTC，用原生 `ask` 向用户确认；PTC 内禁止调用 `ask`。
