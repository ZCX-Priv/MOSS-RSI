// TSX 内嵌页面运行时：Vite 插件把 React/ReactDOM 的 CJS production 源码以原始字符串注入。
// 见 webui/vite.config.ts 的 mossReactCjsRaw 插件。
// 本文件必须是「脚本」（无 import/export），否则 declare module 会被当成模块增强而找不到目标。
declare module 'virtual:react-cjs-raw' {
  const sources: Record<'react' | 'react-dom' | 'react-dom-client' | 'scheduler', string>;
  export default sources;
}
