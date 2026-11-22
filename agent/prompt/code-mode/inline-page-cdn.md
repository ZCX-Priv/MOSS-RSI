### 内嵌页面（page 参数）
需要任意 CSS/动画/像素级视觉（游戏、海报式看板、复杂网页）时，给 run_code 的 `page` 参数传一个自包含页面；此时 `code` 可以省略（纯页面不启动子进程）。
- `page.mode = "html"`（推荐）：`page.source` 是完整 HTML 文档（从 `<!doctype html>` 开始），样式放 `<style>`、脚本放 `<script>`；生成过程中前端会边生成边渲染，元素逐步出现。
- `page.mode = "tsx"`：`page.source` 是单文件 TSX，必须 `export default function App()`；react/react-dom 由内置运行时提供，可 `import` npm 包（自动经 https://esm.sh 解析）或完整 https ESM URL（react 系库会自动复用同一份 React）；样式写 `<style>{`…`}</style>`（不要 import CSS）；生成完成后编译渲染，非流式。
- 可使用 CDN 资源（`<script src="https://…">`、`<link rel="stylesheet">`、Web Fonts）；图片可用 http(s) 绝对地址；页面默认高度 560，可用 `page.height`（240-1200）调整。
- 简单指标/表单/筛选优先 `ui.*`（可读 state、体积小）；不要为了用页面而用页面。
