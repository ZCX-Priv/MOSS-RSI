// render/core/types.ts
// 渲染模块公共类型定义。

/** 流式分块：一个 markdown 块（段落/代码块/数学块/表格等） */
export interface RenderBlock {
  /** 块序号（append-only 流中稳定，用作 React key） */
  index: number;
  /** 块原始文本（含内部换行） */
  raw: string;
  /** 是否已闭合（后面出现过空行/新块边界）；文本末尾的块为 false（活跃块） */
  closed: boolean;
  /** 顶层围栏代码块的语言标识（'' = 无语言）；普通 markdown 块为 undefined */
  fenceLang?: string;
}

/** 文件预览类型（按扩展名检测） */
export type RendererKind =
  // Office：有原生前端渲染
  | 'office-docx'
  | 'office-xlsx'
  | 'office-pptx'
  // Office：无成熟前端方案，走后端文本提取回退
  | 'office-odf'
  | 'office-legacy'
  | 'pdf'
  // 电子书（epub 走 epubjs；mobi/azw3/fb2 走文本回退）
  | 'ebook'
  | 'video'
  | 'audio'
  | 'html'
  | 'markdown'
  | 'latex'
  | 'code'
  | 'data'
  | 'font'
  | 'archive'
  | 'three-d'
  | 'image'
  // ── 结构化文本（专用渲染器，非纯文本） ──
  | 'subtitle'
  | 'calendar'
  | 'contact'
  | 'geo'
  | 'certificate'
  | 'colorprofile'
  // ── 专用格式 ──
  | 'cad'
  | 'sqlite'
  | 'flash'
  | 'text'
  | 'unknown';

/** 渲染设置（设置页"渲染"分区控制，IndexedDB 持久化） */
export interface RenderSettings {
  /** Markdown 渲染总开关（关闭回退纯文本） */
  markdownEnabled: boolean;
  /** 数学公式渲染（KaTeX；关闭显示原始 LaTeX） */
  mathEnabled: boolean;
  /** KaTeX 失败时懒加载 MathJax 4 回退（100% LaTeX 覆盖） */
  mathFallback: boolean;
  /** Mermaid 图表渲染（关闭按普通代码块显示源码） */
  mermaidEnabled: boolean;
  /** 代码块 Shiki 语法高亮（关闭显示纯文本） */
  codeHighlightEnabled: boolean;
  /** 正文中文件引用识别为内联预览卡片 */
  filePreviewEnabled: boolean;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  markdownEnabled: true,
  mathEnabled: true,
  mathFallback: true,
  mermaidEnabled: true,
  codeHighlightEnabled: true,
  filePreviewEnabled: true,
};

/** 校验未知对象是否为合法 RenderSettings（IndexedDB 恢复用） */
export function isValidRenderSettings(v: unknown): v is RenderSettings {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.markdownEnabled === 'boolean' &&
    typeof o.mathEnabled === 'boolean' &&
    typeof o.mathFallback === 'boolean' &&
    typeof o.mermaidEnabled === 'boolean' &&
    typeof o.codeHighlightEnabled === 'boolean' &&
    typeof o.filePreviewEnabled === 'boolean'
  );
}
