# 终端使用最佳实践

## 适用场景与入口判据

`terminal` 用于命令执行、构建、测试、脚本、持久终端状态。

不要用 `terminal` 做浏览器或桌面 GUI 任务：

- 打开/登录/点击/填表/读取 JS 渲染内容 → `browser`。
- 窗口/按钮/弹窗/非网页应用 → `computer`。
- 访问网页仅限：API 调试、下载文件、检查响应头/证书、脚本化批量请求。

## 推荐流程

1. 默认直接传 `command`，在会话的默认终端内执行并复用；连续命令不要新建终端。
2. 需要并行运行多个独立命令时，才用 `action="create"` 新建额外终端，再用 `action="send"` + `terminalId`。
3. 命令语法必须匹配当前解释器：PowerShell、CMD、bash 互不兼容。
4. 需要机器可读输出（JSON/CSV/长行）时用 `raw=true`（仅 `action="exec"`），它是一次性非 PTY 进程，返回原始 stdout/stderr，不保留 shell 状态。
5. 解析退出码、stdout、stderr、是否超时/截断，再决定下一步。

## action / 参数速查

- `exec`（缺省）：在默认终端执行 `command` 并复用终端。
- `create`：新建额外终端（仅并行时用）。
- `send`：在 `terminalId` 内执行 `command`。
- `read`：读取 `terminalId` 最近输出与状态。
- `list`：列出本会话全部终端（标注默认终端）。
- `kill`：关闭 `terminalId`。
- `restart`：重启默认终端（清空状态或卡死恢复）。
- 参数：`command`、`terminalId`、`cwd`、`timeout`（默认 30000ms，最大 600000）、`interpreter`（`powershell` / `cmd` / `bash`）、`raw`。

## 状态与目录

- `cwd` 仅在创建/重启终端时生效；已存在的终端保持自己的工作目录。
- 需要换目录时先 `cd`，或 `restart` 并传新的 `cwd`。
- 环境变量、shell 函数等状态在命令之间保持；`raw=true` 不保持。
- `interpreter` 的实际可用性以系统提示「终端环境（启动时实测）」为准；请求不可用时自动回退并在结果尾部回告。

## 失败信号与恢复

- 超时会发送 Ctrl+C 中断当前命令，并返回已捕获输出；不要立刻原样重试长命令。
- 卡死/状态异常：`restart` 默认终端，或 `kill` 额外终端后重建。
- 命令不存在：先确认开发工具链列表；不在列表中的命令视为不存在，改用已列出的等价能力。
- 退出码非 0：读 stderr 与首个错误；区分语法错误、权限、网络、前置缺失。
- 输出过长/被截断：用 `raw=true` 或把结果写入文件后再读取/筛选。

## 验证与验收

- 构建/测试类任务以退出码 + 关键输出为准，不以「命令已执行」为准。
- 长任务确认进程状态（前台/后台、是否仍在运行）。
- 涉及写文件/改配置后，用 `read`/`git diff` 复核实际落盘结果。

## 禁止事项 / 反模式

- 不为每条命令新建终端；默认终端足够。
- 不用终端命令替代浏览器/桌面操作。
- 不在 PowerShell 里用 Bash 语法，反之亦然。
- 不在未确认解释器的情况下假设 `&&`、管道、环境变量语法可用（Windows PowerShell 5 不支持 `&&`）。
- 不把 `raw=true` 当作可保持状态的交互终端。

## 相关源码与提示词

- `src/modules/tools/terminal/tool.json`
- `src/modules/terminal/`
- `agent/prompt/main/system.md`（运行环境段）
