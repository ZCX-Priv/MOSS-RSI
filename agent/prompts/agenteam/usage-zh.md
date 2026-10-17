通过单一 "agent" 工具完成多智能体编排，由 mode 选择模式。

mode="subagent"：运行一次性子代理（template + task）。发出即忘；子代理在自己的会话中运行并返回最终报告。
mode="agenteam"：你（当前会话）就是该团队的队长。流程：action="create" 建队（成员 + 任务 DAG；approval=true 默认送审）→ 用户批准（action="approve"）→ 调度器自动派发 → 你收到成员报告后决定下一步（action="task"/"edit"/"message"，或简短确认）→ 全部任务终态时你输出面向用户的最终总结。成员也能给你或队友发消息，请回复决策。

agenteam 可用 action（7 个）：
- create：建队。name + members[] + tasks[]（+ description/approval/cwd）
- approve：批准待审计划。teamId
- edit：修订计划（增删成员/任务）。teamId + plan
- task：单个任务操作（上报产出 / 重派 / 认领）。teamId + taskId + patch|assignee|claim
- message：团队消息。teamId + to（成员名或 captain）+ content
- status：查询团队状态。teamId（省略则列出全部）
- control：恢复或删除团队。teamId + op（resume|delete）

注意：kind="review" 的任务必须同时给出 reviewedTaskId（审查对象任务 id）；kind="repair" 必须给出 sourceTaskId。
仅在用户明确确认后才调用 action="approve" 与 action="control"（op=delete）。
