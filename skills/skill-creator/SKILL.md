---
name: skill-creator
description: 创建、更新或安装 MOSS 用户级技能。当用户要求新建技能、修改技能、解释技能格式，或从 GitHub、本地目录、压缩包安装现有技能时使用。不用于调用工具。
---

# 技能创建器（Skill Creator）

创建、更新或**安装** MOSS 技能，并把它放到用户级技能目录 `~/.moss/skills/`。技能是给 Agent 的一组指令目录，不是工具，也不是 API。不要调用名为 `skill-creator` 的工具；这个文件本身就是流程。

用户要求安装时，就执行安装，不要只把目标路径打印出来。

## 先决策（Decide first）

只看当前用户消息，不要问用户是内部还是外部用户，也不要问消息里已经给出的信息。

| 情况 | 动作 |
|------|------|
| 用户要沉淀某类任务的可复用做法 | 创建（Create） |
| 用户明确要求修改或编辑已有技能 | 更新（Update），先定位唯一目标并读取其 `SKILL.md` |
| 用户只问技能长什么样、格式如何 | 解释（Explain），不创建目录 |
| 用户明确要求安装 GitHub、本地目录或压缩包里的现有技能。只提来源不算安装意图 | **安装（Install）**，文件落到 `~/.moss/skills/` 才算完成 |
| 任务是通用模型知识或一次性操作，没有可复用流程 | 拒绝，并说明原因 |
| 用户想要“项目专用”技能 | 仍安装到用户级 `~/.moss/skills/`，在 `description` 里写明适用项目。MOSS 当前没有项目级技能目录 |

只问缺失的信息（名称、用途、触发场景、安装来源），一次问完，然后继续。

## 位置（Location）

MOSS 只有**用户级**技能根目录，当前版本不支持项目级技能目录；仓库里的 `.moss/skills/` 不会被加载。

| 类型 | 路径 |
|------|------|
| 技能根目录 | `~/.moss/skills/` |
| 目录式技能 | `~/.moss/skills/<skill-folder>/SKILL.md` |

Windows 下 `~/.moss/` 通常对应 `%USERPROFILE%\.moss\`。

目录结构（技能一律放在用户级根目录下）：

```text
~/.moss/skills/<skill-folder>/
├── SKILL.md           # 必需，技能入口
├── references/        # 可选，长文档，按需读取
├── scripts/           # 可选，需要精确执行的脚本
├── assets/            # 可选，模板、图片、样板文件
└── guides/ 等         # 可选，其它子目录同样可以放文件
```

规则：

- `name` 必须等于目录名 `<skill-folder>`。
- `SKILL.md` 之外的文件都是附属文件。注册表会递归收集技能目录下所有非隐藏文件（`SKILL.md`、`node_modules`、`__pycache__` 除外）并列入技能清单，LLM 用 `read` 工具按需读取；`references/`、`scripts/`、`assets/` 是约定目录，`guides/`、`examples/`、`tools/` 等其它子目录同样可用。
- 目标目录已存在时，只有用户明确要求更新才改动；否则停止并报告已有路径，不要另起名字再建一份。
- 包内 `skills/` 是播种与升级源，运行时唯一加载源是 `~/.moss/skills/`。启动时逐文件哈希对比：用户未改的文件自动升级，用户改过的文件保留；用户删除的技能不会补种。`~/.moss/skills/.seed-manifest.json` 记录逐文件指纹。
- 兼容旧版单文件技能 `~/.moss/skills/<name>.md`；新技能一律用目录式格式。

## Frontmatter

`SKILL.md` 以 YAML frontmatter 开头，后接 Markdown 正文。frontmatter 必须用独立的 `---` 行开始和结束；解析器只支持简单 `key: value` 子集，不支持嵌套结构。

```yaml
---
name: kebab-case-name
description: 做什么，以及什么时候使用。写上触发词和不该使用的情况。
allowed-tools: read, grep, glob
icon: sparkles
---
```

`name`：

- 加载器硬性要求：匹配 `^[a-z][a-z0-9-]*$`，小写字母开头，只含 `a-z`、`0-9`、`-`
- 约定：2–64 字符，不用连续 `--`，不加引号
- 必须等于父目录名，否则 WebUI 与按名称查找会对不上
- WebUI 新建接口接受大写和下划线，但注册表会拒绝加载；始终使用小写 kebab-case

`description`（路由能看到的唯一触发文本）：

- 一行纯文本，不加 `"..."` 或 `'...'`
- 同时写清楚“做什么”和“什么时候用”
- 触发词放这里，不要只写在正文
- 尽量 200 字符内，不要堆 `MUST`/`MANDATORY`
- 避免 `: `（冒号加空格），需要时改写成破折号或“包括”
- 不要使用 `<` 或 `>`
- 推荐形态：`做 X。当用户要求 Y 或 Z 时使用。不用于 W。`

`allowed-tools`（可选）：用逗号分隔的**字符串**，例如 `read, grep, glob`；不要写成 YAML 数组，解析器只接受字符串，数组会被静默忽略。它只是提示性约束，不是强制沙箱。

`icon`（可选）：Lucide kebab-case 图标名，例如 `sparkles`；或相对技能目录的 `.svg` 文件名，例如 `assets/logo.svg`。`.svg` 路径会被检查，不能跳出技能目录。

## Body

正文是写给模型的操作指令，只写模型还不知道的内容。

- `SKILL.md` 控制在 500 行以内；长材料放 `references/`，在正文里一级引用，不要嵌套引用
- 不要重复 `description`；正文默认技能已经触发
- 不要写 `README.md`、`CHANGELOG.md` 或面向人的项目说明
- 需要精确执行的命令放 `scripts/`；应被复制的模板或素材放 `assets/`，不要让它们直接进上下文

## Create

1. 确认动作是写；MOSS 只有用户级，目标根固定为 `~/.moss/skills/`
2. 把技能名规范为 kebab-case，并校验其符合 `^[a-z][a-z0-9-]*$`
3. 拼出目标路径 `~/.moss/skills/<skill-folder>/`
4. 目标已存在时，除非用户明确要求更新，否则停止并报告现有路径
5. 创建目录，写入带合法 frontmatter 和简短正文的 `SKILL.md`
6. 只在确有需要时创建 `references/`、`scripts/`、`assets/` 等子目录
7. 校验后报告路径和最终 `description`

模板：

```markdown
---
name: code-reviewer
description: 审查代码中的缺陷、回归和可维护性问题。当用户要求代码审查、审查 diff 或 PR、合并前反馈时使用。不用于从零编写代码。
---

# 代码审查

审查给定的代码或 diff。先报告缺陷、缺失测试和具体修复方案；只有样式问题掩盖了缺陷时才提样式。
```

保存后 `fs.watch` 会递归监听 `~/.moss/skills/` 并热重载，不需要重启；WebUI 通过 `/api/skills` 读取最新列表。

## Install

用户要求安装时，必须真正落盘，不能只给路径。

1. 目标根固定为 `~/.moss/skills/`
2. 解析来源：
   - 本地目录：包含 `SKILL.md` 的那个技能目录
   - GitHub 或仓库 URL：只取技能子目录，不要整仓下载
   - 压缩包：解压后的技能目录；也可以走 WebUI 导入（`POST /api/skills/import`，逐文件写入 `~/.moss/skills/<name>/`）
   - MOSS 没有 marketplace，也没有技能安装器；不要假设存在这类命令
3. 把来源放入暂存目录，例如 `~/.moss/skills/.staging-<name>/`
4. 在暂存目录中确认只有**一个**技能目录含 `SKILL.md`；没有或不止一个就停下来问用户
5. 读取暂存目录的 `SKILL.md`，确认 frontmatter 可解析、`name` 合法、`description` 存在，并由 `name` 得到 `<skill-folder>`
6. 安装时保持来源原样：保留原有文件与路径，不改写 frontmatter、不移动资源、不重命名目录。额外的 frontmatter 键和子目录只要不影响加载就保留
7. 目标 `~/.moss/skills/<skill-folder>/` 已存在时，只有用户明确要求覆盖才替换；否则停止并报告已有路径
8. 把暂存目录整体复制到目标位置；需要替换时先保留旧目录，成功后再删除，失败则回滚并清理残留
9. 确认 `<destination>/SKILL.md` 存在后再报告安装路径。文件不在那里之前不要说“已安装”
10. 不要执行下载来的脚本或其它下载文件

复制完成后依赖 `fs.watch` 热重载，无需重启。PowerShell 示例：

```powershell
New-Item -ItemType Directory -Force "$HOME\.moss\skills" | Out-Null
Copy-Item -Recurse -Force ".\my-skill" "$HOME\.moss\skills\my-skill"
```

## Update

1. 先从用户给出的明确路径或名称定位唯一目标；同名目录式与单文件技能同时存在时目录式优先，无法确定就问一次
2. 读取目标 `SKILL.md` 以及将要改动的附属文件
3. 只改变化的部分：`description`、正文某一节，或某个附属文件
4. 保持 `name` 与目录名一致；用户要求改名时，目录一起改名
5. 校验后报告改动点

## Validate

宣告完成前逐项检查：

- 路径正确：`~/.moss/skills/<skill-folder>/SKILL.md`，这是唯一合法位置
- 目录名等于 frontmatter 中的 `name`
- `name` 匹配 `^[a-z][a-z0-9-]*$`
- frontmatter 可解析：以 `---` 开始和结束，键值能被简单 YAML 子集读取
- 正文非空
- `description` 同时包含“做什么”和“什么时候用”，没有 `TODO`
- 正文或配置提到的附属文件确实存在，例如 `references/xxx.md`、`scripts/xxx`、图标 `.svg`
- `allowed-tools` 是逗号分隔字符串；`icon` 要么是 Lucide 名，要么是技能目录内实际存在的 `.svg`
- 新建或修改的脚本至少成功执行一次；安装第三方技能时不执行下载文件
- 安装场景只做最小校验，保持来源原样

校验失败就修正后复查；安装场景校验失败应停止并报告，不要“修复”第三方技能。校验通过后不要反复重读整个文件。

## Anti-patterns

- 为模型已经掌握的知识创建技能
- 触发词只写在正文，`description` 里没有
- 把 `skill-creator` 当工具调用，或要求模型“先调用 skill-creator”
- 用户已经给出名称、用途或来源还重复追问
- 用户要求安装时只打印路径而不落盘
- 把技能写到当前项目目录（MOSS 不加载项目级技能）
- 把“从网上安装”当成“创建项目技能”
- 安装第三方技能时重写 frontmatter、移动文件或重命名目录
- 覆盖用户已有的同名技能而不先确认
- 文件不存在或校验未通过就宣称完成
- 在技能目录里创建 `README.md`、`CHANGELOG.md`
- 假设存在 marketplace 或技能安装器命令
