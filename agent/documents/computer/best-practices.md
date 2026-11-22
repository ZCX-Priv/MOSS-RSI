# 桌面操作最佳实践

## 适用场景与入口判据

任何桌面 GUI 任务优先使用 `computer`：窗口、按钮、表单、弹窗、文件管理器、IDE、Office、非网页应用。

不要用 PowerShell COM/UIA 脚本拼凑 UI 操作；`computer` 已封装 cua-driver 的后台投递、效果校验与升级策略。

## 推荐流程

1. `action="list_windows"` 找窗口（或 `list_apps` 找应用）。
2. `action="get_window_state"`（`pid` + `window_id`）同时拿 UIA 元素树与窗口截图。
3. 优先用元素树中的 `element_token` 执行 `click` / `type_text` / `press_key` / `set_value`；像素 `x`/`y` 只用于画布/自绘界面。
4. 动作后用 `get_window_state` + `since="latest"` 增量验证。
5. 已知连续动作时用 `action="run_steps"`（`steps` 为 `[{tool,args}]`，最多 32 步）减少往返。
6. 需要循环/条件/断言时用 `run_script`；确定性断言用 `verify`。

## action / 参数速查

- 观察：`status`、`list_apps`、`list_windows`、`get_window_state`、`get_desktop_state`、`get_screen_size`、`get_cursor_position`、`zoom`。
- 焦点：`focus`。
- 动作：`click`、`double_click`、`right_click`、`drag`、`scroll`、`type_text`、`press_key`、`hotkey`、`set_value`、`launch_app`、`kill_app`、`clipboard_read`、`clipboard_write`。
- 批量：`run_steps`、`run_script`、`verify`。
- 本地等待：`wait`。
- 关键参数：`pid`、`window_id`、`element_token`、`x`/`y`、`scope`（`window`/`desktop`）、`delivery_mode`（`background`/`foreground`）、`auto_focus`、`respectUserInput`。
- 坐标：`x`/`y` 直接使用对应截图的像素，不要按窗口物理尺寸或屏幕分辨率换算；`scope="desktop"` 使用 `get_desktop_state` 截图像素。

## effect 语义

- `confirmed`：动作已生效。
- `unverifiable`：可能已生效但无法确认，**不要重复投递**。
- `suspected_noop`：疑似未生效，先补拍窗口截图确认，再决定是否重试。
- `refused`：驱动拒绝执行，按错误提示调整目标/模式。

`delivery_mode` 默认 `background`；仅当驱动明确返回 `background_unavailable`（表示未投递）时，工具才会自动用 `foreground` 重试一次。`effect=unverifiable` 或 `foreground_unavailable` 表示动作可能已生效，工具不会重复投递。

## 浮层与特殊窗口

- 同一应用弹出浮层/对话框且驱动已登记时，目标会自动切换到最前面的浮层，截图与 UIA 树都来自浮层。
- Qt 自绘/无标题弹层未被驱动登记时，不会切换 `window_id`；工具返回整屏截图 + Windows 原生 UIA，此时用 `scope="desktop"` 的 `x`/`y` 操作。
- `auto_focus=false` 可关闭自动聚焦。

## 失败信号与恢复

- 元素找不到：先过滤/滚动/键盘导航，仍找不到才用像素坐标。
- `suspected_noop`：补拍程序窗口截图；仍无变化再考虑整页滚动/PageDown 或换投递模式。
- `background_unavailable`：让工具自动升级 foreground；不要手动重复发送同一动作。
- 滚动：`direction` 可省略（由 `delta_y`/`delta_x` 推导），`amount` 为 tick 数（1-50，缺省 3），`by="line"|"page"`；工具会做前后帧校验，画面无变化时换整页滚动。

## 验证与验收

- 每次关键动作后用 `get_window_state` + `since="latest"` 或截图验证。
- 需要确定性结果时用 `verify`；不要只看动作返回值。
- 用户正在操作时，`respectUserInput` 会让前台动作等待让路；前台动作结束后尽量恢复光标位置。

## 禁止事项 / 反模式

- 不用 PowerShell COM/UIA 手写脚本硬凑 UI 操作。
- 不按物理分辨率换算坐标；直接使用截图像素。
- 不在 `unverifiable` / `foreground_unavailable` 后重复投递同一动作。
- 不跳过窗口状态直接盲点；没有 `element_token` 时才用坐标。
- 不把整屏截图当作默认画面来源；优先目标窗口截图。

## 相关源码与提示词

- `src/modules/tools/computer/tool.json`
- `src/modules/computer/`
- `agent/prompt/main/system.md`（桌面段）
