### ui 构建器（规格化智能界面）

在 run_code 程序内用 `ui.*` 构建界面规格；前端会把它渲染在「代码」步骤下方的消息流里。
除 `Embed` 外，它不是 HTML/iframe，也不是工具卡片；交互在浏览器本地闭环（点击/输入只改 state、重算表达式），不会回调模型。

**何时用**：数据仪表盘、表单、计算器、筛选器、配置器、数据浏览器、状态驱动的棋盘/小游戏。
**何时不用**：一次问答、纯文本结论、代码解释；需要任意 CSS/动画/像素级视觉时，改用 run_code 的 `page` 参数（见「内嵌页面」说明）；在智能界面内部需要局部页面时用 `ui.embed({ mode, source })`。
**禁令**：不要用 `browser` 截图冒充聊天内界面；`browser` 只用于访问/验证外部网页。

{{UI_DECLARATIONS}}

**视觉属性（所有布局/容器/文本组件通用）**
- `tone`：default | muted | primary | success | warning | danger | info
- `radius`：none | sm | md | lg | xl | full；`shadow`：none | sm | md
- `surface`：none（透明）| soft（浅底）| solid（实底）；`border`：布尔
- `gap` / `padding`：0-8 的间距刻度（1 ≈ 4px）
- 小标签用 `Text size="xs"`；数值用 `Stat` 或 `Text` 的 tabular 风格；重点数字用 `Title`

**布局**
- 多列/等宽/棋盘：用 `ui.grid({ columns })`；一维排列用 `ui.box({ direction, align, justify, gap, wrap })`。
- `Box row` 只放短内容；Table/Chart/长文本让它独占一行，避免被挤压。
- 成组信息优先 `ui.card({ title })`；小节之间用 `ui.section` 或 `ui.divider`。

**状态与交互**
- 交互状态必须用 `ui.state(key, initial)` 声明；程序里的普通变量在程序结束后不存在。
- `ui.state` 的返回值是绑定对象，只用于 props；表达式字符串里直接写 state key 名（如 `body`），不要写 JS 变量名。
- 必须调用 `ui.render(root)` 才会显示；只构建节点不 render 等于没做。
- `ui.set(key)` 写入输入组件的当前值或 Button 的 `value`；`ui.apply(key, expr)` 用表达式计算并写回。
- `ui.seq(...actions)` 顺序执行，后一步能读到前一步的写入结果；`ui.reset()` 让所有 state 回到初始值。
- 表达式只读 state 顶层键，支持 `+ - * / %`、比较、`&& || !`、三元、括号；函数：`round/floor/ceil/abs/min/max/len/number/string/contains/indexOf/lastIndexOf/slice/part/charAt`。
- 禁止属性访问/索引/赋值/循环/定时器/随机数；只支持事件驱动的回合制交互，不支持实时动画。
- 所有标量属性都可以传 UIBinding 做动态渲染（例如按状态给格子上色）。

**示例 1：指标仪表盘**
```ts
ui.render(ui.box({ gap: 3 }, [
  ui.box({ direction: 'row', justify: 'between', align: 'center' }, [
    ui.box({ gap: 0.5 }, [ui.title({ size: 'lg' }, '收入概览'), ui.text({ size: 'xs', tone: 'muted' }, '最近 30 天')]),
    ui.badge({ tone: 'success', variant: 'soft', dot: true }, '实时'),
  ]),
  ui.grid({ columns: 3, gap: 2 }, [
    ui.stat({ label: '总收入', value: '¥128,400', delta: '+12.4%', trend: 'up', tone: 'primary' }),
    ui.stat({ label: '订单数', value: '1,284', delta: '+3.1%', trend: 'up' }),
    ui.stat({ label: '退款率', value: '1.2%', delta: '-0.3%', trend: 'down', tone: 'success' }),
  ]),
  ui.chart({ kind: 'area', height: 220, data: [{ label: '周一', value: 12 }, { label: '周二', value: 18 }, { label: '周三', value: 9 }] }),
]), { title: '经营看板' });
```

**示例 2：回合制贪吃蛇（10×10）**
```ts
const W = 10;
const body = ui.state('body', '5,5;4,5;3,5');
const dir = ui.state('dir', 'right');
ui.state('hx', 5); ui.state('hy', 5);
ui.state('nx', 5); ui.state('ny', 5);
ui.state('hit', 0); ui.state('eat', 0);
ui.state('score', 0); ui.state('status', 0);
ui.state('fx', 7); ui.state('fy', 3);
const cells = [];
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    cells.push(ui.box({
      height: 26, radius: 'sm', surface: 'soft', border: true,
      tone: ui.expr(`contains(body, '${x},${y}') ? (hx == ${x} && hy == ${y} ? 'primary' : 'success') : (${x} == fx && ${y} == fy ? 'warning' : 'muted')`),
    }));
  }
}
ui.render(ui.card({ title: '贪吃蛇', subtitle: '回合制 · 10×10' }, [
  ui.grid({ columns: 2, gap: 2 }, [
    ui.stat({ label: '得分', value: ui.expr('score'), tone: 'primary' }),
    ui.stat({ label: '状态', value: ui.expr("status == 2 ? '已结束' : '进行中'"), tone: ui.expr("status == 2 ? 'danger' : 'success'") }),
  ]),
  ui.grid({ columns: W, gap: 0.5 }, cells),
  ui.box({ direction: 'row', gap: 2, justify: 'center' }, [
    ui.button({ label: '↑', variant: 'secondary', value: 'up', onClick: ui.set('dir') }),
    ui.button({ label: '←', variant: 'secondary', value: 'left', onClick: ui.set('dir') }),
    ui.button({ label: '↓', variant: 'secondary', value: 'down', onClick: ui.set('dir') }),
    ui.button({ label: '→', variant: 'secondary', value: 'right', onClick: ui.set('dir') }),
  ]),
  ui.box({ direction: 'row', gap: 2 }, [
    ui.button({ label: '前进一步', onClick: ui.seq(
      ui.apply('nx', 'status == 2 ? hx : hx + (dir == "left" ? -1 : dir == "right" ? 1 : 0)'),
      ui.apply('ny', 'status == 2 ? hy : hy + (dir == "up" ? -1 : dir == "down" ? 1 : 0)'),
      ui.apply('hit', 'status == 2 ? 0 : (nx < 0 || nx > 9 || ny < 0 || ny > 9 || contains(slice(body, 0, lastIndexOf(body, ";")), nx + "," + ny) ? 1 : 0)'),
      ui.apply('eat', 'hit == 0 && nx == fx && ny == fy ? 1 : 0'),
      ui.apply('status', 'hit == 1 ? 2 : status'),
      ui.apply('score', 'eat == 1 ? score + 1 : score'),
      ui.apply('body', 'hit == 1 ? body : (eat == 1 ? nx + "," + ny + ";" + body : nx + "," + ny + ";" + slice(body, 0, lastIndexOf(body, ";")))'),
      ui.apply('hx', 'hit == 1 ? hx : nx'),
      ui.apply('hy', 'hit == 1 ? hy : ny'),
      ui.apply('fx', 'eat == 1 ? (score * 3 + 1) % 10 : fx'),
      ui.apply('fy', 'eat == 1 ? (score * 7 + 3) % 10 : fy')
    ) }),
    ui.button({ label: '重新开始', variant: 'secondary', onClick: ui.reset() }),
  ]),
  ui.text({ size: 'xs', tone: 'muted' }, ui.expr('"得分 " + score + (status == 2 ? " · 撞到自己了" : "")')),
]), { title: "贪吃蛇" });
```

**规则**
- state key 只能是 `[A-Za-z_][A-Za-z0-9_]{0,63}`；禁止 `__proto__`/`prototype`/`constructor`。
- `Image.src` 只允许 `/api/filesystem/media?...` 本机媒体地址；不支持外链与 data URL。
- 界面渲染失败会回退到文本结果并附诊断；不要让整段程序只依赖 UI。
