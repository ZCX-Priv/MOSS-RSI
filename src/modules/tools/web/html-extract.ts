// tools/web/html-extract.ts
// HTML → 可见文本/标题/链接 提取（纯函数无依赖）。
// 设计要点：
//   - 剥离 script/style 等隐藏元素用扫描而非正则：嵌套量词正则在 2MB 畸形页面上
//     会灾难性回溯（实测 14 秒卡死），扫描式保证线性。
//   - 实体解码带 codePoint 边界校验：远程页面可以写出代理区/超界码点，
//     String.fromCodePoint 会抛错或产生坏字符。
//   - ASCII-only 小写化：Unicode toLowerCase 可能改变字符串长度（İ → i̇），
//     索引漂移会把 script 内容泄漏进可见文本。

/** HTML 提取结果 */
export interface HtmlExtractionResult {
  title: string | null;
  text: string;
}

/** 页内链接（绝对化、去重、文档序） */
export interface ExtractedLink {
  text: string;
  url: string;
}

/** 最多提取的链接数 */
const MAX_LINKS = 20;

/**
 * ASCII-only 小写化。Unicode toLowerCase 可能改变字符串长度（单个 İ 变两个字符），
 * 而这些索引用于切片原文，长度漂移会把隐藏 script 内容泄漏进可见文本。
 */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

/** 从 from 起找下一个真正的 `<tag` 起点（跳过属性值内的文本，如 title="a<b"） */
function findTagStart(haystack: string, tag: string, from: number): number {
  const open = `<${tag}`;
  let index = from;
  let inTag = false;
  let quote = '';

  while (index < haystack.length) {
    const char = haystack[index];
    if (quote) {
      if (char === quote) {
        quote = '';
      }
      index++;
      continue;
    }
    if (inTag) {
      if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        inTag = false;
      }
      index++;
      continue;
    }
    if (char === '<') {
      if (haystack.startsWith(open, index)) {
        // `<scriptx>` 不是 `<script>`：要求边界字符是空白、`/` 或 `>`
        const boundary = haystack[index + open.length];
        if (boundary === undefined || /[\s/>]/.test(boundary)) {
          return index;
        }
      }
      inTag = true;
      index++;
      continue;
    }
    index++;
  }
  return -1;
}

/**
 * 剥离 `<tag>...</tag>` 整段（扫描式，非正则）。
 * 未闭合时剩余文档整体归属该元素（防止 script 无闭合时泄漏后续内容）。
 */
export function stripElement(html: string, tag: string): string {
  const close = `</${tag}>`;
  const haystack = asciiLower(html);
  let out = '';
  let cursor = 0;

  for (;;) {
    const start = findTagStart(haystack, tag, cursor);
    if (start === -1) {
      return out + html.slice(cursor);
    }
    out += `${html.slice(cursor, start)} `;
    const end = haystack.indexOf(close, start);
    if (end === -1) {
      // 未闭合：剩余文档都属于该元素
      return out;
    }
    cursor = end + close.length;
  }
}

/** 剥离 HTML 注释（未闭合时剩余文档整体视为注释） */
function stripComments(html: string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const start = html.indexOf('<!--', cursor);
    if (start === -1) {
      return out + html.slice(cursor);
    }
    out += `${html.slice(cursor, start)} `;
    const end = html.indexOf('-->', start + 4);
    if (end === -1) {
      return out;
    }
    cursor = end + 3;
  }
}

/**
 * 提取 HTML 可见文本：剥离 head/script/style/noscript/template 与注释，
 * 块级标签转换行，剩余标签替换为空格，解码实体并归一化空白。
 */
export function extractVisibleTextFromHtml(html: string): HtmlExtractionResult {
  const title = extractTitle(html);
  let withoutHidden = html;
  for (const tag of ['head', 'script', 'style', 'noscript', 'template']) {
    withoutHidden = stripElement(withoutHidden, tag);
  }
  withoutHidden = stripComments(withoutHidden);

  // <br> 换行；块级元素闭合换行（保证段落结构不塌缩成一行）
  const withBreaks = withoutHidden
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/(address|article|aside|blockquote|div|dl|dt|dd|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|td|th|ul)>/gi,
      '\n',
    );

  const withoutTags = withBreaks.replace(/<[^>]+>/g, ' ');
  const decoded = decodeHtmlEntities(withoutTags);
  const text = normalizeWhitespace(decoded);

  return {
    title,
    text,
  };
}

/** 提取 <title> 文本（实体解码 + 空白归一化后为空则 null） */
export function extractTitle(html: string): string | null {
  const matched = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!matched) {
    return null;
  }
  const decoded = decodeHtmlEntities(matched[1]);
  const normalized = normalizeWhitespace(decoded);
  return normalized || null;
}

/** 远程页面可以命名、但 JS 无法构造的码点（代理区/超界）返回 null */
function safeFromCodePoint(codePoint: number): string | null {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return null;
  }
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
    return null;
  }
  return String.fromCodePoint(codePoint);
}

/**
 * HTML 实体解码：支持命名（amp/lt/gt/quot/apos/nbsp）、十进制 `&#123;`、
 * 十六进制 `&#x1f600;`。非法/越界实体原样保留。
 */
export function decodeHtmlEntities(text: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };

  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, entity: string) => {
    const lower = entity.toLowerCase();

    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return safeFromCodePoint(code) ?? full;
    }

    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return safeFromCodePoint(code) ?? full;
    }

    return namedEntities[lower] ?? full;
  });
}

/** 空白归一化：\r → \n、连续空白折叠、行首尾空白去除、3+ 换行压成 2 */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 提取页内 <a href> 链接：解析 <base href> 决定相对链接基准（而非当前落地 URL），
 * 绝对化 + 去重 + 跳过锚点/javascript:/mailto:/tel:，最多 MAX_LINKS 条。
 */
export function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const baseTag =
    /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(html);
  let resolvedBase = baseUrl;
  if (baseTag) {
    try {
      const href = baseTag[1] ?? baseTag[2] ?? baseTag[3] ?? '';
      resolvedBase = new URL(decodeHtmlEntities(href), baseUrl).toString();
    } catch {
      // base href 无效时保持响应 URL 作为基准
    }
  }
  const seen = new Set<string>();
  const anchor =
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null && links.length < MAX_LINKS) {
    const href = decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? '');
    if (/^(#|javascript:|mailto:|tel:)/i.test(href)) {
      continue;
    }
    let absolute: string;
    try {
      absolute = new URL(href, resolvedBase).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(absolute) || seen.has(absolute)) {
      continue;
    }
    const text = normalizeWhitespace(
      decodeHtmlEntities((match[4] ?? '').replace(/<[^>]+>/g, ' ')),
    )
      .trim()
      .slice(0, 100);
    if (!text) {
      continue;
    }
    seen.add(absolute);
    links.push({ text, url: absolute });
  }
  return links;
}
