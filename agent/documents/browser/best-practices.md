# 浏览器操作最佳实践

## 适用场景与入口判据

任何网页任务优先使用 `browser`：打开/登录/点击/填表/下载/读取 JS 渲染内容/截图。

不要用 `terminal` 的 `curl`、`wget`、`Invoke-WebRequest` 代替浏览器操作。出现 401/403/429、验证码/挑战页、空正文、重定向环、登录墙时，立即切换 `browser`，不要在终端反复换 UA/代理。

## 推荐流程

1. `action="status"`：确认桥接/实例与扩展安装状态。
2. 会话首次 `action="open"` 必须提供 `group_name`（8~10 个字符，系统自动加「MOSS - 」前缀），返回稳定 `group_id`；之后可省略，自动沿用。
3. 页面操作前先 `action="snapshot"`，拿到带 `ref=eN` 的可交互元素树。
4. 用 `click` / `type` / `press_key` / `select` / `hover` / `scroll` / `drag` 按 `ref` 操作。
5. 页面变化后重新 `snapshot`，不要复用旧 ref。
6. 用 `screenshot`、`console`、可见文本或 `wait_change` 验证结果。
7. 结束后按需 `close`；不要接管用户已有标签页。

## action / 参数速查

- 观察：`status`、`snapshot`、`screenshot`、`tabs`、`console`、`wait`。
- 建页与管理：`setup`、`open`、`focus`、`close`。
- 页面操作：`navigate`（`url` / `back` / `forward` / `reload`）、`click`、`hover`、`type`（`text` / `replace` / `submit`）、`press_key`（`key` / `modifiers`）、`select`（`values`）、`scroll`（`delta_x` / `delta_y`）、`drag`、`evaluate`（`script`）。
- 连续交互：`key_down`、`key_up`、`hold`（`keys` + `duration_ms`，最大 5000）、`macro`（1-32 步，支持 `key_down` / `key_up` / `hold` / `press_key` / `click` / `scroll` / `wait` / `screenshot` / `wait_stable` / `wait_change`）。
- 等待与验证：`wait`（`ms` / `selector` / `text`）、`wait_stable`、`wait_change`（`threshold` 帧差阈值）。
- 定位：`ref` / `selector` / `x`+`y` 至少提供一个；`click` 可用 `coord_space="screenshot"` 直接使用截图像素。
- iframe：先 `action="frames"` 列出子会话，再用 `frame="auto"` 或 `targetId`。
- 截图：`full_page`、`clip`；`console` 可 `clear`。

## 失败信号与恢复

- `snapshot` 找不到目标：先滚动、展开、键盘导航或过滤，再考虑坐标；不要盲点。
- `click` 后页面无变化：重新 `snapshot` 确认 ref 是否失效；同一失败两次换策略。
- 元素被遮挡/在 iframe：先切 `frame`，再操作；不要跨 iframe 用主页面坐标。
- 弹窗/新标签：`_blank` 会留在本会话固定分组；用 `tabs` 查看，不要跨分组操作。
- 连续按键/游戏：用 `hold` 或 `macro`，不要连发瞬时 `press_key`；用 `wait_change`/`wait_stable` 判断生效。

## 验证与验收

- 导航/提交后重新 `snapshot` 或读取可见文本。
- 关键动作后用 `screenshot` 或 `console` 确认；`macro` 默认返回 `effect=changed/no-change`。
- 下载/登录等状态变化，用页面内容或文件落盘结果验证。

## 禁止事项 / 反模式

- 不用终端命令代替浏览器打开/操作网页。
- 不用固定长等待代替「元素出现/网络就绪」判断。
- 不跨 MOSS 分组操作、不抢占用户标签页、不把窗口抬到前台。
- 不在同一页面反复盲点；同一失败两次必须换策略。
- 不把 `group_name` 设成错误名称：显式传入错误名称会直接报错，不会新建第二个分组。

## 相关源码与提示词

- `src/modules/tools/browser/tool.json`
- `src/modules/tools/browser/index.ts`
- `agent/prompt/main/system.md`（浏览器/桌面段）
