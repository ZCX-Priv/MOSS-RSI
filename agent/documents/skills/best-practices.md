# 技能使用最佳实践

## 适用场景与入口判据

接到任务先浏览可用技能列表；有匹配或部分匹配的就加载全文并遵循其指引。

即使自认能直接完成，也先看技能是否定义了「这件事在这里该怎么做」。宁可多加载用不上的上下文，也不要错过关键步骤、陷阱与已验证的工作流。

## 推荐流程

1. `action="list"`：返回启用技能的 `name + description`（渐进式披露第一级，token 消耗小）。
2. `action="use"`：传 `skill` 加载完整指令模板；目录式技能会附带 `references/`、`scripts/` 文件清单。
3. 需要参数时传 `args`，替换模板中的 `{{placeholder}}`。
4. 技能要求读取附属文件时，按清单用 `read` 读取；不要猜测内容。
5. 任务匹配市场技能但本地没有时，用 `action="search"` → `action="install"`。

## action / 参数速查

- `list`：列出所有启用的 skill。
- `use`：`skill`（名称）、`args`（可选对象）。
- `create`：`name`（匹配 `^[a-z][a-z0-9-]*$`）、`description`、`content`、`enabled`、`icon`、`allowedTools`。
- `update`：`name` + 要修改的字段；名称不可变。
- `delete`：`name`；内置 skill 不可删除。
- `search`：`keyword`；搜索 SkillHub 市场。
- `install`：`canonicalName`（格式 `@owner/slug`）。

## 技能布局

- 用户技能：`~/.moss/skills/<name>/SKILL.md`（目录式，推荐）或单文件 `.md`。
- 包内内置技能：`<packageRoot>/skills/<name>/SKILL.md`，首次启动播种到用户目录。
- 目录式技能可带附属资源：`references/`、`scripts/` 等，`use` 时返回清单。

## 何时创建/修改技能

- 用户明确要求沉淀可复用工作流。
- 某套步骤反复使用、且需要固定约束/验收标准。
- 不为一句话任务创建技能；不把临时状态写进技能。

`create` / `update` 属于写操作，可能触发确认；`delete` 不可删除内置技能。

## 失败信号与恢复

- `skill not found`：先 `list` 确认名称与启用状态。
- 名称非法：必须匹配 `^[a-z][a-z0-9-]*$`。
- 内置不可删：改用 `update` 覆盖用户自定义副本，或创建新名称。
- 市场安装失败：读错误信息；已存在同名技能时 `installed=false`，不会覆盖。
- 技能内容与当前项目冲突：以用户指令和项目约定为准，在报告中说明差异。

## 禁止事项 / 反模式

- 不跳过 `list` 直接猜技能名。
- 不把技能正文当作绝对规则；与用户指令/工具 schema 冲突时以后者为准。
- 不创建与现有技能重复的技能。
- 不删除内置技能。
- 不在 `args` 中塞入大段无关上下文。

## 相关源码与提示词

- `src/modules/tools/skill/tool.json`
- `src/modules/tools/skill/index.ts`
- `src/modules/tools/shared/skill-registry.ts`
- `skills/`（内置技能）
