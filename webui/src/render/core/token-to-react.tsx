// render/core/token-to-react.tsx
// markdown-it token → React 组件递归映射。
// 全树 React 元素，无 raw HTML 注入（html:false）；html_block/html_inline 防御性转义显示。
// fence→CodeBlock、math_*→MathSpan、file_ref→FilePreviewCard。

import { Fragment, type ReactNode } from 'react';
import { parseBlock, type Token, type InlineToken } from './markdown-it';
import { CodeBlock } from '../code/CodeBlock';
import { MathSpan } from '../math/MathSpan';
import { FilePreviewCard } from '../file/FilePreviewCard';
import { useRenderSettings } from './settings';

/** link/image 安全协议过滤：只放行 http(s)/mailto/锚点/相对路径 */
function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (/^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(trimmed)) return trimmed;
  return null;
}

function attrsToRecord(token: { attrs: ReadonlyArray<readonly [string, string | number]> | null }): Record<string, string> {
  const out: Record<string, string> = {};
  if (token.attrs) {
    for (const [k, v] of token.attrs) out[k] = String(v);
  }
  return out;
}

/** 渲染 inline token 数组（text/strong/em/code/link/image/math/file_ref/…） */
function renderInlineTokens(tokens: readonly InlineToken[], closed: boolean, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const stack: Array<{ type: string; children: ReactNode[]; attrs: Record<string, string> }> = [];

  const pushNode = (node: ReactNode): void => {
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else {
      out.push(node);
    }
  };

  tokens.forEach((token, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (token.type) {
      case 'text':
        pushNode(<Fragment key={key}>{token.content}</Fragment>);
        break;
      case 'softbreak':
        // breaks:true（md 单例）下单换行 → <br>
        pushNode(<br key={key} />);
        break;
      case 'hardbreak':
        pushNode(<br key={key} />);
        break;
      case 'code_inline':
        pushNode(<code key={key} className="md-code-inline">{token.content}</code>);
        break;
      case 'math_inline':
        pushNode(<MathSpan key={key} tex={token.content} display={false} closed={closed} />);
        break;
      case 'file_ref':
        pushNode(<FilePreviewCard key={key} path={token.content} />);
        break;
      case 'html_inline':
        // html:false 下不该出现；防御：原样文本
        pushNode(<Fragment key={key}>{token.content}</Fragment>);
        break;
      case 'link_open':
        stack.push({ type: 'a', children: [], attrs: attrsToRecord(token) });
        break;
      case 'link_close': {
        const frame = stack.pop();
        if (frame?.type === 'a') {
          const href = safeUrl(frame.attrs['href']);
          const node = href ? (
            <a key={key} href={href} target="_blank" rel="noopener noreferrer" title={frame.attrs['title']}>
              {frame.children}
            </a>
          ) : (
            <span key={key}>{frame.children}</span>
          );
          pushNode(node);
        }
        break;
      }
      case 'image': {
        const attrs = attrsToRecord(token);
        const src = safeUrl(attrs['src']);
        if (src) {
          pushNode(
            <img key={key} src={src} alt={token.content || attrs['alt'] || ''} className="md-img" loading="lazy" />,
          );
        } else {
          pushNode(<Fragment key={key}>{token.content}</Fragment>);
        }
        break;
      }
      default: {
        // 强调类 open/close 配对
        if (token.type.endsWith('_open')) {
          stack.push({ type: token.type, children: [], attrs: attrsToRecord(token) });
        } else if (token.type.endsWith('_close')) {
          const frame = stack.pop();
          if (!frame) break;
          const inner = <Fragment key={key}>{frame.children}</Fragment>;
          let node: ReactNode;
          switch (frame.type) {
            case 'strong_open':
              node = <strong key={key}>{inner}</strong>;
              break;
            case 'em_open':
              node = <em key={key}>{inner}</em>;
              break;
            case 's_open':
              node = <s key={key}>{inner}</s>;
              break;
            case 'del_open':
              node = <del key={key}>{inner}</del>;
              break;
            case 'sub_open':
              node = <sub key={key}>{inner}</sub>;
              break;
            case 'sup_open':
              node = <sup key={key}>{inner}</sup>;
              break;
            default:
              node = inner;
          }
          pushNode(node);
        }
      }
    }
  });

  // 未闭合的 open 帧（流式截断容错）：children 平铺输出，不丢内容
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    out.unshift(<Fragment key={`${keyPrefix}-unclosed-${frame.type}`}>{frame.children}</Fragment>);
  }
  return out;
}

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

/** 渲染 block token 流（在组件渲染上下文中调用，内部使用 settings hook） */
export function renderTokens(tokens: readonly Token[], closed: boolean): ReactNode {
  const settings = useRenderSettings();
  const out: ReactNode[] = [];
  const stack: Array<{ type: string; children: ReactNode[]; token: Token }> = [];

  const pushNode = (node: ReactNode): void => {
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else {
      out.push(node);
    }
  };

  tokens.forEach((token, i) => {
    const key = `b${i}`;

    // 内容型 block token（自闭合）
    switch (token.type) {
      case 'fence':
        pushNode(
          <CodeBlock
            key={key}
            code={token.content.replace(/\n$/, '')}
            lang={token.info.trim().split(/\s+/)[0] ?? ''}
            closed={closed}
          />,
        );
        return;
      case 'code_block':
        pushNode(<CodeBlock key={key} code={token.content.replace(/\n$/, '')} lang="" closed={closed} />);
        return;
      case 'math_block':
        pushNode(
          settings.mathEnabled ? (
            <MathSpan key={key} tex={token.content} display closed={closed} />
          ) : (
            <pre key={key} className="math-raw-block">{token.content}</pre>
          ),
        );
        return;
      case 'hr':
        pushNode(<hr key={key} className="md-hr" />);
        return;
      case 'html_block':
        // html:false 防御：原样文本
        pushNode(
          <pre key={key} className="md-html-raw overflow-x-auto font-mono text-xs text-muted-foreground">
            {token.content}
          </pre>,
        );
        return;
      default:
        break;
    }

    if (token.type.endsWith('_open')) {
      stack.push({ type: token.type, children: [], token });
      return;
    }
    if (token.type.endsWith('_close')) {
      const frame = stack.pop();
      if (!frame) return;
      const inner = <Fragment key={`${key}-inner`}>{frame.children}</Fragment>;
      const frameAttrs = attrsToRecord(frame.token); // 属性挂在 open token 上
      let node: ReactNode;
      switch (frame.type) {
        case 'heading_open': {
          const tag = HEADING_TAGS[Number(frame.token.tag?.[1] ?? '2') - 1] ?? 'h2';
          node = (
            <div key={key} className={`md-heading md-heading-${tag}`} data-tag={tag}>
              {inner}
            </div>
          );
          break;
        }
        case 'paragraph_open':
          node = <p key={key} className="md-p">{inner}</p>;
          break;
        case 'blockquote_open':
          node = <blockquote key={key} className="md-blockquote">{inner}</blockquote>;
          break;
        case 'bullet_list_open':
          node = <ul key={key} className="md-ul">{inner}</ul>;
          break;
        case 'ordered_list_open':
          node = (
            <ol key={key} className="md-ol" start={Number(frameAttrs['start'] ?? 1) || 1}>
              {inner}
            </ol>
          );
          break;
        case 'list_item_open':
          node = <li key={key} className="md-li">{inner}</li>;
          break;
        case 'table_open':
          node = (
            <div key={key} className="md-table-wrap">
              <table className="md-table">{inner}</table>
            </div>
          );
          break;
        case 'thead_open':
          node = <thead key={key}>{inner}</thead>;
          break;
        case 'tbody_open':
          node = <tbody key={key}>{inner}</tbody>;
          break;
        case 'tr_open':
          node = <tr key={key}>{inner}</tr>;
          break;
        case 'th_open':
          node = <th key={key}>{inner}</th>;
          break;
        case 'td_open':
          node = <td key={key}>{inner}</td>;
          break;
        default:
          node = inner;
      }
      pushNode(node);
      return;
    }

    // inline token（位于 open 帧内）：渲染 children
    if (token.type === 'inline' && token.children) {
      pushNode(<Fragment key={`${key}-inline`}>{renderInlineTokens(token.children, closed, key)}</Fragment>);
    }
  });

  // 流式截断容错：未闭合帧平铺
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    out.unshift(<Fragment key={`unclosed-${frame.type}-${out.length}`}>{frame.children}</Fragment>);
  }

  return <>{out}</>;
}

/** 解析并渲染一个块 */
export function renderBlockToReact(raw: string, closed: boolean): ReactNode {
  return renderTokens(parseBlock(raw), closed);
}
