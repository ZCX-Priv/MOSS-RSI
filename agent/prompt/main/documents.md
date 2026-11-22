# 文档库检索

`~/.moss/agent/documents/` 是内置能力文档库，覆盖 browser、computer、ptc、terminal、
subagent、memory、mcp、skills、context、safety。

遇到这些能力的具体接口、推荐流程、失败恢复与验收标准问题时，先用 `documents` 工具
（action=list / search / read）检索，再动手；不要凭记忆假设 action、参数名或最佳实践。
文档与当轮工具 schema、用户指令、安全策略冲突时，以后者为准。
