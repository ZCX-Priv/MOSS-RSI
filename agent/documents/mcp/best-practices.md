# MCP 工具使用最佳实践

## 适用场景与入口判据

需要外部 MCP 服务器能力时使用 `mcp`：

- 查询已连接服务器及其工具；
- 调用 MCP 工具；
- 搜索/安装 MCP 市场条目。

当轮工具列表中直接出现 `mcp__<server>__<tool>` 时，优先直接调用该工具；需要发现、参数说明或安装时用 `mcp` 工具。

## 推荐流程

1. `action="list"` 查看已连接服务器与工具；可传 `server` 只看单个服务器。
2. 调用前阅读工具 schema（必填/可选/默认值/返回形状）。
3. `action="call"`：传 `server` + `tool` + `arguments`。
4. 需要新服务器时：`action="search"` → `action="info"`（拿安装方式与必填 env）→ `action="install"`。
5. 安装后再次 `action="list"` 验证连接与工具可用。

## action / 参数速查

- `list`：`server` 可选过滤。
- `call`：`server`（必填）、`tool`（必填）、`arguments`（对象）。
- `search`：`keyword`（留空浏览）、`limit`（1-20，默认 12）、`source`（`mcpmarket` 默认 / `official` / `modelscope`）。
- `info`：`marketId`（search 结果中 `[source:id]` 的 id）、`source`。
- `install`：`marketId`、`env`、`option`（info 中的 `[index]`，缺省第一个可用方式）、`name`（可选，需匹配 `^[a-zA-Z0-9_-]+$`）。

## 失败信号与恢复

- `call` 超时：由配置 `tools.mcp.timeout` 控制（默认 120000ms）；读错误信息再决定是否重试。
- 缺 env：先向用户收集，再重试 install；不要编造凭据。
- 工具不存在/服务器未连接：`list` 重新确认；必要时重启会话或重新安装。
- 返回错误：区分参数错误、权限、网络、服务器内部错误；同一调用不要原样重试。
- 未标注的 MCP 工具按高风险处理；调用前确认副作用。

## 安全边界

- `list` / `search` / `info` 只读，风险 L0。
- `call` / `install` 可能产生外部副作用或写盘，风险 L3，可能触发确认。
- install 会把服务器配置写入本地并托管；先向用户确认安装来源与 env。
- 不把敏感凭据写入提示词正文；通过 `env` 参数传递。

## 禁止事项 / 反模式

- 不假设 MCP 工具名称或参数；先 `list` / 读 schema。
- 不在未确认来源时安装 MCP 服务器。
- 不把 MCP 工具当成本地文件工具使用；路径/权限按服务器自身语义。
- 不在调用失败后原样重试；先看错误分类。
- 不忽略 `source` 差异：同一市场条目在不同数据源可能不同。

## 相关源码与提示词

- `src/modules/tools/mcp/tool.json`
- `src/modules/mcp/`
- `agent/prompt/mcp/task-summary.md`
