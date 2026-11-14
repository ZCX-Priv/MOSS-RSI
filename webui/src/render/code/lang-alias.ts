// render/code/lang-alias.ts
// Shiki 语言别名表（主线程回退引擎与高亮 Worker 共用）。
// 只做「常见写法 → Shiki 语言 id」的归一，不依赖 shiki 包本身（保持 Worker/主线程都可轻量引入）。

/** 常见语言别名 → Shiki 语言 id */
export const LANG_ALIAS: Record<string, string> = {
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

/**
 * 语言名归一 + 校验：别名 → Shiki 语言 id；不在 bundledLanguages 内返回 null。
 * bundled 由调用方传入（主线程/Worker 各自的 shiki 模块实例）。
 */
export function resolveShikiLang(lang: string, bundled: Record<string, unknown>): string | null {
  const normalized = lang.trim().toLowerCase();
  if (!normalized) return null;
  const candidate = LANG_ALIAS[normalized] ?? normalized;
  return candidate in bundled ? candidate : null;
}
