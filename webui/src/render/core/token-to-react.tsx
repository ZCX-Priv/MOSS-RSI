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
import { useStore } from '../../store';
import { useOpenFilePreview } from '../../hooks/useOpenFilePreview';

/** link/image 安全协议过滤：只放行 http(s)/mailto/锚点/相对路径 */
function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (/^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(trimmed)) return trimmed;
  return null;
}

/** 文件扩展名形态（裸相对路径判定用，避免把普通文本链接误判为文件） */
const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;
/** 协议/scheme 前缀（http:、mailto:、C: 等；用于排除非相对路径） */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** 归一化绝对路径分隔符为 '/'（Windows 展示与后端均接受正斜杠） */
function normalizeAbs(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * 链接是否形如文件引用（与 cwd 无关的形态判定）：
 * file:///、盘符绝对（C:\ 或 C:/）、/根相对、./ ../ 相对、含路径分隔符且带扩展名的裸相对。
 */
export function isFileLikeHref(href: string): boolean {
  if (!href) return false;
  const raw = href.trim();
  if (/^file:\/\//i.test(raw)) return true;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return true;
  if (raw.startsWith('./') || raw.startsWith('../')) return true;
  if (raw.startsWith('/')) return !raw.startsWith('//'); // 排除协议相对 //host
  if (raw.includes('/') || raw.includes('\\')) {
    return !SCHEME_RE.test(raw) && FILE_EXT_RE.test(raw);
  }
  return false;
}

/**
 * 解析文件引用 href → 可预览的绝对路径（相对路径基于 cwd）；非文件/无法解析返回 null。
 */
export function resolveFileHref(href: string, cwd: string): string | null {
  if (!isFileLikeHref(href)) return null;
  let raw = href.trim();
  if (/^file:\/\//i.test(raw)) {
    raw = raw.replace(/^file:\/\//i, '');
    // Windows file URL：file:///C:/a/b.ts 去掉后为 /C:/a/b.ts → 去除盘符前的多余前导斜杠
    raw = raw.replace(/^\/([A-Za-z]:[\\/])/, '$1');
  }
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // 非法编码保留原样
  }
  if (raw === '') return null;

  // 盘符绝对：C:/a/b.ts 或 C:\a\b.ts
  if (/^[A-Za-z]:[\\/]/.test(raw)) return normalizeAbs(raw);

  const base = cwd && cwd !== '__system__' ? normalizeAbs(cwd) : '';
  if (base === '') return null; // 无基准无法解析相对路径

  // 根相对：以 cwd 所在盘符（如 C:/）为根
  if (raw.startsWith('/')) {
    const drive = /^([A-Za-z]:)\//.exec(base);
    return drive ? normalizeAbs(`${drive[1]}${raw}`) : null;
  }

  // ./ ../ 与裸相对：拆段求解并处理 .. 上跳
  const segs = base.split('/').filter(s => s !== '');
  for (const part of raw.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      segs.pop();
      continue;
    }
    segs.push(part);
  }
  return segs.join('/');
}

/**
 * 文件引用链接组件：点击拦截为「侧边栏/弹层预览」（不跳转、不新开标签页）。
 * 相对路径解析依赖当前工作目录；无法解析时退化为不可点文本。
 */
function MarkdownFileLink({ href, title, children }: { href: string; title?: string; children: ReactNode }) {
  const cwd = useStore(s => s.workingDirectory);
  const sessionId = useStore(s => s.activeTaskId) ?? '';
  const openPreview = useOpenFilePreview();
  const abs = resolveFileHref(href, cwd);
  if (!abs) return <span>{children}</span>;
  return (
    <a
      href={href}
      title={title}
      className="md-link"
      onClick={e => {
        e.preventDefault();
        e.stopPropagation();
        openPreview(sessionId, abs);
      }}
    >
      {children}
    </a>
  );
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
          const rawHref = frame.attrs['href'] ?? '';
          const title = frame.attrs['title'];
          let node: ReactNode;
          if (isFileLikeHref(rawHref)) {
            // 文件引用：拦截点击 → 侧边栏/弹层预览（不新开标签页、不触发路由跳转）
            node = (
              <MarkdownFileLink key={key} href={rawHref} title={title}>
                {frame.children}
              </MarkdownFileLink>
            );
          } else {
            const href = safeUrl(rawHref);
            node = href ? (
              <a key={key} href={href} target="_blank" rel="noopener noreferrer" title={title}>
                {frame.children}
              </a>
            ) : (
              <span key={key}>{frame.children}</span>
            );
          }
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
