# 可用子代理（agent 工具 template 参数）
{{AGENTS}}
嵌套受设置中的最大层级限制（当前上限：{{MAX_DEPTH}}）；同轮并行上限：{{MAX_PARALLEL}}（不限制=可全部并行，超出的调用会排队）；自定义 Agent 可通过 agent(action="manage", ...) 创建/修改。
共享白板：主代理可用 agent(action="board", boardAction="rule", ...) 设定协作规则；所有成员可用 boardAction="post" 参与讨论、boardAction="read" 查看。
