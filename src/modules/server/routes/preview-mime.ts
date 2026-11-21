// modules/server/routes/preview-mime.ts
// 文件预览的「扩展名 → MIME」真源（纯模块：不 import 任何重依赖，便于脚本直接校验）。
//
// 背景（回归根因）：前端 webui/src/render/file/detector.ts 把大量代码/配置/标记类扩展名
// 归为可预览类型，但后端白名单曾遗漏它们 → /api/filesystem/raw 返回 415「不支持」。
// 因此这里显式补全全部文本类扩展名，并由一致性脚本（见验证步骤）断言
// 「前端 KIND_EXTENSIONS 的每个扩展名都在 RAW_MIME_MAP 中」，从根上防止再次漂移。

/** 文本类文件的统一 MIME */
export const MIME_BY_TEXT = 'text/plain; charset=utf-8';

/**
 * 文本类扩展名（与前端 detector.ts 的 CODE_EXTS + MARKDOWN_EXTS + HTML_EXTS + DATA_EXTS 对齐）。
 * 这些扩展名走「文本通道」：/api/filesystem/text 直接解码返回（bounded + 编码检测）。
 * 注意：不含 svg（图片）、opf/fb2（电子书，走专用解析 handler）。
 */
const TEXT_EXTS: readonly string[] = [
  'txt', 'text', 'log',
  // Markdown
  'md', 'markdown', 'mdx',
  // HTML（前端按 html 预览，但内容是文本，仍需文本通道可取）
  'html', 'htm', 'xhtml',
  // 数据（分隔符）
  'csv', 'tsv',
  // 扁平 XML 的 OpenDocument（非 zip 容器，直接按文本预览）
  'fodt', 'fods', 'fodp',
  // 配置 / 数据
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env',
  'properties', 'gitignore', 'gitattributes', 'editorconfig', 'lock', 'dotenv',
  // 常见点文件（无基名、仅扩展名）：其扩展名需配合 extOfFile 才能正确取得（见下方）
  'prettierrc', 'prettierignore', 'eslintrc', 'eslintignore', 'stylelintrc', 'babelrc',
  'npmrc', 'yarnrc', 'pnpmrc', 'nvmrc', 'dockerignore', 'gitmodules', 'gitkeep',
  'htaccess', 'jshintrc', 'browserslistrc', 'commitlintrc', 'lintstagedrc',
  'makefile', 'dockerfile', 'cmake', 'gradle', 'bazel', 'tf', 'tfvars', 'hcl', 'nomad',
  // 代码
  'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'psm1', 'nu',
  'py', 'pyi', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'rs', 'go', 'java', 'kt', 'kts', 'groovy', 'c', 'h', 'cpp', 'hpp', 'cc', 'hh',
  'cxx', 'cs', 'php', 'rb', 'swift', 'm', 'mm', 'r', 'lua', 'vue', 'svelte', 'dart',
  'scala', 'sc', 'pl', 'pm', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'edn', 'hs',
  'ml', 'mli', 'fs', 'fsx', 'vb', 'jl', 'nim', 'zig', 'v', 'asm', 's', 'sql', 'graphql',
  'gql', 'proto', 'thrift', 'sol', 'wasm', 'wat',
  // 标记 / 样式 / 补丁
  'css', 'scss', 'sass', 'less', 'styl', 'xml', 'xsl', 'xslt', 'dtd', 'plist', 'svgz',
  'http', 'rest', 'diff', 'patch',
  // LaTeX（前端按公式渲染）
  'tex', 'latex', 'ltx',
  // 字幕 / 歌词
  'srt', 'vtt', 'ass', 'ssa', 'lrc',
  // 日历 / 名片
  'ics', 'ifb', 'vcf', 'vcard',
  // 地理数据（GeoJSON/KML/GPX 为 XML/JSON 文本）
  'gpx', 'kml', 'geojson',
  // 证书（PEM 文本；DER 走二进制通道，见 BASE_MIME）
  'pem', 'crt', 'csr', 'p7b',
  // JSON Lines（逐行 JSON）
  'ndjson', 'jsonl',
  // 2D 矢量图纸（ASCII DXF）
  'dxf',
  // 3D 文本格式（three loader 直接解析）
  'gcode', 'xyz',
];

/**
 * 基础 MIME 表（二进制与专有格式；优先级高于 MIME_BY_TEXT 兜底）。
 * 与 webui/src/render/file/fetcher.ts 的 MIME_BY_EXT 对齐。
 */
const BASE_MIME: Record<string, string> = {
  // 文档
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  docm: 'application/vnd.ms-word.document.macroenabled.12',
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroenabled.12',
  xlsb: 'application/vnd.ms-excel.sheet.binary.macroenabled.12',
  xltx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  xltm: 'application/vnd.ms-excel.template.macroenabled.12',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  potx: 'application/vnd.openxmlformats-officedocument.presentationml.template',
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  /** 旧版 Office 模板族（与 doc/xls/ppt 同容器） */
  dot: 'application/msword',
  xlt: 'application/vnd.ms-excel',
  pot: 'application/vnd.ms-powerpoint',
  // WPS（文字/表格/演示；同一扩展名可能为 OOXML 或 OLE，按 magic 解析）
  wps: 'application/msword',
  wpt: 'application/msword',
  et: 'application/vnd.ms-excel',
  ett: 'application/vnd.ms-excel',
  dps: 'application/vnd.ms-powerpoint',
  dpt: 'application/vnd.ms-powerpoint',
  // OpenDocument / RTF（含模板族；fodt/fods/fodp 为扁平 XML，归入文本类见 TEXT_EXTS）
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  ott: 'application/vnd.oasis.opendocument.text-template',
  ots: 'application/vnd.oasis.opendocument.spreadsheet-template',
  otp: 'application/vnd.oasis.opendocument.presentation-template',
  rtf: 'application/rtf',
  // 电子书
  epub: 'application/epub+zip',
  opf: 'application/oebps-package+xml',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  azw: 'application/vnd.amazon.ebook',
  fb2: 'application/x-fictionbook+xml',
  // 网页（保留正确 MIME；文本通道由 TEXT_PREVIEW_EXTS 单独放行）
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xhtml: 'application/xhtml+xml',
  // 字体
  ttf: 'font/ttf',
  otf: 'font/otf',
  ttc: 'font/collection',
  otc: 'font/collection',
  otb: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  eot: 'application/vnd.ms-fontobject',
  dfont: 'application/x-dfont',
  fon: 'application/x-fon',
  fnt: 'application/x-fon',
  pfb: 'application/x-font-type1',
  pfm: 'application/x-font-type1',
  // 压缩包
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  // 3D
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'text/plain; charset=utf-8',
  mtl: 'text/plain; charset=utf-8',
  stl: 'model/stl',
  fbx: 'application/octet-stream',
  ply: 'application/octet-stream',
  '3mf': 'model/3mf',
  dae: 'model/vnd.collada+xml',
  '3ds': 'application/octet-stream',
  wrl: 'model/vrml',
  vrml: 'model/vrml',
  amf: 'application/x-amf',
  // 图片
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  apng: 'image/apng',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  // 视频
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  m3u8: 'application/vnd.apple.mpegurl',
  rmvb: 'application/vnd.rn-realmedia-vbr',
  // 音频
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  weba: 'audio/webm',
  wma: 'audio/x-ms-wma',
  amr: 'audio/amr',
  mid: 'audio/midi',
  midi: 'audio/midi',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  // ── 图像（新增：前端自解码 netpbm/tga，或 openjpeg WASM 解 jp2） ──
  pbm: 'image/x-portable-bitmap',
  pgm: 'image/x-portable-graymap',
  ppm: 'image/x-portable-pixmap',
  pnm: 'image/x-portable-anymap',
  pam: 'image/x-portable-arbitrarymap',
  tga: 'image/x-tga',
  jp2: 'image/jp2',
  j2k: 'image/jp2',
  jpf: 'image/jp2',
  jpx: 'image/jp2',
  // ── Flash / 压缩包 ──
  swf: 'application/x-shockwave-flash',
  cab: 'application/vnd.ms-cab-compressed',
  // ── 3D（three examples/jsm loader 直接解析） ──
  '3dm': 'application/octet-stream',
  bvh: 'application/octet-stream',
  drc: 'application/octet-stream',
  kmz: 'application/vnd.google-earth.kmz',
  md2: 'application/octet-stream',
  mdd: 'application/octet-stream',
  nrrd: 'application/octet-stream',
  pcd: 'application/octet-stream',
  pdb: 'chemical/x-pdb',
  usdz: 'model/vnd.usdz+zip',
  vox: 'application/octet-stream',
  // ── 数据库 ──
  sqlite: 'application/vnd.sqlite3',
  sqlite3: 'application/vnd.sqlite3',
  db: 'application/vnd.sqlite3',
  db3: 'application/vnd.sqlite3',
  // ── 证书（二进制 DER，渲染器内部识别 PEM/DER） ──
  cer: 'application/pkix-cert',
  der: 'application/pkix-cert',
  // ── ICC 色彩配置文件 ──
  icc: 'application/vnd.iccprofile',
  icm: 'application/vnd.iccprofile',
  // ── 明确「不接入原生渲染」：仍放行 /raw，保证可下载、可回退（前端 kind=unknown） ──
  stp: 'application/step',
  step: 'application/step',
  ifc: 'application/x-step',
  splat: 'application/octet-stream',
  spz: 'application/octet-stream',
  jxl: 'image/jxl',
  bpg: 'image/bpg',
  mng: 'video/x-mng',
  wmf: 'image/wmf',
  emf: 'image/emf',
  dcm: 'application/dicom',
  ac3: 'audio/ac3',
  chm: 'application/vnd.ms-htmlhelp',
  mdb: 'application/x-msaccess',
  accdb: 'application/x-msaccess',
  wri: 'application/x-mswrite',
  lha: 'application/x-lzh-compressed',
  lzh: 'application/x-lzh-compressed',
};

/**
 * 预览扩展名白名单 → MIME。
 * 基础表优先（保留 html/text/xml 的专有 MIME），其余文本类扩展名兜底为 text/plain。
 */
export const RAW_MIME_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = { ...BASE_MIME };
  for (const ext of TEXT_EXTS) {
    if (!(ext in map)) map[ext] = MIME_BY_TEXT;
  }
  return map;
})();

/** 文本类扩展名集合（/api/filesystem/text 的直接解码分支） */
export const TEXT_PREVIEW_EXTS = new Set<string>(TEXT_EXTS);

/** 是否为文本类扩展名（大小写不敏感） */
export function isTextualExt(ext: string): boolean {
  return TEXT_PREVIEW_EXTS.has(ext.toLowerCase());
}

/**
 * 取预览用扩展名（小写、无点），与前端 detector.fileExtension 语义一致。
 *
 * 关键：Node `path.extname('.gitignore')` 返回 `''`（把以点开头的文件当作无扩展名的隐藏文件），
 * 会导致 `.gitignore` / `.env` / `.prettierrc` 等点文件被误判为「无扩展名」→ 白名单查不到 → 415。
 * 这里对「以点开头且不含其它点」的纯点文件特判：整段去点即为扩展名。
 */
export function extOfFile(nameOrPath: string): string {
  const base = nameOrPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot === -1) return '';
  if (dot === 0) return base.slice(1).toLowerCase();
  return base.slice(dot + 1).toLowerCase();
}

/** 视频/音频扩展名（/api/filesystem/media 白名单，防退化为任意文件下载器）
 *  注意：不含 'ts'——它在前端归属 TypeScript（文本），MPEG-TS 由 'm2ts' 承载。 */
export const MEDIA_EXTS = new Set<string>([
  'mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi', 'wmv', 'flv', '3gp', '3g2',
  'm2ts', 'mpg', 'mpeg', 'rmvb', 'm3u8',
  'mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba', 'wma', 'amr',
  'mid', 'midi', 'aiff', 'aif',
]);