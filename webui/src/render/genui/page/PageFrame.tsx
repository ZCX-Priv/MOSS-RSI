// webui/src/render/genui/page/PageFrame.tsx
// 内嵌页面渲染器（Intelligent UI · page 参数）：
//   - html：生成过程中直接以 srcdoc 渐进渲染（禁用脚本、剥离 script），完成后挂载完整沙箱；
//   - tsx：后端已编译为 CJS，这里只负责组装运行时文档（重模块按需动态加载）。
// 安全：iframe sandbox 不含 allow-same-origin（不透明源），页面无法访问宿主 DOM / 存储。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStore } from '../../../store';
import { injectBodyScript, injectHeadHtml, injectHeadScript, MEASURE_SCRIPT, SANDBOX_SHIM } from './sandbox-compat';

export interface PageFrameProps {
  mode: 'html' | 'tsx';
  source: string;
  title?: string;
  height?: number;
  /** 生成中（仅 html 模式有意义）：禁用脚本 + 顶部进度条 */
  streaming: boolean;
  dark: boolean;
  /** tsx 页面的后端编译产物（CJS 文本） */
  compiledJs?: string;
}

/** 完成后允许的能力（与 HtmlPreview 同口径，但不给 allow-same-origin） */
const SANDBOX_FINAL = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock';
const DEFAULT_HEIGHT = 560;
/** tsx 首帧高度：测量到内容高度后再收缩/扩展 */
const TSX_INITIAL_HEIGHT = 320;
/** 页面按桌面宽度排版，再等比缩放到聊天列宽度（避免宽布局被挤扁） */
const PREVIEW_BASE_WIDTH = 960;

const FRAGMENT_RESET =
  '<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0;min-height:100%}' +
  'body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans SC",sans-serif}' +
  'button,input,select,textarea{font:inherit}</style>';

/** 关闭 CDN 时注入的 CSP：拦截外链 script/style/font，保留内联、图片、fetch 与内联 Worker */
const NO_CDN_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; " +
  "img-src http: https: data: blob:; media-src http: https: data: blob:; font-src data:; " +
  "connect-src http: https: ws: wss:; worker-src blob: data:";

/** 非完整文档（片段）补一层最小外壳；完整文档原样使用 */
function normalizeHtml(source: string, dark: boolean): string {
  const trimmed = source.trimStart();
  if (/^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return source;
  const theme = dark ? 'color-scheme:dark;background:#0b0b0c;color:#e5e5e5;' : 'color-scheme:light;background:#fff;color:#18181b;';
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><style>html,body{${theme}}</style>${FRAGMENT_RESET}</head><body>${source}</body></html>`;
}

/**
 * 流式预览剥离 script（闭合 + 未闭合）。
 * 未闭合的 <script> 会把其后全部 HTML 当作脚本文本，导致预览「卡死/空白」。
 */
function stripScriptsForPreview(source: string): string {
  return source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*$/i, '');
}

export function PageFrame({ mode, source, title, height, streaming, dark, compiledJs }: PageFrameProps) {
  const { t } = useTranslation();
  const allowCdn = useStore((s) => s.appConfig?.agent.codeMode.allowCdn ?? true);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [tsxHtml, setTsxHtml] = useState<string | null>(null);
  const [tsxError, setTsxError] = useState<string | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  // 容器宽度：页面按桌面宽度排版后等比缩放到聊天列
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (el.clientWidth > 0) setContainerWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setContainerWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // tsx 运行时文档按需构建（重模块懒加载；编译本身已在后端完成）
  useEffect(() => {
    if (mode !== 'tsx') {
      setTsxHtml(null);
      setTsxError(null);
      return;
    }
    setTsxHtml(null);
    setTsxError(null);
    if (streaming || !compiledJs) return;
    let alive = true;
    void import('./tsx-page')
      .then(({ buildTsxDocument }) => {
        if (alive) setTsxHtml(buildTsxDocument(compiledJs, dark, allowCdn));
      })
      .catch((err: unknown) => {
        if (alive) setTsxError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [mode, compiledJs, streaming, dark, allowCdn]);

  // 内容变化时重新测量
  useEffect(() => {
    setContentHeight(null);
  }, [mode, source, compiledJs]);

  // tsx 页面通过 postMessage 上报内容高度，iframe 随之贴合内容（消除大片空白）
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const raw = (event.data as { __mossPageHeight?: unknown } | null)?.__mossPageHeight;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return;
      const next = Math.max(240, Math.min(1200, Math.ceil(raw)));
      setContentHeight((prev) => (prev !== null && Math.abs(prev - next) < 8 ? prev : next));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const html = useMemo(() => {
    if (mode === 'tsx') return tsxHtml;
    let doc = normalizeHtml(streaming ? stripScriptsForPreview(source) : source, dark);
    if (!allowCdn) {
      doc = injectHeadHtml(doc, `<meta http-equiv="Content-Security-Policy" content="${NO_CDN_CSP}"/>`);
    }
    if (streaming) return doc;
    // 完成态：先装沙箱兼容层（不透明源的 storage），再挂内容高度测量
    return injectBodyScript(injectHeadScript(doc, SANDBOX_SHIM), MEASURE_SCRIPT);
  }, [mode, source, streaming, dark, tsxHtml, allowCdn]);

  const baseHeight = Math.max(240, Math.min(1200, height ?? DEFAULT_HEIGHT));
  // 设计宽度：不低于 960；容器更宽时直接用容器宽度（scale = 1）
  const designWidth = Math.max(PREVIEW_BASE_WIDTH, containerWidth || PREVIEW_BASE_WIDTH);
  const scale = containerWidth > 0 ? Math.min(1, containerWidth / designWidth) : 1;
  const logicalHeight =
    mode === 'tsx'
      ? Math.max(240, Math.min(1200, contentHeight ?? TSX_INITIAL_HEIGHT))
      : Math.max(240, Math.min(1200, contentHeight ?? baseHeight));
  const visualHeight = Math.max(160, Math.round(logicalHeight * scale));

  const openInNewTab = (): void => {
    if (!html) return;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    window.open(url, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  /** 重新挂载 iframe：重跑页面脚本并重新测量内容高度 */
  const reload = (): void => {
    setContentHeight(null);
    setReloadSeq((n) => n + 1);
  };

  return (
    <div ref={containerRef} className="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-card/40 shadow-sm">
      <div className="flex h-9 items-center gap-2 border-b border-border/60 px-2.5">
        <span className="size-1.5 shrink-0 rounded-full bg-primary" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {title || t('task.runCode.page.untitled')}
        </span>
        {streaming ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-info">
            <Loader2 className="size-3 animate-spin" />
            {t('task.runCode.page.streaming')}
          </span>
        ) : null}
        <span className="shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
          {mode}
        </span>
        <button
          type="button"
          onClick={reload}
          disabled={!html || streaming}
          title={t('task.runCode.page.refresh')}
          aria-label={t('task.runCode.page.refresh')}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={openInNewTab}
          disabled={!html || streaming}
          title={t('task.runCode.page.openInNewTab')}
          aria-label={t('task.runCode.page.openInNewTab')}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ExternalLink className="size-3.5" />
        </button>
      </div>

      {streaming ? (
        <div className="h-0.5 w-full overflow-hidden bg-primary/10">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/70" />
        </div>
      ) : null}

      {mode === 'tsx' && streaming ? (
        <div
          className="flex items-center justify-center gap-2 text-xs text-muted-foreground"
          style={{ height: 180 }}
        >
          <Loader2 className="size-3.5 animate-spin" />
          {t('task.runCode.page.generating')}
        </div>
      ) : mode === 'tsx' && !compiledJs ? (
        <div
          className="flex items-center justify-center gap-2 text-xs text-muted-foreground"
          style={{ height: Math.max(160, visualHeight) }}
        >
          <Loader2 className="size-3.5 animate-spin" />
          {t('task.runCode.page.waitingCompiled')}
        </div>
      ) : mode === 'tsx' && tsxError ? (
        <div className="flex flex-col gap-1.5 p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
            <TriangleAlert className="size-3.5 shrink-0" />
            {t('task.runCode.page.compileFailed')}
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {tsxError}
          </pre>
        </div>
      ) : mode === 'tsx' && !tsxHtml ? (
        <div
          className="flex items-center justify-center gap-2 text-xs text-muted-foreground"
          style={{ height: Math.max(160, visualHeight) }}
        >
          <Loader2 className="size-3.5 animate-spin" />
          {t('task.runCode.page.compiling')}
        </div>
      ) : html ? (
        <div className="relative w-full overflow-hidden" style={{ height: visualHeight }}>
          <iframe
            ref={iframeRef}
            // 流式/完成态切换或手动刷新时强制重挂，确保 sandbox 权限与新脚本文档生效
            key={`${streaming ? 'stream' : 'final'}-${reloadSeq}`}
            title={title || t('task.runCode.page.untitled')}
            srcDoc={html}
            sandbox={streaming ? '' : SANDBOX_FINAL}
            referrerPolicy="no-referrer"
            className={cn('block border-0 bg-transparent')}
            style={{
              width: designWidth,
              height: logicalHeight,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          />
        </div>
      ) : (
        <div className="flex items-center justify-center text-xs text-muted-foreground" style={{ height: 160 }}>
          {t('task.runCode.page.empty')}
        </div>
      )}
    </div>
  );
}
