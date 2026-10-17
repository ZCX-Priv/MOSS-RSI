// read/handlers/office.ts
// Office/文档处理分派：
// - Word OOXML（docx/docm/dotx）：mammoth 提取纯文本（按内容解析，同族格式均支持）
// - Word OLE 旧版（doc）：word-extractor 提取正文/脚注/页眉页脚
// - Excel（xls/xlsx/xlsm/xltx/xltm）：SheetJS 转 CSV（原生支持读旧版 .xls BIFF）
// - PPT OOXML（pptx/pptm/potx/ppsx）+ ODF（odt/ods/odp）+ RTF：officeparser 提取文本
// - PPT OLE 旧版（ppt/pot）与 WPS 演示（dps/dpt）：OLE 记录树文本提取（ole.ts）
// - WPS 文字（wps/wpt）：OOXML(ZIP) → mammoth；OLE → word-extractor 失败后退回 OLE 文本
// - WPS 表格（et/ett）：SheetJS（兼容 BIFF8/OOXML），失败退回 OLE 文本
// - Word 6/95 等旧格式：word-extractor 抛错时自动退回 OLE 文本提取，绝不报错
// 所有库均通过 await import() 动态懒加载，避免未安装时启动失败。

import { readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { extname, basename } from 'node:path';
import type { ToolResult } from '../../types';
import { extractOleText } from './ole';
import type { ArtifactDir } from '../shared/analysis-dir';
import {
  countArtifactAssets,
  readArtifactMarkdown,
  writeArtifactMarkdown,
  writeArtifactMeta,
} from '../shared/analysis-dir';
import {
  convertModernOffice,
  type OfficeContainerKind,
  type OfficeParserFileType,
} from './office-markdown';

/** mammoth.extractRawText 返回结构 */
interface MammothResult {
  value: string;
  messages: unknown[];
}

/** mammoth 模块类型（官方 API：convertToHtml / extractRawText） */
interface MammothModule {
  extractRawText(input: { buffer: Buffer }): Promise<MammothResult>;
}

/** xlsx 工作簿结构 */
interface XlsxWorkbook {
  SheetNames: string[];
  Sheets: Record<string, unknown>;
}

/** xlsx 模块类型 */
interface XlsxModule {
  readFile(path: string, options?: { cellDates?: boolean }): XlsxWorkbook;
  utils: {
    sheet_to_csv(sheet: unknown, options?: { blankrows?: boolean }): string;
  };
}

/** word-extractor / officeparser 的类型分别来自 src/types/word-extractor.d.ts 与包自带 d.ts */

/** Word OOXML 家族扩展名（mammoth 按内容解析，同族均可处理） */
const WORD_OOXML_EXTS = new Set(['.docx', '.docm', '.dotx']);

/** 旧版 OLE Word 家族（word-extractor 按内容解析，模板 .dot 同容器） */
const WORD_OLE_EXTS = new Set(['.doc', '.dot']);

/** Excel 家族扩展名（SheetJS 原生支持读 OOXML、二进制 .xlsb(BIFF12)、旧版 BIFF .xls、模板 .xlt，以及 ODS） */
const EXCEL_EXTS = new Set(['.xlsx', '.xlsm', '.xltx', '.xltm', '.xls', '.xlsb', '.xlt', '.ods', '.ots']);

/** officeparser 处理的扩展名（PPT OOXML / OpenDocument 文本与演示（.ods/.ots 已由 SheetJS 处理）/ RTF） */
const OFFICEPARSER_EXTS = new Set([
  '.pptx', '.pptm', '.potx', '.ppsx',
  '.odt', '.odp', '.ott', '.otp', '.rtf',
]);

/** WPS 各族的扩展名（同一扩展名可能是 OOXML(ZIP) 或 OLE，按容器 magic 分派） */
const WPS_WORD_EXTS = new Set(['.wps', '.wpt']);
const WPS_EXCEL_EXTS = new Set(['.et', '.ett']);
const WPS_PPT_EXTS = new Set(['.dps', '.dpt']);

/** Markdown 产物化（modern）判定用的扩展名集合：仅 officeparser 支持的 OOXML/ODF/RTF 可走此路 */
const EXCEL_OOXML_EXTS = new Set(['.xlsx', '.xlsm', '.xltx', '.xltm']);
const PPT_OOXML_EXTS = new Set(['.pptx', '.pptm', '.potx', '.ppsx']);
const ODT_EXTS = new Set(['.odt', '.ott']);
const ODS_EXTS = new Set(['.ods', '.ots']);
const ODP_EXTS = new Set(['.odp', '.otp']);

/** 依据文件头 magic 判断容器类型：zip(OOXML) / ole(复合文档) / other */
function sniffContainer(path: string): 'zip' | 'ole' | 'other' {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(8);
    const n = readSync(fd, head, 0, 8, 0);
    if (n >= 4 && head[0] === 0x50 && head[1] === 0x4b) return 'zip';
    if (n >= 4 && head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return 'ole';
  } catch {
    // 读取失败按 other 处理
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 忽略关闭失败
      }
    }
  }
  return 'other';
}

/** OLE 文本提取结果 → ToolResult（永不为 isError） */
function oleTextResult(path: string, label: string, kind: 'word' | 'ppt'): ToolResult {
  const text = extractOleText(path, kind);
  return {
    content: [
      {
        type: 'text',
        text: `${path} (${label})\n${text || '（未能从该文件中提取到可读文本，可能为加密或非标准结构）'}`,
      },
    ],
    metadata: { type: label.toLowerCase(), legacy: true },
  };
}

/**
 * 读取 Office/文档文件。
 * 提供 artifact 时优先走「Markdown 产物化」路径（Office→Markdown + 内嵌媒体抽取，
 * 产物落 <artifact>/content.md 与 assets/）；该路径不可用（无 artifact / 转换失败）时
 * 回退到纯文本提取（readOfficePlain），保证任何情况下都不报错、不返回空。
 */
export async function readOffice(path: string, artifact?: ArtifactDir): Promise<ToolResult> {
  if (artifact) {
    const artifactResult = await readOfficeArtifact(path, artifact);
    if (artifactResult) return artifactResult;
  }
  return readOfficePlain(path);
}

/** modern（可产物化）转换规格 */
interface ModernSpec {
  fileTypeHint: OfficeParserFileType;
  containerKind: OfficeContainerKind | null;
}

/**
 * Markdown 产物化路径。
 * 返回 null 表示不可用（调用方回退纯文本）：转换抛错等。
 */
async function readOfficeArtifact(path: string, artifact: ArtifactDir): Promise<ToolResult | null> {
  const ext = extname(path).toLowerCase();

  // 1. 命中已有产物（同哈希复用）：直接读回 content.md
  if (artifact.exists) {
    const cached = readArtifactMarkdown(artifact);
    if (cached !== null) {
      const counts = countArtifactAssets(artifact.assetsDir);
      return markdownResult(path, ext, artifact, cached, counts.images, counts.videos);
    }
  }

  // 2. 新转换
  const spec = resolveModernSpec(path, ext);
  try {
    let markdown: string;
    let images = 0;
    let videos = 0;
    if (spec) {
      const buf = readFileSync(path);
      const out = await convertModernOffice({
        buffer: buf,
        fileTypeHint: spec.fileTypeHint,
        containerKind: spec.containerKind,
        artifact,
      });
      markdown = out.markdown;
      images = out.images;
      videos = out.videos;
    } else {
      // 旧版 OLE / 非 officeparser 支持格式：文本提取后作为 Markdown 落盘（不抽媒体）
      const plain = await readOfficePlain(path);
      if (plain.isError) return plain;
      const body = stripFileHeader(plain, path);
      if (!body.trim()) return plain;
      markdown = body;
    }
    writeArtifactMarkdown(artifact, markdown);
    writeArtifactMeta(artifact, {
      sourcePath: path,
      sha256: basename(artifact.root),
      type: ext.replace('.', ''),
      extra: spec ? { images, videos } : { noMedia: true },
    });
    return markdownResult(path, ext, artifact, markdown, images, videos);
  } catch {
    // 转换失败 → 回退纯文本（绝不向上抛错）
    return null;
  }
}

/** 构造 Markdown 产物结果（首行保持 `${path} (EXT)` 格式，供文本提取路由剥离） */
function markdownResult(
  path: string,
  ext: string,
  artifact: ArtifactDir,
  markdown: string,
  images: number,
  videos: number,
): ToolResult {
  const label = ext.replace('.', '').toUpperCase();
  return {
    content: [{ type: 'text', text: `${path} (${label})\n${markdown}` }],
    metadata: {
      type: label.toLowerCase(),
      artifact: { dir: artifact.root, markdown: artifact.markdownPath, images, videos },
    },
  };
}

/** 剥离文本结果首行的 `${path} (EXT)` 文件头，返回正文（无文件头则原样返回） */
function stripFileHeader(result: ToolResult, absPath: string): string {
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
  const firstLine = text.split('\n')[0] ?? '';
  if (firstLine.startsWith(absPath)) {
    return text.slice(firstLine.length).replace(/^\n/, '');
  }
  return text;
}

/** 判定是否可走 officeparser 的 Markdown 产物化；不可（旧版 OLE 等）返回 null */
function resolveModernSpec(path: string, ext: string): ModernSpec | null {
  const isZip = (): boolean => sniffContainer(path) === 'zip';
  // Word OOXML（含宏/模板同族）
  if (WORD_OOXML_EXTS.has(ext)) return { fileTypeHint: 'docx', containerKind: 'word' };
  if (WPS_WORD_EXTS.has(ext)) return isZip() ? { fileTypeHint: 'docx', containerKind: 'word' } : null;
  // Excel OOXML
  if (EXCEL_OOXML_EXTS.has(ext)) return { fileTypeHint: 'xlsx', containerKind: 'excel' };
  if (WPS_EXCEL_EXTS.has(ext)) return isZip() ? { fileTypeHint: 'xlsx', containerKind: 'excel' } : null;
  // PowerPoint OOXML（.ppt/.pot 被改名为 OOXML 时同族处理）
  if (PPT_OOXML_EXTS.has(ext)) return { fileTypeHint: 'pptx', containerKind: 'ppt' };
  if (WPS_PPT_EXTS.has(ext)) return isZip() ? { fileTypeHint: 'pptx', containerKind: 'ppt' } : null;
  if (ext === '.ppt' || ext === '.pot') return isZip() ? { fileTypeHint: 'pptx', containerKind: 'ppt' } : null;
  // OpenDocument
  if (ODT_EXTS.has(ext)) return { fileTypeHint: 'odt', containerKind: 'odf' };
  if (ODS_EXTS.has(ext)) return { fileTypeHint: 'ods', containerKind: 'odf' };
  if (ODP_EXTS.has(ext)) return { fileTypeHint: 'odp', containerKind: 'odf' };
  // RTF（非 ZIP 容器，无媒体抽取）
  if (ext === '.rtf') return { fileTypeHint: 'rtf', containerKind: null };
  return null;
}

/**
 * 读取 Office/文档文件，提取纯文本（原实现；artifact 不可用时回退路径）。
 * 根据扩展名分派到对应处理器。
 */
async function readOfficePlain(path: string): Promise<ToolResult> {
  const ext = extname(path).toLowerCase();
  try {
    if (WORD_OOXML_EXTS.has(ext)) {
      return await readDocx(path);
    }
    if (WORD_OLE_EXTS.has(ext)) {
      return await readLegacyDoc(path);
    }
    // WPS 文字：ZIP → mammoth；OLE → word-extractor（失败自动退回 OLE 文本）
    if (WPS_WORD_EXTS.has(ext)) {
      if (sniffContainer(path) === 'zip') return await readDocx(path);
      return await readLegacyDoc(path);
    }
    // WPS 表格：SheetJS 兼容 OOXML/BIFF8；失败退回 OLE 文本
    if (WPS_EXCEL_EXTS.has(ext)) {
      try {
        return await readXlsx(path);
      } catch {
        return oleTextResult(path, ext.slice(1).toUpperCase(), 'word');
      }
    }
    if (EXCEL_EXTS.has(ext)) {
      return await readXlsx(path);
    }
    if (OFFICEPARSER_EXTS.has(ext)) {
      return await readWithOfficeParser(path, ext);
    }
    // PPT OLE 旧版 / WPS 演示：ZIP → officeparser；OLE → 记录树文本提取
    if (WPS_PPT_EXTS.has(ext)) {
      if (sniffContainer(path) === 'zip') return await readWithOfficeParser(path, ext);
      return oleTextResult(path, ext.slice(1).toUpperCase(), 'ppt');
    }
    if (ext === '.ppt' || ext === '.pot') {
      // 被改名的 OOXML(.pptx) 走 officeparser；否则 OLE 记录树文本提取
      if (sniffContainer(path) === 'zip') return await readWithOfficeParser(path, ext);
      return oleTextResult(path, ext.slice(1).toUpperCase(), 'ppt');
    }
    return {
      content: [{ type: 'text', text: `Error: unsupported office format: ${ext}` }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error reading office file: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

/**
 * 读取 Word OOXML 文件（docx/docm/dotx），用 mammoth 提取纯文本。
 */
async function readDocx(path: string): Promise<ToolResult> {
  const mod = (await import('mammoth')) as MammothModule & { default?: MammothModule };
  const mammoth: MammothModule = mod.default ?? mod;
  const buf = readFileSync(path);
  const result = await mammoth.extractRawText({ buffer: buf });

  const ext = extname(path).toLowerCase().slice(1).toUpperCase();
  return {
    content: [{ type: 'text', text: `${path} (${ext})\n${result.value}` }],
    metadata: { type: 'docx' },
  };
}

/**
 * 读取旧版 OLE Word 文件（.doc），用 word-extractor 提取。
 * 正文之外，脚注/页眉页脚非空时附加输出。
 */
async function readLegacyDoc(path: string): Promise<ToolResult> {
  // Word 6/95（magic 0xA5DC）等旧格式，word-extractor 会抛 "Invalid magic number"；
  // 这里先尝试 word-extractor（排版抽取更优），失败则退回 OLE 自解文本，绝不向上抛错。
  try {
    // CJS 包（module.exports = 构造函数），经 default 互操作获取
    const mod = await import('word-extractor');
    const WordExtractor = mod.default;
    const extractor = new WordExtractor();
    const buf = readFileSync(path);
    const doc = await extractor.extract(buf);

    const sections: string[] = [doc.getBody()];
    const footnotes = doc.getFootnotes();
    if (footnotes && footnotes.trim()) {
      sections.push(`\n--- Footnotes ---\n${footnotes}`);
    }
    const headers = doc.getHeaders();
    if (headers && headers.trim()) {
      sections.push(`\n--- Headers & Footers ---\n${headers}`);
    }

    return {
      content: [{ type: 'text', text: `${path} (DOC)\n${sections.join('\n')}` }],
      metadata: { type: 'doc' },
    };
  } catch {
    // 旧式 .doc 也可能是被改名的 OOXML(.docx)：按容器 magic 再试一次
    if (sniffContainer(path) === 'zip') {
      try {
        return await readDocx(path);
      } catch {
        // 落入 OLE 文本兜底
      }
    }
    return oleTextResult(path, extname(path).slice(1).toUpperCase(), 'word');
  }
}

/**
 * 读取 Excel 文件（xls/xlsx/xlsm/xltx/xltm），用 xlsx 库转为 CSV 格式，每个工作表分块展示。
 */
async function readXlsx(path: string): Promise<ToolResult> {
  const mod = (await import('xlsx')) as XlsxModule & { default?: XlsxModule };
  const XLSX: XlsxModule = mod.default ?? mod;
  const wb = XLSX.readFile(path, { cellDates: true });

  const lines: string[] = [
    `Workbook: ${basename(path)}`,
    `Sheets: ${wb.SheetNames.join(', ')}`,
    '',
  ];

  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    lines.push(`## Sheet: ${name}`, '```csv', csv, '```', '');
  }

  const ext = extname(path).toLowerCase().slice(1).toUpperCase();
  return {
    content: [{ type: 'text', text: `${path} (${ext})\n${lines.join('\n')}` }],
    metadata: { type: 'xlsx', sheets: wb.SheetNames.length },
  };
}

/**
 * 读取 PPT OOXML / OpenDocument / RTF 文件，用 officeparser 提取文本。
 * PPTX 含演讲者备注（officeparser 默认 ignoreNotes=false）。
 */
async function readWithOfficeParser(path: string, ext: string): Promise<ToolResult> {
  // officeparser 顶层命名导出 parseOffice（= OfficeParser.parseOffice 静态方法别名）
  const { parseOffice } = await import('officeparser');

  const buf = readFileSync(path);
  const ast = await parseOffice(buf);
  const text = ast.toText();

  const label = ext.slice(1).toUpperCase();
  return {
    content: [{ type: 'text', text: `${path} (${label})\n${text}` }],
    metadata: { type: label.toLowerCase() },
  };
}
