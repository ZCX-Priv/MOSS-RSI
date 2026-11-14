// render/code/shiki.ts
// Shiki 高亮引擎：
//   ① 首选 Worker（highlight.worker.ts）——语法分析/HTML 生成移出主线程；
//   ② Worker 不可用/崩溃/超时 → 主线程引擎兜底（超 100k 字符直接放弃，避免冻结主线程）；
//   ③ 双主题（catppuccin-latte/catppuccin-mocha）以 defaultColor:false 输出纯 CSS vars，
//      亮暗切换由 CSS 完成，零重渲。
//
// 健壮性约定：
//   - 任何高亮失败只返回 null（调用方回退纯文本），不抛异常；
//   - 引擎 promise 失败后清空缓存，可在下一次请求重建（一次失败不会导致永久无高亮）；
//   - 围栏高亮永不整块放弃：超过 MAX_HIGHLIGHT_CHARS 时高亮前缀，剩余部分由调用方以纯文本尾部拼接。

import type { Highlighter } from 'shiki';
import { LANG_ALIAS, resolveShikiLang } from './lang-alias';

/** 围栏前缀高亮上限（字符）：超出部分由调用方以纯文本尾部展示，不再整块丢弃高亮 */
export const MAX_HIGHLIGHT_CHARS = 64_000;
/** 主线程兜底引擎的输入上限（字符）：Worker 失效时避免把主线程冻结数秒 */
const MAIN_THREAD_MAX_CHARS = 100_000;
/** Worker 输入硬上限（字符）：超大文件（>400k）直接放弃高亮，避免单个请求长期占满 Worker 队列 */
const WORKER_MAX_CHARS = 400_000;
/** Worker 单次请求超时（ms）：超时按失败处理并回退主线程 */
const HIGHLIGHT_TIMEOUT_MS = 15_000;

/** 文件名（无扩展名 / 特殊文件名）→ Shiki 语言 id */
const FILENAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'make',
  'cmakelists.txt': 'cmake',
  '.gitignore': 'gitignore',
  '.gitattributes': 'gitignore',
  '.editorconfig': 'ini',
  '.env': 'dotenv',
};

// ============================================================================
// Worker 客户端
// ============================================================================

/** 高亮 Worker 返回的语言不受支持（不需要回退主线程重试） */
class HighlightUnsupportedError extends Error {}

interface PendingHighlight {
  resolve: (html: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
/** Worker 崩溃/创建失败后永久走主线程（避免每次请求都尝试重建一个坏 Worker） */
let workerBroken = false;
let requestSeq = 0;
const pendingHighlights = new Map<number, PendingHighlight>();

interface WorkerReply {
  id: number;
  ok: boolean;
  html?: string;
  unsupported?: boolean;
  error?: string;
}

function failWorker(): void {
  workerBroken = true;
  const w = worker;
  worker = null;
  try {
    w?.terminate();
  } catch {
    // 终止失败无所谓：后续请求直接走主线程
  }
  for (const entry of pendingHighlights.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error('highlight worker crashed'));
  }
  pendingHighlights.clear();
}

function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  if (typeof Worker === 'undefined') {
    workerBroken = true;
    return null;
  }
  try {
    const created = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
    created.onmessage = (e: MessageEvent<WorkerReply>) => {
      const msg = e.data;
      if (!msg || typeof msg.id !== 'number') return;
      const entry = pendingHighlights.get(msg.id);
      if (!entry) return;
      pendingHighlights.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok && typeof msg.html === 'string') {
        entry.resolve(msg.html);
      } else if (msg.unsupported === true) {
        entry.reject(new HighlightUnsupportedError('unsupported language'));
      } else {
        entry.reject(new Error(msg.error ?? 'highlight failed'));
      }
    };
    created.onerror = () => failWorker();
    created.onmessageerror = () => failWorker();
    worker = created;
    return created;
  } catch {
    workerBroken = true;
    return null;
  }
}

function runInWorker(code: string, lang: string): Promise<string> {
  const w = ensureWorker();
  if (!w) return Promise.reject(new Error('highlight worker unavailable'));
  return new Promise<string>((resolve, reject) => {
    const id = ++requestSeq;
    const timer = setTimeout(() => {
      pendingHighlights.delete(id);
      reject(new Error('highlight worker timeout'));
    }, HIGHLIGHT_TIMEOUT_MS);
    pendingHighlights.set(id, { resolve, reject, timer });
    try {
      w.postMessage({ id, code, lang });
    } catch (err) {
      pendingHighlights.delete(id);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ============================================================================
// 高亮结果缓存（key = `${lang}\u0000${code}`）
// 让「再次进入同一会话」时 CodeBlock 能在首帧拿到高亮 HTML（useState 初值），
// 而不是先渲染无高亮 <pre>、等异步完成后再替换（「先粗后精」闪动）。
// ============================================================================

const htmlCache = new Map<string, string>();
/** 高亮 HTML 缓存上限（条数 + 估算字符总量）：长会话不再无界增长 */
const HTML_CACHE_MAX_ENTRIES = 40;
const HTML_CACHE_MAX_CHARS = 8_000_000;
let htmlCacheChars = 0;

function setHighlightCache(key: string, html: string): void {
  const prev = htmlCache.get(key);
  if (prev !== undefined) {
    htmlCacheChars -= prev.length;
    htmlCache.delete(key);
  }
  htmlCache.set(key, html);
  htmlCacheChars += html.length;
  while (htmlCache.size > HTML_CACHE_MAX_ENTRIES || htmlCacheChars > HTML_CACHE_MAX_CHARS) {
    const first = htmlCache.keys().next();
    if (first.done) break;
    const old = htmlCache.get(first.value);
    htmlCache.delete(first.value);
    if (old !== undefined) htmlCacheChars -= old.length;
  }
}

function cacheKey(code: string, lang: string): string {
  // 语言名在 key 内统一归一（trim + 小写），保证写入端与读取端口径一致
  return `${lang.trim().toLowerCase()}\u0000${code}`;
}

/**
 * 截断到前缀高亮上限（尽量切在最后一个换行处，避免把一行拆成两半）。
 * 返回的字符串既是高亮输入，也是「已高亮前缀」的长度依据。
 * 调用方（CodeBlock）用它判断「当前代码是否已对齐到应高亮的前缀」。
 */
export function capHighlightCode(code: string): string {
  if (code.length <= MAX_HIGHLIGHT_CHARS) return code;
  const head = code.slice(0, MAX_HIGHLIGHT_CHARS);
  const cut = head.lastIndexOf('\n');
  return cut > 0 ? head.slice(0, cut) : head;
}

/** 同步读取已缓存的高亮（未命中返回 null → 调用方走异步升级） */
export function getCachedHighlight(code: string, lang: string): { html: string; code: string } | null {
  const target = capHighlightCode(code);
  const html = htmlCache.get(cacheKey(target, lang));
  return html !== undefined ? { html, code: target } : null;
}

/**
 * 从文件路径推断 Shiki 语言候选 id（别名已归一；未知返回扩展名本身）。
 * 返回值仍需经 resolveShikiLang 校验是否在 bundledLanguages 内；不在则调用方回退纯文本。
 */
export function langFromPath(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (FILENAME_LANG[name]) return FILENAME_LANG[name];
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot + 1);
  if (!ext) return '';
  return LANG_ALIAS[ext] ?? ext;
}

// ============================================================================
// 主线程兜底引擎（Worker 不可用时使用）
// ============================================================================

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki')
      .then((shiki) =>
        shiki.createHighlighter({
          themes: ['catppuccin-latte', 'catppuccin-mocha'],
          langs: [],
        }),
      )
      .catch((err) => {
        // 关键：失败后必须清空，否则 rejected promise 被永久缓存 → 之后所有高亮全部失效
        highlighterPromise = null;
        loadedLangs.clear();
        throw err;
      });
  }
  return highlighterPromise;
}

async function highlightInMainThread(code: string, lang: string): Promise<string | null> {
  if (code.length > MAIN_THREAD_MAX_CHARS) return null;
  try {
    const shiki = await import('shiki');
    const resolved = resolveShikiLang(lang, shiki.bundledLanguages as Record<string, unknown>);
    if (resolved === null) return null;
    const highlighter = await getHighlighter();
    if (!loadedLangs.has(resolved)) {
      await highlighter.loadLanguage(resolved as Parameters<Highlighter['loadLanguage']>[0]);
      loadedLangs.add(resolved);
    }
    return highlighter.codeToHtml(code, {
      lang: resolved,
      themes: { light: 'catppuccin-latte', dark: 'catppuccin-mocha' },
      // 只输出 --shiki-light/--shiki-dark 变量，不写内联 color：
      // 内联 color 会压过 .dark 的主题覆盖，导致夜间渲染成亮色（历史 bug）
      defaultColor: false,
    });
  } catch {
    // 引擎/语言状态可能已损坏：清空语言缓存，下一次请求重新加载
    loadedLangs.clear();
    return null;
  }
}

// ============================================================================
// 对外 API
// ============================================================================

/**
 * 高亮代码为 HTML 字符串（双主题 CSS vars）。
 * Worker 优先，失败/不支持时回退主线程；仍失败返回 null（调用方回退纯文本）。
 *
 * opts.cache=false：不写入高亮缓存（流式中间态每次都是新代码，写缓存只会挤掉历史终态）。
 */
export async function highlightCode(
  code: string,
  lang: string,
  opts?: { cache?: boolean },
): Promise<string | null> {
  if (!code || !lang.trim()) return null;
  if (code.length > WORKER_MAX_CHARS) return null;
  const cached = htmlCache.get(cacheKey(code, lang));
  if (cached !== undefined) return cached;

  let html: string | null = null;
  try {
    html = await runInWorker(code, lang);
  } catch (err) {
    // 语言不受支持：主线程也不会成功，直接放弃
    if (err instanceof HighlightUnsupportedError) return null;
    html = await highlightInMainThread(code, lang);
  }
  if (html === null) return null;
  if (opts?.cache !== false) setHighlightCache(cacheKey(code, lang), html);
  return html;
}

/**
 * 围栏代码高亮：超过 MAX_HIGHLIGHT_CHARS 时只高亮前缀（按行对齐）。
 * 返回的 `code` 是实际被高亮的前缀，调用方据此把剩余部分拼成纯文本尾部。
 */
export async function highlightCodePrefix(
  code: string,
  lang: string,
  opts?: { cache?: boolean },
): Promise<{ html: string; code: string } | null> {
  const target = capHighlightCode(code);
  const html = await highlightCode(target, lang, opts);
  return html === null ? null : { html, code: target };
}
