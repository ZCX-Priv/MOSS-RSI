// tools/read/index.ts
// read 工具核心调度层：参数校验 → 路径安全（filesys roots）→ 大文件策略 → Dedup → 类型分派 → 结果聚合。
// 元数据（name/description/icon/annotations/inputSchema/config）见同目录 tool.json。
// handlers/ 子目录按文件类型分派，shared/ 子目录提供检测/minified/流式读取等公共能力。
//
// 特殊分派：
//   - office：Markdown 产物化（Office→Markdown + 内嵌图片/视频抽取），产物落
//     <cwd>/.moss/analysis/<sha256>/（本机模式为 ~/.moss/analysis），见 handlers/office.ts。
//   - video：返回基础信息 + 容器元数据（有界 IO），见 handlers/video.ts；在大小上限之前分派。
//
// filesys 统一化改造：
//   - 路径解析走 FilesysService.resolve（roots 机制，默认等价旧版 resolveWithinCwd）
//   - sha256/编码分类/内容读取合并走 filesys.readFile（缓存命中零读盘；未命中一次读盘全派生，
//     旧实现同一文件读 3 次盘：classify 全量读 + handler 读 + sha 再读）
//   - Dedup 并入 filesys 缓存条目的 lastReadAt（旧 shared/dedup.ts 删除）
//
// 路径（read/index.ts → src/）：
//   ../../../../core/types    — ServiceNames
//   ../../types               — ToolContext, ToolResult, ToolResultContent
//   ../../../contracts        — FileHistoryService, FilesysService
//   ./shared/detector         — detectFileType
//   ./handlers/*              — readText/readImage/readPdf/readOffice/readNotebook/readEbook

import { existsSync, statSync, type Stats } from 'node:fs';
import { ServiceNames } from '../../../core/types';
import { t } from '../../../core/i18n';
import { detectFileType, type FileType } from './shared/detector';
import { readText, type TextParams, type CachedFileEntity } from './handlers/text';
import { readImage } from './handlers/image';
import { readPdf } from './handlers/pdf';
import { readOffice } from './handlers/office';
import { readNotebook } from './handlers/notebook';
import { readEbook } from './handlers/ebook';
import { readVideo } from './handlers/video';
import { ensureArtifactDir, resolveAnalysisBase, type ArtifactDir } from './shared/analysis-dir';
import type { FileHistoryService, FilesysService } from '../../contracts';
import type { ToolContext, ToolResult, ToolResultContent } from '../types';

/** read 工具参数结构 */
interface ReadParams {
  /** 单个文件路径（与 paths 互斥） */
  path?: string;
  /** 多文件批量读取路径数组（与 path 互斥） */
  paths?: string[];
  /** 精确模式开始行号；indentation 模式锚点行号（1-based） */
  offset?: number;
  /** 精确模式读取行数 */
  limit?: number;
  /** 读取模式 */
  mode?: 'full' | 'precise' | 'indentation';
  /** PDF 页码范围，如 "1-5" */
  pages?: string;
}

/** 文件大小硬上限：50MB */
const MAX_FILE_SIZE = 50 * 1024 * 1024;

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = params as ReadParams;

    // 1. 参数校验：path 与 paths 互斥，至少一个
    const targets = resolveTargets(p);
    if (!targets) {
      return errorResult(t('tools.readPathRequired'));
    }

    // filesys 服务必须可用（统一入口，不静默降级回旧路径）
    const filesys = ctx.services.tryResolve<FilesysService>(ServiceNames.FILESYS);
    if (!filesys) {
      return errorResult(t('filesys.serviceUnavailable'));
    }
    const fileHistory = ctx.services.tryResolve<FileHistoryService>(ServiceNames.FILE_HISTORY);

    // 2. 逐文件处理（批量时聚合结果）
    const contents: ToolResultContent[] = [];
    const metadatas: Record<string, unknown>[] = [];

    for (const rawPath of targets) {
      const result = await processSingleFile(rawPath, p, ctx, filesys, fileHistory);
      contents.push(...result.content);
      metadatas.push(result.metadata ?? {});
    }

    // 3. 单文件直接返回，多文件拼接
    return targets.length === 1
      ? { content: contents, metadata: metadatas[0] }
      : { content: contents, metadata: { files: metadatas } };
  },
};

/** 解析参数，返回要读取的路径数组；无效返回 null */
function resolveTargets(p: ReadParams): string[] | null {
  if (p.paths && p.paths.length > 0) return p.paths;
  if (p.path) return [p.path];
  return null;
}

/** 处理单个文件：roots 校验 → 大文件策略 → Dedup → 一次读盘（filesys 缓存）→ 类型分派 */
async function processSingleFile(
  rawPath: string,
  params: ReadParams,
  ctx: ToolContext,
  filesys: FilesysService,
  fileHistory: FileHistoryService | null,
): Promise<ToolResult> {
  // 路径越权检测（roots 机制；默认配置等价旧版 cwd 限制）
  const path = filesys.resolve(rawPath, ctx.cwd);
  if (!path) {
    return errorResult(t('fs.pathOutsideRoots', {
      path: rawPath,
      roots: filesys.listRoots().length > 0 ? ` + ${filesys.listRoots().join(', ')}` : '',
    }));
  }

  // 存在性检测
  if (!existsSync(path)) {
    return errorResult(t('tools.readFileNotFound', { path }));
  }

  const stat = statSync(path);

  // 目录拒绝
  if (stat.isDirectory()) {
    return errorResult(t('tools.readPathIsDirectory', { path }));
  }

  // 类型检测（提前：视频需在大文件上限之前处理——视频仅按需读头部，不整读进内存）
  const fileType = detectFileType(path);

  // 视频：返回基础信息 + 容器元数据（有界 IO；不做 dedup/sha/read ledger）
  if (fileType === 'video') {
    const result = readVideo(path);
    return {
      ...result,
      metadata: {
        path,
        type: fileType,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        ...result.metadata,
      },
    };
  }

  // 大文件策略：>50MB 返回错误 + 提示
  if (stat.size > MAX_FILE_SIZE) {
    return largeFileResult(path, stat.size);
  }

  // Dedup 去重：自上次 read 后未变（mtime/size 校验）则不重复全量返回
  if (filesys.isUnchangedSinceRead(path)) {
    return {
      content: [{ type: 'text', text: t('tools.readFileUnchanged', { path }) }],
      metadata: { path, unchanged: true, sizeBytes: stat.size },
    };
  }

  // 一次读盘全派生：rawBuffer / sha256 / 编码分类（缓存命中则零 I/O）
  const entity = filesys.readFile(path);
  if (!entity) {
    return errorResult(t('tools.readFileNotFound', { path }));
  }

  // 注册 read ledger（read-before-overwrite 校验），sha256 来自 filesys 统一哈希（含 BOM 原始字节）
  if (fileHistory) {
    try {
      fileHistory.markRead(ctx.sessionId, path, entity.sha256);
    } catch {
      // 不影响 read 工具主流程
    }
  }

  // Office 文件：按内容哈希解析产物目录（项目内 <cwd>/.moss/analysis 或全局 ~/.moss/analysis）
  const artifact = fileType === 'office' ? safeArtifactDir(ctx.cwd, entity.sha256) : undefined;

  // 类型分派（text 场景复用已读 buffer，不再二次读盘）
  const result = await dispatchByType(
    path,
    fileType,
    params,
    stat,
    { rawBuffer: entity.rawBuffer, kind: entity.kind },
    artifact,
  );

  // 标记"刚被 read"（dedup 语义，filesys 缓存条目 lastReadAt）
  filesys.touchRead(path);

  // 合并元信息（sha256 暴露给 edit 工具 expectHash 乐观锁）
  return {
    ...result,
    metadata: {
      path,
      type: fileType,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: entity.sha256,
      ...result.metadata,
    },
  };
}

/** 安全创建产物目录（失败返回 undefined → office handler 回退纯文本，绝不报错） */
function safeArtifactDir(cwd: string, sha256: string): ArtifactDir | undefined {
  try {
    return ensureArtifactDir(resolveAnalysisBase(cwd), sha256);
  } catch {
    return undefined;
  }
}

/** 根据文件类型分派到对应 handler */
async function dispatchByType(
  absPath: string,
  fileType: FileType,
  params: ReadParams,
  stat: Stats,
  cached: CachedFileEntity,
  artifact?: ArtifactDir,
): Promise<ToolResult> {
  switch (fileType) {
    case 'image':
      return readImage(absPath);
    case 'video':
      // 正常流程已在 processSingleFile 提前返回；这里作兜底保证分派自洽
      return readVideo(absPath);
    case 'pdf':
      return readPdf(absPath, params.pages);
    case 'office':
      return readOffice(absPath, artifact);
    case 'notebook':
      return readNotebook(absPath);
    case 'ebook':
      return readEbook(absPath);
    case 'text':
    default:
      return readText(absPath, {
        mode: params.mode,
        offset: params.offset,
        limit: params.limit,
      } satisfies TextParams, stat, cached);
  }
}

/** 构造大文件错误结果，附"写个程序"提示 */
function largeFileResult(path: string, size: number): ToolResult {
  const sizeMB = (size / 1024 / 1024).toFixed(2);
  return {
    content: [{
      type: 'text',
      text: `Error: ${t('tools.readTooLarge', { bytes: size, sizeMB, path })}\n\n${t('tools.readTooLargeHint')}`,
    }],
    isError: true,
    metadata: { path, sizeBytes: size, tooLarge: true },
  };
}

/** 构造错误结果 */
function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}
