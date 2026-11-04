// render/code/CodeBlock.tsx
// 代码块组件：流式中（closed=false）纯文本 mono 显示；闭合后 Shiki 高亮一次（闭块 memo 冻结，
// 后续流式 token 不会重触发高亮）。mermaid 语言分流到 MermaidDiagram；smiles 分流到 SmilesDiagram。
// 未知语言 / 高亮引擎失败回退纯文本 pre。

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getCachedHighlight, highlightCode } from './shiki';
import { MermaidDiagram } from '../diagram/MermaidDiagram';
import { SmilesDiagram } from '../chem/SmilesDiagram';
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

/** 高亮上限（字符）：超过不再生成逐 token span（数万节点会拖垮弱机浏览器） */
const MAX_HIGHLIGHT_CHARS = 24_000;
/** 直接渲染上限（行）：超过先只显示前 N 行，点击「显示全部」再展开 */
const MAX_DISPLAY_LINES = 1_500;

function exceedsLineLimit(code: string, limit: number): boolean {
  let count = 0;
  let idx = -1;
  while ((idx = code.indexOf('\n', idx + 1)) !== -1) {
    if (++count > limit) return true;
  }
  return false;
}

export function CodeBlock({ code, lang, closed, variant = 'default' }: CodeBlockProps) {
  const settings = useRenderSettings();
  const normalizedLang = lang.trim().toLowerCase();
  const tooLarge = code.length > MAX_HIGHLIGHT_CHARS;
  const [highlight, setHighlight] = useState<{ code: string; lang: string; html: string } | null>(() => {
    if (tooLarge) return null;
    const cached = getCachedHighlight(code, normalizedLang);
    return cached !== null ? { code, lang: normalizedLang, html: cached } : null;
  });
  const [copied, setCopied] = useState(false);
  // 仅当缓存/已算结果与当前 code/lang 完全一致时才算命中终态
  const cachedHtml =
    highlight && highlight.code === code && highlight.lang === normalizedLang ? highlight.html : null;

  useEffect(() => {
    if (!closed || !settings.codeHighlightEnabled || !normalizedLang) return;
    if (tooLarge) return; // 超大代码只显示纯文本，避免生成数万 span
    if (cachedHtml !== null) return; // 缓存命中：首帧即终态，无需再高亮
    let cancelled = false;
    void highlightCode(code, normalizedLang).then((result) => {
      if (!cancelled && result) setHighlight({ code, lang: normalizedLang, html: result });
    });
    return () => {
      cancelled = true;
    };
  }, [code, normalizedLang, closed, settings.codeHighlightEnabled, cachedHtml]);

  const html = cachedHtml;
  // 行数超限：只渲染前 N 行（完整内容仍可通过复制按钮获取），避免超长代码生成巨型 DOM
  const lineOverflow = exceedsLineLimit(code, MAX_DISPLAY_LINES);
  const displayCode = lineOverflow
    ? code.split('\n').slice(0, MAX_DISPLAY_LINES).join('\n')
    : code;

  // mermaid 分流（仅在块闭合后成图，流式中显示源码 —— 无闪烁）
  if (normalizedLang === 'mermaid' && closed && settings.mermaidEnabled) {
    return <MermaidDiagram code={code} />;
  }

  // SMILES 分流（有机分子 2D 结构图：苯环/杂环等；闭合后成图，流式中显示源码）
  if ((normalizedLang === 'smiles' || normalizedLang === 'smi') && closed) {
    return <SmilesDiagram smiles={code} />;
  }

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
          'flex items-center justify-between px-3 py-1.5',
          variant === 'inline' ? 'border-b border-border/50' : 'border-b border-border/60',
        )}
      >
        <span className="font-mono text-[11px] text-muted-foreground">{normalizedLang || 'text'}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-70 transition-opacity hover:bg-muted hover:opacity-100"
          aria-label="copy code"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
      </div>
      {html !== null ? (
        <div
          className={cn(
            'shiki-wrap p-3 leading-relaxed',
            variant === 'inline' ? 'max-h-[360px] overflow-auto text-[12px]' : 'max-h-[420px] overflow-auto text-[13px]',
          )}
          // Shiki 输出为受控 HTML（只含 span 着色节点）
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre
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
      {lineOverflow && (
        <div className="border-t border-border/60 px-3 py-1 text-[11px] text-muted-foreground">
          仅显示前 {MAX_DISPLAY_LINES} 行 · 复制按钮可获取完整代码
        </div>
      )}
    </div>
  );
}
