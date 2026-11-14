// render/code/FencePreview.tsx
// 代码围栏的「预览」视图：html → 沙箱 iframe（srcDoc）；md → MarkdownRenderer。
// 流式（streaming=true）时 iframe 以 400ms 节流刷新 srcDoc，避免每帧重载；
// Markdown 直接实时渲染（解析成本由消息区既有分块/节流承担）。
//
// 安全：iframe sandbox 与 HtmlPreview 保持一致（不含 allow-same-origin，不透明源）。
// 本组件只被 CodeBlock 的预览页签引用（default variant）。

import { useEffect, useRef, useState } from 'react';
import { MarkdownRenderer } from '../markdown/MarkdownRenderer';

export type FencePreviewKind = 'html' | 'markdown';

const HTML_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock';
/** 流式期间 iframe 重载节流间隔（毫秒） */
const STREAM_RELOAD_INTERVAL_MS = 400;

/**
 * 预览文档内注入的样式：隐藏浏览器原生滚动条（保留滚动能力），
 * 与宿主应用全局滚动条策略一致（global.css 同样隐藏滚动条），消除 iframe 默认白条。
 */
const PREVIEW_STYLE =
  '<style data-moss-preview>'
  + '* { scrollbar-width: none !important; -ms-overflow-style: none !important; }'
  + '*::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }'
  + '*::-webkit-scrollbar-track, *::-webkit-scrollbar-thumb { background: transparent; }'
  + '</style>';

/**
 * 把预览样式插到文档里：优先 <head> 之后，其次 <html> 之后，最后前置。
 * 注意不能插在 <!DOCTYPE> 之前（会触发怪异模式）。
 */
function injectPreviewStyle(html: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + PREVIEW_STYLE + html.slice(at);
  }
  const root = /<html(?:\s[^>]*)?>/i.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + PREVIEW_STYLE + html.slice(at);
  }
  return PREVIEW_STYLE + html;
}

export interface FencePreviewProps {
  kind: FencePreviewKind;
  code: string;
  /** 围栏是否仍在流式生成 */
  streaming: boolean;
}

/**
 * 节流值：leading 立即生效 + trailing 定时补齐最新值。
 * 定时器回调取 latestRef，避免闭包持有旧代码。
 */
function useThrottledValue(value: string, intervalMs: number): string {
  const [shown, setShown] = useState(value);
  const latestRef = useRef(value);
  latestRef.current = value;
  const lastAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (intervalMs <= 0) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setShown(value);
      return;
    }
    const wait = Math.max(0, intervalMs - (performance.now() - lastAtRef.current));
    if (wait === 0) {
      lastAtRef.current = performance.now();
      setShown(value);
      return;
    }
    if (timerRef.current !== null) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastAtRef.current = performance.now();
      setShown(latestRef.current);
    }, wait);
  }, [value, intervalMs]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  return shown;
}

function HtmlFrame({ code, streaming }: { code: string; streaming: boolean }) {
  const srcDoc = useThrottledValue(code, streaming ? STREAM_RELOAD_INTERVAL_MS : 0);
  return (
    <iframe
      title="html preview"
      srcDoc={injectPreviewStyle(srcDoc)}
      sandbox={HTML_SANDBOX}
      referrerPolicy="no-referrer"
      className="h-[420px] w-full border-0 bg-background"
    />
  );
}

export function FencePreview({ kind, code, streaming }: FencePreviewProps) {
  if (kind === 'markdown') {
    return (
      <div className="max-h-[420px] overflow-auto p-3">
        <MarkdownRenderer text={code} streaming={streaming} />
      </div>
    );
  }
  return <HtmlFrame code={code} streaming={streaming} />;
}
