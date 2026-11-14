// render/code/CodeBlock.tsx
// 代码块组件：流式中（closed=false）按 300ms 节流持续 Shiki 高亮，闭合后补一次终态高亮
// （闭块 memo 冻结，后续流式 token 不会重触发高亮）。
// html/md 围栏提供「预览 / 代码」胶囊（位于复制按钮左侧，默认代码）。
// mermaid 语言分流到 MermaidDiagram；smiles 分流到 SmilesDiagram。
// 未知语言 / 高亮引擎失败 / 超大代码回退纯文本 pre。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { capHighlightCode, getCachedHighlight, highlightCodePrefix } from './shiki';
import { MermaidDiagram } from '../diagram/MermaidDiagram';
import { SmilesDiagram } from '../chem/SmilesDiagram';
import { FencePreview, type FencePreviewKind } from './FencePreview';
import { PreviewModeToggle, type PreviewMode } from '../core/PreviewModeToggle';
import { useRenderSettings } from '../core/settings';
import { copyText } from '../../lib/clipboard';

export interface CodeBlockProps {
  code: string;
  /** fence info string（语言标识，可能为空） */
  lang: string;
  /** 所在块是否闭合（流式） */
  closed: boolean;
  /** default = Markdown 代码块；inline = 工具步骤内的紧凑代码（无外框） */
  variant?: 'default' | 'inline';
}

/** 直接渲染上限（行）：超过先只显示前 N 行（完整内容仍可通过复制获取） */
const MAX_DISPLAY_LINES = 1_500;
/** 流式高亮节流间隔（毫秒） */
const STREAM_HIGHLIGHT_INTERVAL_MS = 300;
/** 高亮失败重试：最多次数 + 退避基数（毫秒） */
const HIGHLIGHT_RETRY_MAX = 2;
const HIGHLIGHT_RETRY_BASE_MS = 800;
/** 代码卡内部「贴底」判定阈值（px）：与底部距离小于该值才算跟随最新代码 */
const BODY_STICK_PX = 8;

/** 带预览能力的围栏语言 */
const HTML_PREVIEW_LANGS = new Set(['html', 'htm', 'xhtml']);
const MARKDOWN_PREVIEW_LANGS = new Set(['md', 'markdown']);

function fencePreviewKindOf(lang: string): FencePreviewKind | null {
  if (HTML_PREVIEW_LANGS.has(lang)) return 'html';
  if (MARKDOWN_PREVIEW_LANGS.has(lang)) return 'markdown';
  return null;
}

function exceedsLineLimit(code: string, limit: number): boolean {
  let count = 0;
  let idx = -1;
  while ((idx = code.indexOf('\n', idx + 1)) !== -1) {
    if (++count > limit) return true;
  }
  return false;
}

/** 流式光标（与纯文本路径同一套样式类） */
const STREAM_CURSOR_HTML =
  '<span class="code-cursor ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] animate-pulse bg-primary-strong"></span>';

/**
 * 把「尚未高亮的流式尾部 + 光标」拼进 Shiki 输出的 </code></pre> 之前。
 * 高亮结果滞后于最新代码时，尾部以纯文本补齐，保证内容只增不减（不会先消失再出现）。
 */
function appendStreamTail(html: string, tail: string, showCursor: boolean): string {
  if (tail === '' && !showCursor) return html;
  const at = html.lastIndexOf('</code></pre>');
  if (at === -1) return html;
  const escaped = tail.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return html.slice(0, at) + escaped + (showCursor ? STREAM_CURSOR_HTML : '') + html.slice(at);
}

export function CodeBlock({ code, lang, closed, variant = 'default' }: CodeBlockProps) {
  const settings = useRenderSettings();
  const normalizedLang = lang.trim().toLowerCase();
  // 图表类围栏不做代码高亮（闭合后直接成图，流式中显示源码）
  const isDiagramLang =
    normalizedLang === 'mermaid' || normalizedLang === 'smiles' || normalizedLang === 'smi';
  const [highlight, setHighlight] = useState<{ code: string; lang: string; html: string } | null>(() => {
    const cached = getCachedHighlight(code, normalizedLang);
    return cached !== null ? { code: cached.code, lang: normalizedLang, html: cached.html } : null;
  });
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<PreviewMode>('code');
  const bodyRef = useRef<HTMLElement | null>(null);
  /** 是否跟随最新代码：由「距底几何距离」派生，用户上滑/滚轮向上立即置 false */
  const followBottomRef = useRef(true);
  /** 用户当前阅读位置（纯文本 ↔ 高亮元素切换时恢复，避免阅读位置被重置） */
  const bodyScrollTopRef = useRef(0);
  const lastHighlightAtRef = useRef(0);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 同一时刻只允许一个高亮请求在途（慢语言/大文件时避免请求堆满 Worker 队列） */
  const inFlightRef = useRef(false);
  /** 失败重试计数与定时器 */
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAttemptCodeRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  /** 高亮完成/需要续排时自增，驱动 effect 重新评估（不依赖 code 再次变化） */
  const [syncTick, setSyncTick] = useState(0);

  // 卸载：停止重试定时器并标记已卸载（在途结果到达后不再写 state）
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);

  // 高亮调度：闭合后立即补一次终态；流式中按 300ms 节流（每次请求最新代码）。
  // 单在途：完成回调自增 syncTick 续排；失败按指数退避重试，避免一次瞬时故障永久纯文本。
  useEffect(() => {
    if (!settings.codeHighlightEnabled || !normalizedLang || isDiagramLang) return;
    // 对齐目标 = 实际应高亮的前缀（大文件只高亮前 MAX_HIGHLIGHT_CHARS）
    const target = capHighlightCode(code);
    if (highlight && highlight.lang === normalizedLang && highlight.code === target) return; // 已对齐
    if (inFlightRef.current) return; // 在途：完成回调会自增 syncTick 续排

    // 代码变化视为新一轮尝试，重置重试计数
    if (lastAttemptCodeRef.current !== target) {
      lastAttemptCodeRef.current = target;
      retryCountRef.current = 0;
    }

    const interval = closed ? 0 : STREAM_HIGHLIGHT_INTERVAL_MS;
    const wait = Math.max(0, interval - (performance.now() - lastHighlightAtRef.current));
    const requestCode = code;
    const requestLang = normalizedLang;

    const run = () => {
      highlightTimerRef.current = null;
      inFlightRef.current = true;
      lastHighlightAtRef.current = performance.now();
      void (async () => {
        let result: { html: string; code: string } | null = null;
        try {
          result = await highlightCodePrefix(requestCode, requestLang, { cache: closed });
        } catch {
          result = null;
        }
        inFlightRef.current = false;
        if (!mountedRef.current) return;
        if (result !== null) {
          retryCountRef.current = 0;
          setHighlight((prev) => {
            // 单调前进：拒绝更短的旧结果；非前缀（内容被替换）则接受
            if (
              prev &&
              prev.lang === requestLang &&
              result.code.startsWith(prev.code) &&
              prev.code.length >= result.code.length
            ) {
              return prev;
            }
            return { code: result.code, lang: requestLang, html: result.html };
          });
          // 请求期间代码可能继续增长：立刻续排一次（已对齐时上面的 guard 会直接返回）
          setSyncTick((v) => v + 1);
          return;
        }
        // 失败重试（指数退避，最多 HIGHLIGHT_RETRY_MAX 次）
        if (retryCountRef.current >= HIGHLIGHT_RETRY_MAX) return;
        retryCountRef.current += 1;
        if (retryTimerRef.current !== null) return;
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          if (mountedRef.current) setSyncTick((v) => v + 1);
        }, HIGHLIGHT_RETRY_BASE_MS * retryCountRef.current);
      })();
    };

    if (wait === 0) run();
    else highlightTimerRef.current = setTimeout(run, wait);

    return () => {
      if (highlightTimerRef.current !== null) {
        clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
    };
  }, [code, normalizedLang, closed, settings.codeHighlightEnabled, isDiagramLang, highlight, syncTick]);

  // 高亮前缀 + 纯文本尾部：高亮结果可能滞后于最新代码，或只覆盖前 64k。
  // 两者都拼成完整内容，避免「高亮 → 纯文本」闪烁或内容消失。
  const highlightPrefix = useMemo(
    () =>
      !isDiagramLang &&
      settings.codeHighlightEnabled &&
      highlight !== null &&
      highlight.lang === normalizedLang &&
      code.startsWith(highlight.code)
        ? highlight
        : null,
    [code, highlight, normalizedLang, isDiagramLang, settings.codeHighlightEnabled],
  );
  const activeHtml = useMemo(
    () =>
      highlightPrefix
        ? appendStreamTail(highlightPrefix.html, code.slice(highlightPrefix.code.length), !closed)
        : null,
    [highlightPrefix, code, closed],
  );

  // 流式期间跟随内容增长（代码卡片有 max-h，外层滚动不会跟进来）。
  // 是否跟随由用户实际位置决定：一上滑就停；元素在「纯文本 ↔ 高亮」间切换时恢复阅读位置。
  useLayoutEffect(() => {
    if (closed) return;
    const el = bodyRef.current;
    if (!el) return;
    if (followBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      bodyScrollTopRef.current = el.scrollTop;
      return;
    }
    // 新元素（纯文本 pre ↔ Shiki div）从头开始：恢复用户原来的阅读位置
    if (el.scrollTop === 0 && bodyScrollTopRef.current > 0) el.scrollTop = bodyScrollTopRef.current;
  }, [code, activeHtml, closed]);

  const attachBody = useCallback((el: HTMLElement | null) => {
    bodyRef.current = el;
  }, []);
  /** 几何派生跟随态：距底 ≤ 8px 才算「在底部」，任何上滑都会让跟随停止 */
  const handleBodyScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    bodyScrollTopRef.current = el.scrollTop;
    followBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BODY_STICK_PX;
  }, []);
  /** 滚轮向上立即脱跟（不等 scroll 事件，避免与同一帧的贴底更新竞态） */
  const handleBodyWheel = useCallback((e: ReactWheelEvent<HTMLElement>) => {
    if (e.deltaY >= 0) return;
    const el = bodyRef.current;
    // 卡片本身不可滚动时，滚轮作用于外层消息列表，不能停掉卡片跟随
    if (!el || el.scrollHeight <= el.clientHeight) return;
    followBottomRef.current = false;
  }, []);
  const handleBodyTouchMove = useCallback(() => {
    const el = bodyRef.current;
    // 同滚轮：卡片不可滚动时手势作用于外层消息列表
    if (!el || el.scrollHeight <= el.clientHeight) return;
    followBottomRef.current = false;
  }, []);

  const html = activeHtml;
  // 行数超限：只渲染前 N 行（完整内容仍可通过复制按钮获取），避免超长代码生成巨型 DOM
  const lineOverflow = useMemo(() => exceedsLineLimit(code, MAX_DISPLAY_LINES), [code]);
  const displayCode = useMemo(
    () => (lineOverflow ? code.split('\n').slice(0, MAX_DISPLAY_LINES).join('\n') : code),
    [code, lineOverflow],
  );

  // mermaid 分流（仅在块闭合后成图，流式中显示源码 —— 无闪烁）
  if (normalizedLang === 'mermaid' && closed && settings.mermaidEnabled) {
    return <MermaidDiagram code={code} />;
  }

  // SMILES 分流（有机分子 2D 结构图：苯环/杂环等；闭合后成图，流式中显示源码）
  if ((normalizedLang === 'smiles' || normalizedLang === 'smi') && closed) {
    return <SmilesDiagram smiles={code} />;
  }

  const previewKind = variant === 'default' ? fencePreviewKindOf(normalizedLang) : null;
  const showPreview = previewKind !== null && mode === 'preview';

  const handleCopy = async () => {
    // copyText 内部已做 execCommand 兜底（非安全上下文同样可用）
    if (await copyText(code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div
      className={cn(
        'code-block group/code relative overflow-hidden rounded-md bg-muted/40',
        variant === 'inline' ? 'my-1' : 'my-3 border border-border',
      )}
    >
      <div
        className={cn(
          'flex items-center justify-between gap-2 px-3 py-1.5',
          variant === 'inline' ? 'border-b border-border/50' : 'border-b border-border/60',
        )}
      >
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {normalizedLang || 'text'}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {previewKind !== null && <PreviewModeToggle compact mode={mode} onChange={setMode} />}
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-70 transition-opacity hover:bg-muted hover:opacity-100"
            aria-label="copy code"
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </button>
        </div>
      </div>
      {previewKind !== null && mode === 'preview' ? (
        <FencePreview kind={previewKind} code={code} streaming={!closed} />
      ) : html !== null ? (
        <div
          ref={attachBody}
          onScroll={handleBodyScroll}
          onWheel={handleBodyWheel}
          onTouchMove={handleBodyTouchMove}
          className={cn(
            'shiki-wrap p-3 leading-relaxed',
            variant === 'inline' ? 'max-h-[360px] overflow-auto text-[12px]' : 'max-h-[420px] overflow-auto text-[13px]',
          )}
          // Shiki 输出为受控 HTML（只含 span 着色节点）
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre
          ref={attachBody}
          onScroll={handleBodyScroll}
          onWheel={handleBodyWheel}
          onTouchMove={handleBodyTouchMove}
          className={cn(
            'p-3 font-mono leading-relaxed text-foreground',
            variant === 'inline' ? 'max-h-[360px] overflow-auto text-[12px]' : 'max-h-[420px] overflow-auto text-[13px]',
          )}
        >
          <code>{displayCode}</code>
          {!closed && (
            <span className="code-cursor ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] animate-pulse bg-primary-strong" />
          )}
        </pre>
      )}
      {!showPreview && lineOverflow && (
        <div className="border-t border-border/60 px-3 py-1 text-[11px] text-muted-foreground">
          仅显示前 {MAX_DISPLAY_LINES} 行 · 复制按钮可获取完整代码
        </div>
      )}
    </div>
  );
}
