// render/index.ts
// 渲染模块唯一公共出口 —— 外部（消息区/设置页/其他页面）只准从这里 import。
// 重依赖（shiki/mermaid/mathjax/pdfjs/three/docx/video.js）全部在各子模块内部 dynamic import，
// 引用本模块本身的首屏成本仅 markdown-it + katex css。

// Markdown 渲染
export { MarkdownRenderer } from './markdown/MarkdownRenderer';
export type { MarkdownRendererProps } from './markdown/MarkdownRenderer';

// 代码块（RunCodeCard 的程序页签复用）
export { CodeBlock } from './code/CodeBlock';

// Intelligent UI（run_code 生成的交互界面）
export { GenUIRenderer } from './genui/GenUIRenderer';
export type {
  GenUISpec,
  GenUIDiagnostic,
  GenUINode,
  GenUIBinding,
  GenUIAction,
  GenUIStateValue,
} from './genui/types';

// 文件预览
export { FilePreviewCard } from './file/FilePreviewCard';
export { FilePreviewDialog } from './file/FilePreviewDialog';
export { FilePreviewPane } from './file/FilePreviewPane';
export { detectFileKind, fileNameOf, fileExtension } from './file/detector';
export { pathSource, memorySource, archiveEntrySource, nameOfSource, extOfSource } from './core/source';
export type { PreviewSource } from './core/source';

// 设置
export { useRenderSettings } from './core/settings';
export { DEFAULT_RENDER_SETTINGS, isValidRenderSettings } from './core/types';
export type { RenderSettings, RenderBlock, RendererKind } from './core/types';

// 样式（katex 字体 + 排版 + 文件预览）
import 'katex/dist/katex.min.css';
import './styles/markdown.css';
import './styles/file-preview.css';
