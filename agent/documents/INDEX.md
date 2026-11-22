# MOSS 能力文档库

这里是各能力的最佳实践与常见陷阱。文档以**当轮工具 schema、用户指令、安全策略**为准；出现冲突时以后者为准。

| 能力 | 适用场景 | 文档 |
|---|---|---|
| browser | 网页打开、登录、点击、填表、截图、读取 JS 渲染内容 | `browser/best-practices.md` |
| computer | 桌面窗口、按钮、表单、弹窗、非网页应用 | `computer/best-practices.md` |
| ptc | 多步/并行/循环/条件/后处理任务，代码模式运行时 | `ptc/best-practices.md` |
| terminal | 命令执行、构建、测试、脚本、持久终端 | `terminal/best-practices.md` |
| subagent | 并行探索、独立实现、对抗性审查、多智能体协作 | `subagent/best-practices.md` |
| memory | 长期记忆保存、检索、修正、置顶 | `memory/best-practices.md` |
| mcp | 外部 MCP 服务器工具查询、调用、市场安装 | `mcp/best-practices.md` |
| skills | 技能发现、加载、创建、修改、市场安装 | `skills/best-practices.md` |
| context | 上下文压缩、历史检索、上下文压力处理 | `context/best-practices.md` |
| safety | 权限模式、风险分级、危险命令、保护路径 | `safety/best-practices.md` |

检索方式：优先 `documents(action="list")` 看主题，`documents(action="search", query="...")` 找关键词，`documents(action="read", path="browser/best-practices.md")` 读全文。
