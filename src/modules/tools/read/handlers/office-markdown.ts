// read/handlers/office-markdown.ts
// 现代 Office 容器（OOXML / ODF / RTF）→ Markdown 转换 + 内嵌媒体抽取。
//
// 技术路线：officeparser v7 的 parseOffice(buf, { fileType, extractAttachments:true }) 得到 AST，
// 再用 ast.to('md', { includeImages, onNode }) 生成 Markdown。图片节点默认会被内联成 base64 data URI，
// 这里用 onNode 回调覆写渲染：把附件字节落到 <产物>/assets/，并在原位置输出 ![alt](<绝对路径>)，
// 从而保证图片出现在「对应的内容处」且路径可被 read 工具直接读取。
//
// 视频：officeparser 附件只覆盖 image/chart，不抽视频。故对 ZIP 容器自行解包扫描媒体目录
// （word/media、ppt/media、xl/media、Pictures），把视频本体落到 assets/，并在文档末尾追加
// 「Embedded videos」段（ppt 通过 slides rels 标注来源页号）。旧版 OLE 容器无 ZIP，跳过。
//
// 所有重依赖均动态懒加载（officeparser / jszip），与同目录其它 handler 一致。

import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ArtifactDir } from '../shared/analysis-dir';

/** officeparser 支持的文件类型（本模块用到的子集） */
export type OfficeParserFileType = 'docx' | 'pptx' | 'xlsx' | 'odt' | 'odp' | 'ods' | 'rtf';

/** 媒体目录所属容器系列 */
export type OfficeContainerKind = 'word' | 'ppt' | 'excel' | 'odf';

/** 现代容器转换入参 */
export interface ModernConvertInput {
  buffer: Buffer;
  /** officeparser fileType 提示（绕过魔数检测，兼容被改名/宏启用的同族文件） */
  fileTypeHint: OfficeParserFileType;
  /** 媒体目录所属容器系列；非 ZIP 容器（如 RTF）传 null 表示不抽媒体 */
  containerKind: OfficeContainerKind | null;
  artifact: ArtifactDir;
}

/** 现代容器转换结果 */
export interface ModernConvertResult {
  /** 生成的 Markdown（含内嵌图片路径 + 末尾视频段） */
  markdown: string;
  /** 抽取的图片数量 */
  images: number;
  /** 抽取的视频本体数量 */
  videos: number;
}

/** ZIP 容器媒体目录前缀 */
const MEDIA_PREFIX: Record<OfficeContainerKind, string> = {
  word: 'word/media/',
  ppt: 'ppt/media/',
  excel: 'xl/media/',
  odf: 'Pictures/',
};

/** 视为视频的扩展名（不含 ts：属 TypeScript 文本；不含 m3u8：播放列表） */
const VIDEO_EXTS = new Set([
  'mp4', 'm4v', 'mov', 'qt', 'avi', 'wmv', 'asf', 'mkv', 'webm', 'flv',
  '3gp', '3g2', 'mpeg', 'mpg', 'ogv', 'rmvb',
]);

/** MIME → 扩展名兜底（附件 extension 缺失时使用） */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/x-emf': 'emf',
  'image/emf': 'emf',
  'image/x-wmf': 'wmf',
};

/** officeparser 附件的最小结构（只取用到的字段，避免静态 import 类型） */
interface AttachmentLite {
  type?: string;
  mimeType?: string;
  /** base64 数据 */
  data?: string;
  name?: string;
  extension?: string;
  altText?: string;
}

/** officeparser AST 节点最小结构 */
interface NodeLite {
  type?: string;
  text?: string;
  metadata?: { attachmentName?: string; url?: string; altText?: string };
}

/** officeparser AST 最小结构 */
interface AstLite {
  type?: string;
  attachments?: AttachmentLite[];
  to(dest: string, config?: Record<string, unknown>): Promise<{ value: unknown }>;
}

/** 抽取到的视频引用 */
interface VideoRef {
  /** 落到 assets 后的文件名 */
  name: string;
  /** 绝对路径 */
  absPath: string;
  /** ppt 场景的来源页号（升序，可能为空） */
  slides: number[];
}

/** 把绝对路径格式化为 Markdown 链接目标（正斜杠化；含空格/括号/引号时用 <> 包裹） */
function toMdPath(absPath: string): string {
  const fwd = absPath.replace(/\\/g, '/');
  return /[\s()<>"']/.test(fwd) ? `<${fwd}>` : fwd;
}

/** Markdown 图片 alt 文本净化（去换行与方括号，避免破坏 `![...]`） */
function escapeAlt(raw: string): string {
  return (raw || 'image').replace(/[[\]]/g, '').replace(/[\r\n]+/g, ' ').trim() || 'image';
}

/** 从文件名取净化后的主干（去扩展名与路径分隔符/非法字符，限长） */
function safeStem(raw: string): string {
  const base = basename(raw.replace(/\\/g, '/'));
  const stem = base.replace(/\.[^.]*$/, '');
  const cleaned = stem.replace(/[<>:"|?*\u0000-\u001F\\/]/g, '').trim().slice(0, 60);
  return cleaned || 'media';
}

/** 扩展名归一（仅 1-5 位字母数字；非法回退 fallbackExt） */
function safeExt(raw: string | undefined, fallbackExt: string): string {
  const e = (raw ?? '').replace(/^\./, '').toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(e) ? e : fallbackExt;
}

/** 在 assets 目录下选取不冲突的文件名（同名则追加 -1/-2…） */
function uniqueAssetName(assetsDir: string, stem: string, ext: string): string {
  let candidate = `${stem}.${ext}`;
  let i = 1;
  while (existsSync(join(assetsDir, candidate))) {
    candidate = `${stem}-${i}.${ext}`;
    i++;
  }
  return candidate;
}

/** 附件扩展名：优先 attachment.extension，其次 MIME 映射，最后 png */
function attachmentExt(att: AttachmentLite): string {
  if (att.extension) return safeExt(att.extension, 'png');
  const byMime = att.mimeType ? MIME_EXT[att.mimeType.toLowerCase()] : undefined;
  return safeExt(byMime, 'png');
}

/** 取路径扩展名（小写、无点） */
function extOfPath(p: string): string {
  const base = basename(p);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/**
 * 现代 Office 容器 → Markdown + 媒体抽取。
 * 失败向上抛错，由调用方（office.ts）回退到纯文本逻辑。
 */
export async function convertModernOffice(input: ModernConvertInput): Promise<ModernConvertResult> {
  const { buffer, fileTypeHint, containerKind, artifact } = input;
  const { parseOffice } = (await import('officeparser')) as {
    parseOffice: (data: Buffer | Uint8Array, config?: Record<string, unknown>) => Promise<AstLite>;
  };

  const ast = await parseOffice(buffer, { fileType: fileTypeHint, extractAttachments: true });
  const attachments = Array.isArray(ast.attachments) ? ast.attachments : [];

  let images = 0;
  const writeImage = (att: AttachmentLite): string | null => {
    if (!att.data) return null;
    const ext = attachmentExt(att);
    const name = uniqueAssetName(artifact.assetsDir, safeStem(att.name ?? 'image'), ext);
    try {
      writeFileSync(join(artifact.assetsDir, name), Buffer.from(att.data, 'base64'));
    } catch {
      return null;
    }
    images++;
    return toMdPath(join(artifact.assetsDir, name));
  };

  // 图片节点覆写：原位置输出文件路径引用；其它节点返回 void 走默认渲染
  const onNode = (node: NodeLite): string | void => {
    if (!node || node.type !== 'image') return;
    const meta = node.metadata ?? {};
    // 外链图片（url）保持原 URL
    if (meta.url) return `![${escapeAlt(meta.altText ?? 'image')}](${meta.url})`;
    const att = meta.attachmentName ? attachments.find((a) => a.name === meta.attachmentName) : undefined;
    if (!att) return '';
    const ref = writeImage(att);
    return ref ? `![${escapeAlt(att.altText ?? meta.altText ?? 'image')}](${ref})` : '';
  };

  const { value } = await ast.to('md', { includeImages: true, includeFormatting: false, onNode });
  let markdown = typeof value === 'string' ? value : String(value ?? '');

  // 视频本体抽取（ZIP 容器）
  let videos: VideoRef[] = [];
  if (containerKind) {
    try {
      videos = await extractZipVideos(buffer, containerKind, artifact.assetsDir);
    } catch {
      videos = [];
    }
  }

  if (videos.length > 0) {
    markdown = appendVideoSection(markdown, videos);
  }

  return { markdown, images, videos: videos.length };
}

/** 在 Markdown 末尾追加视频清单段（ppt 标注来源页号） */
function appendVideoSection(markdown: string, videos: VideoRef[]): string {
  const lines: string[] = ['-'];
  for (const v of videos) {
    const slideLabel = v.slides.length > 0 ? `Slide ${v.slides.join(', ')}: ` : '';
    lines.push(`${slideLabel}[${v.name}](${toMdPath(v.absPath)})`);
  }
  const section = `\n\n---\n\n## Embedded videos (extracted)\n\n${lines.join('\n')}\n`;
  return `${markdown.replace(/\s+$/, '')}${section}`;
}

/**
 * 从 ZIP 容器抽取视频本体到 assets/。
 * ppt 通过 ppt/slides/_rels/slideN.xml.rels 关联来源页号。
 */
async function extractZipVideos(
  buffer: Buffer,
  containerKind: OfficeContainerKind,
  assetsDir: string,
): Promise<VideoRef[]> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);

  const mediaPrefix = MEDIA_PREFIX[containerKind];
  const slideMap = containerKind === 'ppt' ? await buildPptSlideMap(zip) : new Map<string, number[]>();

  const refs: VideoRef[] = [];
  for (const [entryPath, entry] of Object.entries(zip.files)) {
    if (entry.dir || !entryPath.startsWith(mediaPrefix)) continue;
    const ext = extOfPath(entryPath);
    if (!VIDEO_EXTS.has(ext)) continue;
    const sourceName = basename(entryPath);
    let data: Buffer;
    try {
      data = (await entry.async('nodebuffer')) as Buffer;
    } catch {
      continue;
    }
    const name = uniqueAssetName(assetsDir, safeStem(sourceName), safeExt(ext, 'mp4'));
    try {
      writeFileSync(join(assetsDir, name), data);
    } catch {
      continue;
    }
    refs.push({
      name,
      absPath: join(assetsDir, name),
      slides: slideMap.get(sourceName) ?? [],
    });
  }
  return refs.sort((a, b) => (a.slides[0] ?? 0) - (b.slides[0] ?? 0));
}

/** 解析 ppt/slides/_rels/slideN.xml.rels：媒体文件名 → 来源页号列表 */
async function buildPptSlideMap(zip: {
  files: Record<string, { async(type: 'string'): Promise<string> }>;
}): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  const relsRe = /^ppt\/slides\/_rels\/slide(\d+)\.xml\.rels$/;
  for (const [entryPath, entry] of Object.entries(zip.files)) {
    const m = relsRe.exec(entryPath);
    if (!m) continue;
    const slideNo = parseInt(m[1], 10);
    let xml = '';
    try {
      xml = await entry.async('string');
    } catch {
      continue;
    }
    for (const rel of xml.matchAll(/Target="([^"]+)"/g)) {
      const target = basename(rel[1].replace(/\\/g, '/'));
      const targetExt = extOfPath(target);
      if (!VIDEO_EXTS.has(targetExt)) continue;
      const list = map.get(target) ?? [];
      if (!list.includes(slideNo)) list.push(slideNo);
      map.set(target, list);
    }
  }
  for (const list of map.values()) list.sort((a, b) => a - b);
  return map;
}
