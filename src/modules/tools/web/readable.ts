// tools/web/readable.ts
// 基于 cheerio 的正文可读性提取（fetch 模式与搜索结果正文增强共用）。
// 目标不是通用阅读器，而是把导航/广告/页脚/评论区剥掉，给 LLM 干净的正文。

import * as cheerio from 'cheerio';
import type { Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { decodeHtmlEntities, normalizeWhitespace } from './html-extract';
import { queryCoverage, queryTokens } from './search/clean';

const NOISE_CLASS_PATTERN = /\b(ad|ads|advert|banner|cookie|popup|modal|share|social|related|recommend|sidebar|nav|menu|comment|breadcrumb|toolbar|subscribe|newsletter)\b/i;

const BOILERPLATE_PATTERN = /^(版权声明|免责声明|相关阅读|相关推荐|热门推荐|猜你喜欢|上一篇|下一篇|返回顶部|登录|注册|扫码|关注我们|联系我们|广告|下载APP|更多精彩|点击查看更多)/;

const CONTAINER_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '.markdown-body',
  '.article-content',
  '.post-content',
  '.entry-content',
  '#content',
  '.content',
  '#article',
  '.article',
  '.post',
];

export interface ReadableResult {
  title: string | null;
  text: string;
  quality: 'high' | 'low';
  linkDensity: number;
  boilerplateRatio: number;
}

function toText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/(address|article|aside|blockquote|div|dl|dt|dd|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|td|th|ul)>/gi,
      '\n',
    );
  return normalizeWhitespace(decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, ' ')));
}

function linkDensityOf(element: Cheerio<AnyNode>, textLength: number): number {
  if (textLength <= 0) return 0;
  const linkChars = normalizeWhitespace(element.find('a').text()).length;
  return Math.min(1, linkChars / textLength);
}

function boilerplateRatioOf(text: string): number {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return 0;
  const noise = lines.filter((line) => BOILERPLATE_PATTERN.test(line) || line.length <= 3).length;
  return noise / lines.length;
}

function scoreContainer(element: Cheerio<AnyNode>): { score: number; text: string; linkDensity: number } {
  const rawHtml = element.html() ?? '';
  const text = toText(rawHtml);
  const linkDensity = linkDensityOf(element, text.length);
  const paragraphs = element.find('p, li').length;
  const punctuation = (text.match(/[。！？!?.]/g) ?? []).length;
  const score = text.length + paragraphs * 80 + punctuation * 10 - linkDensity * text.length * 2;
  return { score, text, linkDensity };
}

/** 正文可读性提取（失败时调用方回退到 html-extract） */
export function extractReadableText(html: string): ReadableResult {
  const $ = cheerio.load(html);
  const title = normalizeWhitespace($('title').first().text()) || null;

  $('script, style, noscript, template, iframe, svg, canvas, form, header, footer, nav, aside').remove();
  $('body *').each((_, node) => {
    const element = $(node);
    const identity = `${element.attr('class') ?? ''} ${element.attr('id') ?? ''}`;
    if (identity.trim() && NOISE_CLASS_PATTERN.test(identity)) {
      element.remove();
    }
  });

  let bestText = '';
  let bestLinkDensity = 0;
  let bestScore = 0;
  for (const selector of CONTAINER_SELECTORS) {
    const container = $(selector).first();
    if (container.length === 0) continue;
    const candidate = scoreContainer(container);
    if (candidate.text.length < 120) continue;
    if (candidate.score > bestScore) {
      bestScore = candidate.score;
      bestText = candidate.text;
      bestLinkDensity = candidate.linkDensity;
    }
  }

  if (!bestText) {
    const body = $('body');
    const root = body.length > 0 ? body : $.root();
    const candidate = scoreContainer(root);
    bestText = candidate.text;
    bestLinkDensity = candidate.linkDensity;
  }

  if (!bestText) {
    const description =
      normalizeWhitespace($('meta[name="description"]').attr('content') ?? '') ||
      normalizeWhitespace($('meta[property="og:description"]').attr('content') ?? '');
    bestText = normalizeWhitespace([title ?? '', description].filter(Boolean).join('\n\n'));
  }

  const boilerplateRatio = boilerplateRatioOf(bestText);
  const quality: 'high' | 'low' =
    bestText.length >= 300 && bestLinkDensity <= 0.55 && boilerplateRatio <= 0.4
      ? 'high'
      : 'low';

  return {
    title,
    text: bestText,
    quality,
    linkDensity: Math.round(bestLinkDensity * 1000) / 1000,
    boilerplateRatio: Math.round(boilerplateRatio * 1000) / 1000,
  };
}

/** 目标页是否为验证码/反爬挑战页（fetch 模式据此报 blocked，而不是把挑战页当正文） */
export function looksLikeChallengePage(html: string, status = 200): boolean {
  const normalized = html.toLowerCase();
  if (status === 429 || status === 503) return true;
  if (
    normalized.includes('wappass.baidu.com') ||
    normalized.includes('百度安全验证') ||
    normalized.includes('请输入验证码') ||
    normalized.includes('antispider') ||
    normalized.includes('cf-chl-') ||
    normalized.includes('/cdn-cgi/challenge-platform/') ||
    normalized.includes('just a moment...') ||
    normalized.includes('verify you are human')
  ) {
    return true;
  }
  const title = normalizeWhitespace(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').toLowerCase();
  return ['captcha', '验证码', '人机验证', '请验证', 'access denied', 'too many requests'].some((keyword) =>
    title.includes(keyword),
  );
}

/** 从正文中选出与查询最相关、且有上下文的摘录 */
export function selectExcerpt(content: string, query: string, maxChars: number): string {
  const tokens = queryTokens(query);
  const normalized = normalizeWhitespace(content);
  if (normalized.length <= maxChars) return normalized;

  const sentences = normalized
    .split(/(?:[。！？!?]+|\n{1,})/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12 && !BOILERPLATE_PATTERN.test(sentence));
  if (sentences.length === 0) return normalized.slice(0, maxChars);

  const scored = sentences.map((sentence, index) => ({
    sentence,
    index,
    score: queryCoverage(sentence, tokens) * 10 - index * 0.05,
  }));
  scored.sort((a, b) => b.score - a.score);

  const picked: Array<{ sentence: string; index: number }> = [];
  let length = 0;
  for (const item of scored) {
    if (length + item.sentence.length > maxChars) continue;
    picked.push(item);
    length += item.sentence.length;
    if (length >= maxChars * 0.85) break;
  }

  picked.sort((a, b) => a.index - b.index);
  const text = picked.map((item) => item.sentence).join('。');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
