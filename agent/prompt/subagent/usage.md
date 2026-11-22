通过统一的 "agent" 工具管理多智能体：action=delegate（缺省）派发子代理，action=status / message / manage 分别负责状态、通信与注册表管理。

## action=delegate（派发）

- template：注册表 agent id。内置模板：agent_explorer（代码库探索）、agent_planner（任务规划）、agent_coder（编码实现）、agent_reviewer（对抗性审查）；也可使用用户自定义的 agent id（用 agent(action="manage", manageAction="list") 查看当前全部可用 id）。
- task：完整、自包含的任务描述。子代理只能看到这段内容，不会继承当前对话、上下文或你的推理过程。
- mode：`sync`（默认，阻塞等待最终报告）或 `async`（后台运行，立即返回 agentId/sessionId）。
- cwd：可选，默认当前会话工作目录。
- tools：可选，本次子代理可用的工具白名单（如 `["read","grep","edit"]`）。不填=使用模板默认配置；传入后子代理只能看到白名单内工具（`agent` 始终可用，用于协作）。
- maxTurns：可选，工具调用轮数。不填=200；低于 200 按 200 处理；无上限；填 `infinite` 表示不限制轮数。
- inherit_context：可选，默认 true。会把父会话最近一条用户请求作为背景附在任务前，仅帮助子代理理解目标，不扩大任务范围。

## 嵌套规则

- 子代理可以继续调用 `agent(action="delegate", ...)` 派发下一层，层级上限由设置中的 `agent.maxSubagentDepth` 控制（0=不限制；1=主→子；2=主→子→孙；默认 2，范围 0-32）。
- 达到上限后仍可调用 `agent` 的 status / message，但 delegate 会被运行时拒绝并给出明确错误。
- 子代理不可使用 `agent(action="manage", ...)`；自定义 Agent 的持久创建/修改由主代理负责。

## 自定义 Agent（action=manage）

- `agent(action="manage", manageAction="list")`：列出内置模板与自定义 Agent。
- `agent(action="manage", manageAction="get", id=<id>)`：查看详情。
- `agent(action="manage", manageAction="create", name=..., description=..., systemPrompt=..., tools=[...])`：创建自定义 Agent。
- `agent(action="manage", manageAction="update", id=<id>, ...)`：修改自定义 Agent（内置模板只读）。
- `agent(action="manage", manageAction="delete", id=<id>)`：删除自定义 Agent（默认 Agent 不可删）。
- `agent(action="manage", manageAction="tools")`：列出可填入 `tools` 的工具名。

创建后直接用 `agent(action="delegate", template=<自定义 id>, task=...)` 派发；自定义 Agent 未填写 `tools` 时默认拥有全部工具。

## 何时必须委派

满足任一条件时必须委派，而不是自己做：

- 同一目标下 ≥2 个相互独立、可并行的工作单元（分别探索/实现/审查不同模块或文件）。
- 需要大范围只读探索（预计跨 ≥3 个模块或 >10 个文件）。
- 需要独立视角的对抗性审查或第二意见。
- 长耗时且与主线解耦（全库搜索、批量迁移、长测试）。

并行工作在同一轮发起多个 `async` 调用；结果立即决定下一步时用 `sync`。委派后你负责验收关键结论，不重复子代理做过的搜索。单文件小改或强连续上下文推理的任务自己做。

## sync 还是 async

- 需要结果才能继续（下一步依赖它）→ `sync`。
- 独立的长任务（探索、批量改造、并行审查）→ `async`，主代理继续做别的事。
- async 启动后，结束本轮前先 `agent(action="status", statusAction="list")` 收口；仍在运行就说明进度并等待，或继续其他可并行工作。
- async 完成后，结果会以 `[智能体消息]` 注入父会话；不要重复执行同一任务。
- 同一轮多个 `agent` 调用会并发执行；并发上限由设置中的 `agent.maxConcurrentSubagents` 实时读取（0 = 不限制，缺省 4）。超过上限的调用会排队，不会失败。
- 该上限作用于主代理直接派发的子代理；子代理内部再派发的下级不占用此闸门（避免父代理等待同步子代理时死锁）。
- `sync` 子代理运行期间主代理会被阻塞，无法即时回答子代理的提问；需要双向对话/询问时用 `async` 派发，子代理可通过 `message` 或白板讨论联系你。

## 共享白板（大群）

- 白板是任务树级、持久化的公共区域：后派发的子代理启动时会自动看到主代理规则与最近讨论。
- 主代理设定规则：`agent(action="board", boardAction="rule", title="规则标题", content="...")`；同标题会覆盖旧规则；`boardAction="remove", boardId="..."` 删除规则。
- 所有成员参与讨论：`agent(action="board", boardAction="post", content="...")`（持久、所有成员可见，属于大群）。
- 查看白板：`agent(action="board", boardAction="read")`。
- 规则是主代理设定的协作原则（不强制），不覆盖子代理任务的验收标准；子代理不可写规则。
- `message` 仍用于点对点私聊/即时通知；白板用于公开、持久、需要所有人看到的讨论。

## task 写法（必须自包含）

按以下小节写清楚，禁止使用「如上文」「按之前说的」：

1. 目标：要达成什么、为什么。
2. 范围：允许改哪些目录/文件，禁止碰什么。
3. 约束：技术栈、风格、兼容性、权限。
4. 验收标准：可执行的检查项（测试/命令/输出）。
5. 输出格式：最终报告要包含哪些字段。
6. 相关路径：入口文件、配置、已有实现位置。

## 多智能体通信

- 发现同伴：`agent(action="status", statusAction="list")`（返回当前任务树的 main / a1 / a2 及状态）。
- 查看单个：`agent(action="status", statusAction="get", sessionId="a1")`（含最近消息）。
- 取消后台：`agent(action="status", statusAction="cancel", sessionId="a1")`（只能取消子代理）。
- 发消息：`agent(action="message", to="a1"|"main"|"parent"|"all", content=...)`。
  - `all` = 当前任务树频道广播（只发给运行中的成员）。
  - `parent` = 父代理；主代理没有父代理。父代理即使当前空闲也会接收留言，在下一条用户消息开始时注入（不丢失）。
  - 只在「对方需要且会改变其行动」时发消息；汇报事实、路径、行号、验证结果，不发寒暄。
  - 不要向已完成/未运行的兄弟智能体发 chat；结果回执用 `kind=result` 由运行器自动发送。

## 完成回报

最终报告固定包含：改动/产出清单、每项意图、验证与证据（命令、结果、路径与行号）、未验证项与阻塞。

## 注意

- 模板的 systemPrompt 会叠加到主提示词生效；`tools` 入参或模板 tools 白名单会真实裁剪可用工具（`agent` 始终可用）。
- `maxTurns` 只影响本次运行；不填时统一按 200，低于 200 会被提升为 200。
- 不要重复同伴已完成的工作；发现冲突先在报告里说明，不要静默覆盖。
