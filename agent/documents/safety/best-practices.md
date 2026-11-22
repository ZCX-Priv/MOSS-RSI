# 安全与权限最佳实践

## 权限模式

- `ask`（默认）：L0/L1 放行，L2/L3 询问用户；未知工具 fail-closed 归 L3。
- `auto`：L0/L1 放行，L2/L3 交给审查模型裁决；审查失败按配置转人工或拒绝。
- `skip`：跳过人工确认，但危险命令与 `~/.moss` 硬规则仍然生效。

## 风险分级

- **L0 只读**：无副作用（`read` / `glob` / `grep` / 观察类动作 / MCP readOnlyHint）。
- **L1 状态**：会话内状态，无系统副作用（`ask` / `todo`）。
- **L2 可恢复写**：有备份/回收站兜底（`write` / `edit` / `move` / `delete` / `copy`）。
- **L3 无兜底**：任意命令/外部副作用（`terminal`、MCP destructiveHint、未标注/自定义工具）。

## 决策流水线（按顺序短路）

1. 工具 disabled → DENY。
2. 终端命令访问 `~/.moss` 越界 → DENY（全局硬规则，`skip` 也拦）。
3. deny 规则命中（会话 > 项目 > 全局）→ DENY（所有模式）。
4. ask 规则命中 → ASK（所有模式）。
5. 危险命令：BLOCK 级 → DENY；CAUTION 级 → `skip` 放行 / 配 deny 直接拒绝 / 其余 ASK。
6. 写类工具保护路径：`~/.moss/config` 硬保护 → DENY；用户 `protectedPaths` 在非 `skip` 模式 DENY。
7. `skip` → ALLOW。
8. allow 规则命中 → ALLOW。
9. `auto` → L0/L1 ALLOW，L2/L3 交审查模型。
10. `ask` → L0/L1 ALLOW，L2/L3 ASK。

## 危险命令示例

BLOCK 级（无条件拒绝）：磁盘格式化/分区、`mkfs`、引导配置、`reg delete/add`、`rm -rf` 根/家目录、`del /f`、`rd /s /q`、`Remove-Item -Recurse -Force`、提权执行、下载管道执行、`iex`/`Invoke-Expression`、`powershell EncodedCommand`。

CAUTION 级（默认确认）：`git push --force`、`git reset --hard`、`git clean -fd`、`npm publish`、`chmod -R 777`。

## `.moss` 白名单

`~/.moss` 下仅以下子目录允许 AI 访问：

- `agent`（含 `prompt/`、`documents/`）
- `mcps`
- `skills`

其他内容（`config/`、`tasks/` 等）一律屏蔽，防止自我提权。`~/.moss/config` 是写类工具的硬保护路径。

## 操作建议

- 破坏性/不可逆操作前先确认：删除、覆盖、强制推送、发布、外发数据。
- 预演/小样优先：先只读检查，再执行写操作。
- 命中 ASK 时，用确认卡片说明目的、影响范围、可回滚性；不要用文字绕过确认。
- 用户拒绝后换低风险路径，或请用户手动执行；不要重复尝试同一操作。
- 用 `read` / `git diff` 复核写操作结果。

## 禁止事项 / 反模式

- 不伪造权限决策或假装已确认。
- 不通过终端、脚本、别名绕过 `.moss` 白名单或保护路径。
- 不在 `skip` 模式下执行未评估的破坏性操作；危险命令仍会被拦截。
- 不把未知工具当低风险；未标注即按 L3 处理。
- 不在错误信息中泄露密钥/凭据。

## 相关源码与提示词

- `src/modules/safety/policy.ts`
- `src/modules/safety/types.ts`
- `src/modules/safety/patterns.ts`
- `agent/prompt/safety/review.md`
