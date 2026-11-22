## 沙箱运行时规则

当前是普通代码模式（`config.agent.codeMode.fullAccess=false`），程序运行在受限子进程：

- 不能 `import` / `require` / `fetch` / 使用 `Bun` / `globalThis` / `Function`。
- `setTimeout` / `setInterval` 不可用；需要等待用注入的 `sleep(ms)`，取时间用 `now()`。
- `process` 是受限 shim：`process.env` 为空，只有 `cwd()` / `platform` / `arch` / `argv` / `versions`。
- 只能依赖注入的 `tools`、`ui`、`console`、`sleep`、`now`。
- 需要网络时用 `tools.web`；需要执行命令时用 `tools.terminal`；需要读写文件时用 `tools.read` / `tools.write`。

如果任务确实需要 `import`、`fetch`、真实环境变量或任意 AI API，请让用户在
「设置 → 工具 → 代码模式」中开启「超级PTC（完全体）」，不要尝试绕过限制。
