// read/shared/analysis-dir.ts
// read 工具对 Office 文件的解析产物目录管理。
//
// 目录规则（用户确认）：
//   - 项目模式（cwd 为真实项目目录）→ <cwd>/.moss/analysis/<sha256>/
//   - 本机模式（cwd = __system__ 或空）→ ~/.moss/analysis/<sha256>/
// 每个被解析的文件按其内容 sha256 建一个文件夹（幂等：content.md 已存在即复用），
// 内含 content.md（Markdown）+ assets/（抽取的图片/视频本体）+ meta.json（来源记录）。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';
import { SYSTEM_SCOPE } from '../../../filesys/roots';

/** 解析产物解析结果（一个文件对应一个哈希目录） */
export interface ArtifactDir {
  /** 哈希目录绝对路径 */
  root: string;
  /** assets 子目录（图片/视频本体） */
  assetsDir: string;
  /** Markdown 文件路径（content.md） */
  markdownPath: string;
  /** meta.json 路径 */
  metaPath: string;
  /** content.md 是否已存在（true = 命中缓存，直接复用，无需重新转换） */
  exists: boolean;
}

/**
 * 解析产物基目录。
 * cwd 为空或为系统作用域哨兵（本机模式）→ 全局 ~/.moss/analysis；
 * 否则落项目内 <cwd>/.moss/analysis。
 */
export function resolveAnalysisBase(cwd: string): string {
  const isSystemScope = !cwd || cwd === SYSTEM_SCOPE;
  if (isSystemScope) return join(homedir(), '.moss', 'analysis');
  return join(cwd, '.moss', 'analysis');
}

/**
 * 确保哈希目录与 assets 子目录存在，返回各路径。
 * 已存在 content.md 时 exists=true（调用方据此跳过重复转换）。
 */
export function ensureArtifactDir(base: string, sha256: string): ArtifactDir {
  const root = join(base, sha256);
  const assetsDir = join(root, 'assets');
  const markdownPath = join(root, 'content.md');
  const metaPath = join(root, 'meta.json');
  const exists = existsSync(markdownPath);
  mkdirSync(assetsDir, { recursive: true });
  return { root, assetsDir, markdownPath, metaPath, exists };
}

/** 写 content.md（Markdown 产物；返回是否成功） */
export function writeArtifactMarkdown(artifact: ArtifactDir, markdown: string): boolean {
  try {
    writeFileSync(artifact.markdownPath, markdown, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 读 content.md（复用已有产物；失败返回 null） */
export function readArtifactMarkdown(artifact: ArtifactDir): string | null {
  try {
    return readFileSync(artifact.markdownPath, 'utf8');
  } catch {
    return null;
  }
}

/** 统计 assets 目录下图片/视频文件数量 */
export function countArtifactAssets(assetsDir: string): { images: number; videos: number } {
  let images = 0;
  let videos = 0;
  try {
    for (const name of readdirSync(assetsDir)) {
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
      if (!ext || ext === name.toLowerCase()) continue; // 无扩展名
      if (VIDEO_ASSET_EXTS.has(ext)) videos++;
      else if (IMAGE_ASSET_EXTS.has(ext)) images++;
    }
  } catch {
    // 目录不可读：返回 0
  }
  return { images, videos };
}

/** 产物中视为「视频」的扩展名（与 handlers/video.ts 语义一致，不含 ts 播放列表） */
const VIDEO_ASSET_EXTS = new Set([
  'mp4', 'm4v', 'mov', 'qt', 'avi', 'wmv', 'asf', 'mkv', 'webm', 'flv', '3gp', '3g2', 'mpeg', 'mpg', 'ogv', 'rmvb',
]);

/** 产物中视为「图片」的扩展名 */
const IMAGE_ASSET_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'apng', 'tiff', 'tif', 'heic', 'heif',
  'emf', 'wmf', 'pbm', 'pgm', 'ppm', 'pnm', 'jp2', 'tga',
]);

/** 写 meta.json（来源路径/哈希/类型/时间；失败静默，不影响主流程） */
export function writeArtifactMeta(
  artifact: ArtifactDir,
  meta: { sourcePath: string; sha256: string; type: string; extra?: Record<string, unknown> },
): void {
  try {
    writeFileSync(
      artifact.metaPath,
      JSON.stringify(
        {
          sourcePath: normalize(meta.sourcePath),
          sha256: meta.sha256,
          type: meta.type,
          createdAt: new Date().toISOString(),
          ...meta.extra,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    // 写失败不阻断（只读目录等极端场景仍可内存返回）
  }
}
