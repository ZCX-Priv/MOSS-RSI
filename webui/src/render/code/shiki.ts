// render/code/shiki.ts
// Shiki 引擎懒加载：dynamic import + 语言按需注册 + 双主题（catppuccin-latte/catppuccin-mocha）。
// 双主题以 defaultColor:false 输出纯 CSS vars（--shiki-light / --shiki-dark），亮暗切换由 CSS 完成，零重渲。

import type { Highlighter } from 'shiki';

/** 常见语言别名 → Shiki 语言 id */
const LANG_ALIAS: Record<string, string> = {
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  'c++': 'cpp',
  cc: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'mdx',
  rs: 'rust',
  dockerfile: 'dockerfile',
  text: 'plaintext',
  txt: 'plaintext',
  plain: 'plaintext',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  env: 'dotenv',
  dotenv: 'dotenv',
  toml: 'toml',
  makefile: 'make',
  mk: 'make',
  cmake: 'cmake',
  pl: 'perl',
  pm: 'perl',
  kt: 'kotlin',
  kts: 'kotlin',
  sc: 'scala',
  ex: 'elixir',
  exs: 'elixir',
  exts: 'elixir',
  clj: 'clojure',
  cljs: 'clojure',
  hs: 'haskell',
  fs: 'fsharp',
  m: 'objective-c',
  mm: 'objective-cpp',
  proto: 'proto',
  gql: 'graphql',
  styl: 'stylus',
  sass: 'sass',
  xsl: 'xml',
  xslt: 'xml',
  plist: 'xml',
  dtd: 'xml',
  htm: 'html',
  xhtml: 'html',
  diff: 'diff',
  patch: 'diff',
  vrml: 'vrml',
  wrl: 'vrml',
  log: 'log',
  properties: 'properties',
  // C/C++ 家族补充
  cxx: 'cpp',
  hh: 'cpp',
  // Python / PowerShell
  python3: 'python',
  // 构建 / 脚本
  ksh: 'shellscript',
  'shell-session': 'shellsession',
  // 函数式 / 动态语言
  edn: 'clojure',
  erl: 'erlang',
  hrl: 'erlang',
  ml: 'ocaml',
  mli: 'ocaml',
  mll: 'ocaml',
  mly: 'ocaml',
  fsx: 'fsharp',
  fsi: 'fsharp',
  // 标记 / 配置
  editorconfig: 'ini',
  nomad: 'hcl',
  gradle: 'groovy',
  sol: 'solidity',
  s: 'asm',
  // fence 常见写法
  golang: 'go',
  node: 'javascript',
  nodejs: 'javascript',
  objc: 'objective-c',
  'obj-c': 'objective-c',
  'objective-c++': 'objective-cpp',
  'obj-c++': 'objective-cpp',
};

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

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();

/**
 * 高亮结果缓存（key = `${lang}\u0000${code}`）：
 * 让「再次进入同一会话」时 CodeBlock 能在**首帧**就拿到高亮 HTML（useState 初值），
 * 而不是先渲染无高亮 <pre>、等异步完成后再替换（用户看到的「先粗后精」闪动）。
 * 会话级内存缓存，不淘汰（与 fetcher 的 objectUrlCache 同策略，规模受会话内容限制）。
 */
const htmlCache = new Map<string, string>();
/** 高亮 HTML 缓存上限（条数 + 估算字符总量）：长会话不再无界增长 */
const HTML_CACHE_MAX_ENTRIES = 40;
const HTML_CACHE_MAX_CHARS = 8_000_000;
let htmlCacheChars = 0;

/** 写入高亮缓存（LRU 淘汰：超条数或超字符预算时丢最旧） */
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
  // 语言名在 key 内统一归一（trim + 小写），保证写入端（highlightCode 的调用方）与读取端口径一致
  return `${lang.trim().toLowerCase()}\u0000${code}`;
}

/** 同步读取已缓存的高亮 HTML（未命中返回 null → 调用方走异步升级） */
export function getCachedHighlight(code: string, lang: string): string | null {
  return htmlCache.get(cacheKey(code, lang)) ?? null;
}

/**
 * 从文件路径推断 Shiki 语言候选 id（别名已归一；未知返回扩展名本身）。
 * 返回值仍需经 resolveLang 校验是否在 bundledLanguages 内；不在则调用方回退纯文本。
 */
export function langFromPath(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (FILENAME_LANG[name]) return FILENAME_LANG[name];
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot + 1);
  if (!ext) return '';
  return LANG_ALIAS[ext] ?? ext;
}

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((shiki) =>
      shiki.createHighlighter({
        themes: ['catppuccin-latte', 'catppuccin-mocha'],
        langs: [],
      }),
    );
  }
  return highlighterPromise;
}

/** 解析语言名：别名 → Shiki id；未知返回 null（回退纯文本） */
async function resolveLang(lang: string): Promise<string | null> {
  const normalized = lang.trim().toLowerCase();
  if (!normalized) return null;
  const candidate = LANG_ALIAS[normalized] ?? normalized;
  const shiki = await import('shiki');
  const bundled = shiki.bundledLanguages as Record<string, unknown>;
  if (candidate in bundled) return candidate;
  // 试 lazy 动态键（如 vue/html 嵌套别名极少，直接放弃）
  return null;
}

/**
 * 高亮代码为 HTML 字符串（双主题 CSS vars）。
 * 语言未注册/引擎失败返回 null —— 调用方回退纯文本。
 */
export async function highlightCode(code: string, lang: string): Promise<string | null> {
  try {
    // 超大代码不做高亮：逐 token span 会生成数万节点，弱机直接卡死
    if (code.length > 24_000) return null;
    const resolved = await resolveLang(lang);
    if (!resolved) return null;
    const highlighter = await getHighlighter();
    if (!loadedLangs.has(resolved)) {
      await highlighter.loadLanguage(resolved as Parameters<Highlighter['loadLanguage']>[0]);
      loadedLangs.add(resolved);
    }
    const html = highlighter.codeToHtml(code, {
      lang: resolved,
      themes: { light: 'catppuccin-latte', dark: 'catppuccin-mocha' },
      // 只输出 --shiki-light/--shiki-dark 变量，不写内联 color：
      // 内联 color 会压过 .dark 的主题覆盖，导致夜间渲染成亮色（历史 bug）
      defaultColor: false,
    });
    // 写缓存：同一 (lang, code) 再次出现时可由 getCachedHighlight 同步命中（首帧即高亮）
    setHighlightCache(cacheKey(code, lang), html);
    return html;
  } catch {
    return null;
  }
}
