# 记忆使用最佳实践

## 适用场景与入口判据

在以下时机使用 `memory`：

- 完成任务、发现可复用经验、获得用户明确偏好或纠正后保存长期记忆。
- 任务开始时检索与任务相关的长期记忆。
- 发现新旧记忆矛盾时更新/删除旧条目。

不保存任务进度、临时状态、一次性命令输出；这些属于待办与会话历史。

## 推荐流程

1. 先 `action="search"` 检索同主题记忆，避免重复保存。
2. 需要时 `action="list_rooms"` 查看记忆宫殿结构（翼 → 房间 → 厅）。
3. 新建用 `action="save"`；同类主题复用同一个 `room` 名。
4. 矛盾时先拿到 `id`：
   - 能判定 → `update` 修正（保留 id）或 `delete` 被推翻条目；
   - 无法判定且涉及用户长期偏好 → 用结构化提问一次性问清，再更新/删除。
5. 重要事实可 `action="pin"` 置顶（进入 L1 关键事实常驻层）。

## action / 参数速查

- `save`：`room`、`hall`（`decision` / `event` / `discovery` / `preference` / `suggestion`）、`verbatim`、`insight`、`tags`、`importance`（0-1，默认 0.5）。
- `search`：`query`、`wing`（项目名或 `user`）、`topK`（默认 10，最大 50）。
- `list_rooms`：无必填参数。
- `update`：`id` + `room`/`hall`/`verbatim`/`insight`/`tags`/`importance`/`pinned` 至少一项。
- `delete`：`id`。
- `pin`：`id` + `pinned`（true 置顶 / false 取消）。

## 写作要求

- `insight` 必须是一句话、自包含、无歧义；它会被注入未来上下文。
- `verbatim` 保留关键原话，供追溯。
- `preference` / `suggestion` 自动存入全局 `user` 翼；其余存入当前项目翼。
- `importance >= 0.75` 进入关键事实常驻层；默认 0.5。
- `room` 用英文小写连字符（如 `context-engine`），同类主题保持同名。

## 冲突修正优先级

用户最新明确表述 > 用户纠正 > 当前任务可验证事实 > 旧记忆。

禁止并存两条互斥记忆。

## 禁止事项 / 反模式

- 不凭记忆假设长期偏好；先 `search`。
- 不保存任务进度、临时路径、一次性状态。
- 不重复创建同主题记忆；先搜后存。
- 不用 `update` 改名式地复制一条新记忆；同类主题复用 room。
- 不在证据不足时擅自删除用户长期偏好；用提问工具澄清。

## 相关源码与提示词

- `src/modules/tools/memory/tool.json`
- `src/modules/memory/`
- `agent/prompt/memory/*.md`
- `agent/prompt/main/system.md`（记忆沉淀段）
