// src/utils/fs.ts
// 安全文件操作：路径解析、防越权、二进制检测。

import { t } from '../core/i18n';
import { resolve, normalize, isAbsolute, relative, sep, parse, dirname, join } from 'node:path';
import { existsSync, statSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { isValidUtf8, stripBom } from './encoding';
import { readHeadBytes } from './fs-atomic';

/**
 * 解析工作目录下的路径：
 *  - 相对路径基于 cwd 解析
 *  - 绝对路径直接使用
 *  - 返回标准化后的绝对路径
 */
export function resolvePath(path: string, cwd: string): string {
  const base = cwd || process.cwd();
  return isAbsolute(path) ? normalize(path) : normalize(resolve(base, path));
}

/**
 * 确保目录存在（幂等）。
 *
 * 不能直接 `mkdirSync(dir, { recursive: true })`：
 * - Windows 盘符根（如 `C:\`）即使已存在也会抛 `EPERM`；
 * - 并发/竞态下已存在目录也可能抛 `EEXIST`。
 * 因此先 stat 短路；mkdir 后命中 EEXIST/EPERM 时再次 stat，确认是目录即视为成功。
 */
export function ensureDirectory(dir: string): void {
  try {
    if (statSync(dir).isDirectory()) return;
  } catch {
    // 不存在或不可 stat：继续尝试创建
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'EPERM') {
      try {
        if (statSync(dir).isDirectory()) return;
      } catch {
        // stat 仍失败：抛出原始错误
      }
    }
    throw err;
  }
}

/**
 * 路径越权检测：确保 path 在 base 目录内。
 * 返回 true 表示安全（在 base 内或等于 base）。
 */
export function isPathInside(path: string, base: string): boolean {
  const rel = relative(base, path);
  return rel === '' || (!rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/**
 * 更严格的越权检测：返回值用于决定是否允许访问。
 * 允许 base 自身和其下所有子路径；禁止 ../ 跳出。
 */
export function assertPathInside(path: string, base: string): void {
  if (!isPathInside(path, base)) {
    throw new Error(t('fs.pathEscapesBase', { path, base }));
  }
}

/**
 * 解析工作目录下的路径并做严格隔离。
 *  - 相对路径基于 cwd 解析，绝对路径直接使用
 *  - 标准化后必须位于 cwd（含 cwd 自身）之内
 *  - 越出 cwd 返回 null（调用方应拒绝访问）
 */
export function resolveWithinCwd(path: string, cwd: string): string | null {
  const base = cwd || process.cwd();
  const abs = isAbsolute(path) ? normalize(path) : normalize(resolve(base, path));
  if (!isPathInside(abs, base)) return null;
  return abs;
}

/**
 * 文件内容分类（用于 read 工具的编码/二进制判定）。
 * - 'utf8'：合法 UTF-8 文本（含纯 ASCII、中文等多字节字符）
 * - 'legacy-text'：非 UTF-8 但不含 NUL 字节 —— GBK 等传统编码文本的候选，
 *   可安全尝试 GBK 回退解码（真正的 GBK 文本不含 NUL）
 * - 'binary'：含 NUL 字节的二进制 —— 强信号，禁止任何编码回退解码，
 *   否则 OLE/ZIP 等二进制经 GBK 随机解出汉字会被误判为文本（乱码根源）
 */
export type FileContentKind = 'utf8' | 'legacy-text' | 'binary';

/**
 * 读取文件前 8KB 采样并分类内容类型。
 * 分类依据（第一性原理）：
 * 1. NUL 字节是二进制的强信号，任何真实编码的文本文件都不会包含 NUL
 * 2. 合法 UTF-8 视为文本（旧版 30% 非可打印比例阈值会误判纯中文 UTF-8，
 *    中文字节全在 0x80-0xff，比例轻松超 60%，故用严格 UTF-8 字节级验证）
 * 3. 无 NUL 的非 UTF-8 才有资格做 GBK 回退
 */
export function classifyFileContent(path: string, sampleSize = 8192): FileContentKind {
  // head 采样：避免为分类而全量读取大文件（50MB 文件旧实现整读一次）
  return classifyBufferHead(readHeadBytes(path, sampleSize));
}

/**
 * 对文件头部采样 Buffer 做内容分类（纯函数，统一 read/grep/glob 的二进制判定）。
 * 与 classifyFileContent 共用同一套判定逻辑，消除"两套二进制检测"的割裂。
 */
export function classifyBufferHead(sample: Buffer): FileContentKind {
  if (sample.length === 0) return 'utf8';
  if (sample.includes(0)) return 'binary';
  return isValidUtf8(sample) ? 'utf8' : 'legacy-text';
}

/**
 * 读取文件前 N 行，带行号。
 */
export function readLinesWithNumbers(
  path: string,
  offset = 1,
  limit = 2000,
): { text: string; totalLines: number; returnedLines: number } {
  // 读取后剥离 UTF-8 BOM，避免第一行行号后出现不可见字符 \uFEFF
  const content = stripBom(readFileSync(path, 'utf8'));
  const allLines = content.split('\n');
  const totalLines = allLines.length;
  const start = Math.max(0, offset - 1);
  const end = Math.min(allLines.length, start + limit);
  const slice = allLines.slice(start, end);
  const maxLineNumWidth = String(end).length;
  const text = slice
    .map((line, idx) => {
      const lineNum = String(start + idx + 1).padStart(maxLineNumWidth, ' ');
      return `${lineNum}→${line}`;
    })
    .join('\n');
  return { text, totalLines, returnedLines: slice.length };
}

/**
 * 解析 symlink 到真实路径；解析失败（如目标已删除）回退到原路径。
 * 用于 symlink 遍历防护：cwd 内 symlink 若指向 cwd 外，realpath 会暴露真实位置。
 */
export function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 检测路径是否为驱动器根或文件系统根。
 * Windows 如 C:\、D:\；POSIX 如 /。
 * 用于 Windows 路径折叠防护：拒绝删除根级路径，防止 rmdir /s /q 灾难。
 */
export function isRootPath(p: string): boolean {
  const normalized = normalize(p);
  // POSIX 根
  if (normalized === sep) return true;
  // Windows 驱动器根：C:\、D:\ 等（parse 后 dir === root 且 base 为空）
  const { root, dir, base } = parse(normalized);
  return root !== '' && dir === root && base === '';
}

/**
 * 写文件失败 → 人类可读错误。
 * Windows 盘符根的 ACL 通常只授予 Authenticated Users「创建子目录」（AD），
 * 不授予「创建文件」（WD）：普通权限进程无法在 C:\ 根直接落文件。
 * 这里把系统 EPERM 转换成可行动提示，避免用户误以为 MOSS 自己限制了路径。
 */
export function explainFsWriteError(err: unknown, absPath: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException)?.code;
  const dir = dirname(absPath);
  if ((code === 'EPERM' || code === 'EACCES') && isRootPath(dir)) {
    return t('fs.driveRootWriteDenied', { dir });
  }
  return message;
}

const VCS_MARKERS = ['.git', '.svn', '.hg'];

/**
 * 检测路径本身或其任一祖先目录是否含 VCS 标记目录（.git/.svn/.hg）。
 * 用于 dev vault 防护：拒绝删除版本控制仓库根目录，防止误删项目仓库。
 */
export function containsVcsMarker(absPath: string): boolean {
  let current = normalize(absPath);
  let prev = '';
  while (current !== prev) {
    for (const marker of VCS_MARKERS) {
      if (existsSync(join(current, marker))) return true;
    }
    prev = current;
    current = dirname(current);
  }
  return false;
}

export function fileStats(path: string): { size: number; isDir: boolean; mtime: Date } | null {
  try {
    const s = statSync(path);
    return { size: s.size, isDir: s.isDirectory(), mtime: s.mtime };
  } catch {
    return null;
  }
}

export { existsSync };
