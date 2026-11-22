# 子代理协作最佳实践

## 适用场景与入口判据

满足任一条件必须委派 `agent(action="delegate", ...)`，而不是自己做：

- 同一目标下 ≥2 个相互独立、可并行的工作单元（分别探索/实现/审查不同模块或文件）。
- 需要大范围只读探索（预计跨 ≥3 个模块或 >10 个文件）。
- 需要独立视角的对抗性审查或第二意见。
- 长耗时且与主线解耦（全库搜索、批量迁移、长测试）。

单文件小改或强连续上下文推理的任务自己做。

## 推荐流程

1. 选模板：`agent_explorer`（探索）、`agent_planner`（规划）、`agent_coder`（编码）、`agent_reviewer`（审查），或自定义 Agent id。
2. 写自包含 `task`：目标、范围、约束、验收标准、输出格式、相关路径；禁止「如上文」「按之前说的」。
3. 选 `mode`：结果立即决定下一步用 `sync`；独立长任务用 `async`。
4. 需要限制权限时传 `tools` 白名单；需要轮数时传 `maxTurns`；默认 `inherit_context=true` 只附父会话最近一条用户请求。
5. 同一轮多个独立任务用多个 `async` 调用并行。
6. async 启动后，结束本轮前用 `agent(action="status", statusAction="list")` 收口；完成后结果以 `[智能体消息]` 注入父会话。

## action / 参数速查

- `delegate`（缺省）：`template`、`task`、`mode`（`sync`/`async`）、`cwd`、`tools`、`maxTurns`、`inherit_context`。
- `status`：`statusAction="list"` 列出成员；`"get"` 查看单个（含最近消息）；`"cancel"` 取消后台子代理。
- `message`：`to`（`a1`/`main`/`parent`/`all`）+ `content`；只在对方需要且会改变行动时发送。
- `board`：`boardAction="rule"` 主代理设规则；`"post"` 参与讨论；`"read"` 查看；`"remove"` 删除规则。
- `manage`：`manageAction="list"` / `"get"` / `"create"` / `"update"` / `"delete"` / `"tools"`；子代理不可使用 manage。

## 嵌套与并发

- 子代理可以继续 `delegate` 下一层。
- 嵌套上限由设置中的 `agent.maxSubagentDepth` 控制：
  - `0` = 不限制；
  - `1` = 只能派发一层（主 → 子）；
  - `2` = 主 → 子 → 孙（默认，范围 0-32）。
- 达到上限后 `delegate` 会被运行时拒绝，但仍可使用 `status` / `message`。
- 同轮并行上限由 `agent.maxConcurrentSubagents` 控制（0 = 不限制，缺省 4）；超过上限的调用会排队，不会失败。
- 该并发闸门作用于主代理直接派发的子代理；子代理内部再派发不占用此闸门。

## sync 还是 async

- 需要结果才能继续 → `sync`。
- 独立长任务、并行探索/批量改造/并行审查 → `async`。
- `sync` 运行期间主代理被阻塞，无法即时回答子代理提问；需要双向对话用 `async`，子代理可通过 `message` 或白板联系。
- async 结果回执后不要重复执行同一任务。

## 完成回报

最终报告固定包含：

- 改动/产出清单；
- 每项意图；
- 验证与证据（命令、结果、路径与行号）；
- 未验证项与阻塞。

## 禁止事项 / 反模式

- 不给子代理贴大段未裁剪上下文；task 必须自包含。
- 不在 sync 子代理运行期间等待它提问；需要交互用 async。
- 不重复同伴已完成的工作；发现冲突先在报告中说明，不要静默覆盖。
- 不向已完成/未运行的兄弟智能体发闲聊消息。
- 子代理不创建/修改持久 Agent（manage 仅主代理可用）。

## 相关源码与提示词

- `agent/prompt/subagent/usage.md`、`agent/prompt/subagent/available.md`
- `src/modules/subagent/`
- `src/modules/agent/engine.ts`（子代理只读工具集）
