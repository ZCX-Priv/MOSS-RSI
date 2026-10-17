// src/modules/server/routes/filesystem.ts
// GET  /api/filesystem/suggest-paths      —— 返回常用位置列表（主目录/桌面/文档/下载/图片/音乐/视频/cwd）+ kind
// GET  /api/filesystem/drives             —— 驱动器/卷枚举（前端文件夹选择器「此电脑」视图）
// GET  /api/filesystem/list               —— 列出目录直接子项（前端文件夹选择器 + 文件浏览器）
// GET  /api/filesystem/search-files       —— 递归模糊搜索文件名（# 文件提及菜单）
// POST /api/filesystem/resolve-paths      —— 解析前端已选绝对路径为附件条目并授权父目录
// POST /api/filesystem/save-attachment    —— 粘贴附件落盘（图片/文件）
// GET  /api/filesystem/raw|media|text     —— 只读预览（渲染模块）/ 媒体直链 / 文本提取
// GET/PUT /api/filesys/roots              —— 授权 roots 管理
//
// 目录选择已改为前端选择器（读 drives + list，跨平台、默认磁盘页），不再调用系统原生文件夹对话框。

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { ConfigService, Environment, ServiceRegistry } from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import { readdirSync, existsSync, statSync, statfsSync, openSync, readSync, closeSync, mkdirSync, writeFileSync, readFileSync, lstatSync, type Dirent } from 'node:fs';
import { isAbsolute, join, normalize, extname, dirname, relative, sep } from 'node:path';
import { ErrorCode } from '../../../core/error-codes';
import { SYSTEM_SCOPE } from '../../filesys/roots';
import { decodeTerminalOutput } from '../../../utils/encoding';
import { parseRangeHeader, clampChunk } from './range';
import { RAW_MIME_MAP, MEDIA_EXTS, isTextualExt, extOfFile } from './preview-mime';
import { hashBuffer } from '../../filesys/hash';
import type { FilesysService } from '../../filesys/types';

/** 跳过这些巨型/系统目录，避免遍历爆炸 */
const SKIP_NAMES = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.cache',
  '.npm',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  '.moss',
  'appdata',
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'library', // macOS 系统目录
]);

function isDirectorySafe(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 常用位置类型（前端据此选图标 + i18n 文案） */
export type SuggestPathKind =
  | 'home'
  | 'desktop'
  | 'documents'
  | 'downloads'
  | 'pictures'
  | 'music'
  | 'videos'
  | 'cwd';

export function createSuggestPathsHandler(env: Environment): RouteHandler {
  return async (): Promise<HttpResponse> => {
    const paths: Array<{ path: string; label: string; kind: SuggestPathKind }> = [];
    const tryAdd = (p: string, label: string, kind: SuggestPathKind) => {
      if (isDirectorySafe(p)) paths.push({ path: p, label, kind });
    };
    tryAdd(env.homeDir, '主目录', 'home');
    tryAdd(join(env.homeDir, 'Desktop'), '桌面', 'desktop');
    tryAdd(join(env.homeDir, 'Documents'), '文档', 'documents');
    tryAdd(join(env.homeDir, 'Downloads'), '下载', 'downloads');
    tryAdd(join(env.homeDir, 'Pictures'), '图片', 'pictures');
    tryAdd(join(env.homeDir, 'Music'), '音乐', 'music');
    tryAdd(join(env.homeDir, 'Videos'), '视频', 'videos');
    // Android：内置共享存储（Termux 需先 termux-setup-storage 才有权限）
    if (env.isAndroid) tryAdd('/storage/emulated/0', '内部存储', 'home');
    tryAdd(process.cwd(), '当前目录', 'cwd');
    return { status: 200, body: { paths } };
  };
}

// ============================================================================
// GET /api/filesystem/search-files?dir=<绝对路径>&q=<关键字>
// # 文件提及菜单数据源：
// - q 为空 → 仅列 dir 第一层文件（readdir 单层，毫秒级；菜单打开即出）
// - q 非空 → 递归 BFS 模糊搜索文件名（大小写不敏感；SKIP_NAMES 跳过巨型/系统目录，
//   深度/节点数/时间三重上限防爆炸），上限 50 条
// - 模块级 TTL 缓存（30s / 100 条）：重复输入/重开菜单秒回
// ============================================================================

const SF_MAX_DEPTH = 6;
const SF_MAX_VISIT = 3000;
const SF_TIMEOUT_MS = 1500;
const SF_MAX_RESULTS = 50;
const SF_CACHE_TTL_MS = 30 * 1000;
const SF_CACHE_MAX = 100;

interface SearchedFile {
  path: string;
  name: string;
  dir: string;
  ext: string;
}

/** 结果缓存：key = `${dir}|${q}`（Map 保持插入序，超容量逐出最旧） */
const sfCache = new Map<string, { files: SearchedFile[]; at: number }>();

function sfCacheGet(key: string): SearchedFile[] | null {
  const hit = sfCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SF_CACHE_TTL_MS) {
    sfCache.delete(key);
    return null;
  }
  return hit.files;
}

function sfCacheSet(key: string, files: SearchedFile[]): void {
  if (sfCache.size >= SF_CACHE_MAX) {
    // 逐出最旧（Map 首个 key）
    const oldest = sfCache.keys().next().value;
    if (oldest !== undefined) sfCache.delete(oldest);
  }
  sfCache.set(key, { files, at: Date.now() });
}

/** q 为空：浅层列 dir 第一层文件（按名称排序取前 50） */
function searchShallow(dir: string): SearchedFile[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: SearchedFile[] = entries
    .filter((e) => e.isFile() && !SKIP_NAMES.has(e.name.toLowerCase()))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, SF_MAX_RESULTS)
    .map((e) => ({
      path: join(dir, e.name),
      name: e.name,
      dir,
      ext: extOfFile(e.name),
    }));
  return files;
}

/** q 非空：递归 BFS 模糊搜索 */
function searchRecursive(dir: string, q: string, isWin: boolean): SearchedFile[] {
  const files: SearchedFile[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  const seen = new Set<string>([isWin ? dir.toLowerCase() : dir]);
  const start = Date.now();
  const timedOut = () => Date.now() - start > SF_TIMEOUT_MS;
  let visited = 0;

  while (queue.length > 0 && files.length < SF_MAX_RESULTS && visited < SF_MAX_VISIT && !timedOut()) {
    const { dir: cur, depth } = queue.shift()!;
    visited++;
    let entries: Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (files.length >= SF_MAX_RESULTS || timedOut()) break;
      const full = join(cur, ent.name);
      if (ent.isFile()) {
        if (ent.name.toLowerCase().includes(q)) {
          files.push({
            path: full,
            name: ent.name,
            dir: cur,
            ext: extOfFile(ent.name),
          });
        }
      } else if (ent.isDirectory()) {
        const lower = ent.name.toLowerCase();
        if (SKIP_NAMES.has(lower)) continue;
        const key = isWin ? full.toLowerCase() : full;
        if (seen.has(key)) continue;
        seen.add(key);
        if (depth + 1 < SF_MAX_DEPTH) {
          queue.push({ dir: full, depth: depth + 1 });
        }
      }
    }
  }
  return files;
}

export function createSearchFilesHandler(_env: Environment): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const dir = (req.query.dir ?? '').trim();
    const q = (req.query.q ?? '').trim().toLowerCase();
    if (!dir || !isDirectorySafe(dir)) {
      return { status: 200, body: { files: [] } };
    }

    // 缓存命中直接返回（提及菜单场景容忍秒级陈旧）
    const key = `${dir}|${q}`;
    const cached = sfCacheGet(key);
    if (cached) {
      return { status: 200, body: { files: cached } };
    }

    const files = q ? searchRecursive(dir, q, _env.isWindows) : searchShallow(dir);
    sfCacheSet(key, files);
    return { status: 200, body: { files } };
  };
}

// ============================================================================
// GET /api/filesystem/list?path=<目录>&root=<可选，导航根>&cwd=<可选，默认 __system__>
// 文件浏览器数据源：列出目标目录的直接子项（目录 + 文件），用于右侧面板「文件」标签
// 逐级浏览。权限与 /raw、/text 一致：走 filesys.resolve（roots 越权 / .moss 硬屏蔽 → 403）。
// path 为空时回落到 root（若有）或 cwd 解析结果（__system__ → 系统盘根）。
// 导航边界：传 root 时 path 必须位于 root 内，到达 root 后 parent=null（不能上溯到磁盘根）；
// 首次请求（path/root 均空）以解析结果自身为根，前端据此固定「灰显根前缀」。
// ============================================================================

/** 单次列目录返回的最大条目数（防超大目录撑爆面板） */
const MAX_LIST_ENTRIES = 2000;

interface DirectoryEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  ext: string;
  size: number;
  mtimeMs: number;
}

/** 路径同一化比较（Windows 忽略大小写 + 统一分隔符） */
function samePath(a: string, b: string): boolean {
  const key = (p: string): string => normalize(p).replace(/\\/g, '/').toLowerCase();
  return key(a) === key(b);
}

/**
 * 严格「在根之内」判断（含根自身）。
 * 不复用 utils/fs 的 isPathInside：后者判据为 `rel.startsWith('..' + sep)`，而当目标恰好是
 * 父目录时 path.relative 返回 `'..'`（不含分隔符），会被误判为「在内部」→ 根边界被上溯一级。
 */
function isInsideRoot(target: string, root: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function createListDirectoryHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const rawPath = (req.query.path ?? '').trim();
    const rootParam = (req.query.root ?? '').trim();
    const cwd = (req.query.cwd ?? '').trim() || SYSTEM_SCOPE;

    const filesys = services.tryResolve<FilesysService>(ServiceNames.FILESYS);
    if (!filesys) {
      return { status: 503, body: { error: 'filesys service unavailable' } };
    }

    // 解析导航根（可选）：越权/屏蔽 → 403
    const rootAbs = rootParam ? filesys.resolve(rootParam, cwd) : null;
    if (rootParam && !rootAbs) {
      return { status: 403, body: { error: 'Access denied: root outside allowed roots or blocked' } };
    }

    // 解析目标目录：path 为空时回落到 root（若有）或 cwd 解析结果
    const targetAbs = rawPath ? filesys.resolve(rawPath, cwd) : (rootAbs ?? filesys.resolve('', cwd));
    if (!targetAbs) {
      return { status: 403, body: { error: 'Access denied: path outside allowed roots or blocked' } };
    }

    // 首次请求（无 path 无 root）→ 目标自身即根（把当前工作目录当作根）
    const effectiveRoot = rootAbs ?? (rawPath ? null : targetAbs);

    // 导航边界：目标必须位于根之内
    if (effectiveRoot && !isInsideRoot(targetAbs, effectiveRoot)) {
      return { status: 403, body: { error: 'Path outside root' } };
    }

    let isDir = false;
    try {
      isDir = existsSync(targetAbs) && statSync(targetAbs).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return { status: 404, body: { error: `Not a directory: ${targetAbs}` } };
    }

    let dirents: Dirent[];
    try {
      dirents = readdirSync(targetAbs, { withFileTypes: true });
    } catch (err) {
      return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
    }

    const entries: DirectoryEntry[] = [];
    for (const ent of dirents) {
      if (entries.length >= MAX_LIST_ENTRIES) break;
      const childPath = join(targetAbs, ent.name);
      const isDirectory = ent.isDirectory();
      // 目录 size 恒为 0（不做无谓 stat）；文件取 size/mtime，失败降级为 0
      let size = 0;
      let mtimeMs = 0;
      if (!isDirectory) {
        try {
          const st = statSync(childPath);
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch {
          // 权限/竞态：保持 0，不阻断列表
        }
      }
      entries.push({
        name: ent.name,
        path: childPath,
        kind: isDirectory ? 'directory' : 'file',
        ext: extOfFile(ent.name),
        size,
        mtimeMs,
      });
    }

    // 排序：目录在前、文件在后，各自按名称（大小写不敏感）
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    const truncated = dirents.length > entries.length;

    // parent：到达根 → null（禁止上溯越过根）；否则取上级目录并再次校验不越界
    const parentCandidate = dirname(targetAbs);
    let parent: string | null = parentCandidate === targetAbs ? null : parentCandidate;
    if (parent && effectiveRoot && !isInsideRoot(parent, effectiveRoot)) {
      parent = null;
    }
    if (effectiveRoot && samePath(targetAbs, effectiveRoot)) {
      parent = null;
    }

    return {
      status: 200,
      body: {
        path: targetAbs,
        root: effectiveRoot ?? targetAbs,
        parent,
        entries,
        truncated,
        // 平台路径分隔符：前端据此生成地址栏/相对路径展示（不再硬编码 `\`）
        sep: process.platform === 'win32' ? '\\' : '/',
      },
    };
  };
}

// ============================================================================
// GET /api/filesystem/drives
// 驱动器/卷枚举（文件浏览器「本机」视图数据源）：列出本机盘符/卷/存储入口 + 容量。
// - Windows：遍历 A..Z 探测存在的盘符（C:\ 等），kind='drive'
// - macOS：根 '/'（kind='root'）+ /Volumes 下真实挂载卷（kind='volume'，排除指向 / 的链接）
// - Linux/其它 POSIX：根 '/'（kind='root'）+ /proc/mounts 真实挂载点（kind='volume'）
// - Android：/storage/emulated/0 + /storage 其它卷（kind='storage'）+ 主目录（kind='home'）
// 容量经 statfsSync 计算；运行期不可用/异常时容量置 0（前端隐藏用量条），绝不让接口失败。
// ============================================================================

/** 驱动器/卷条目类型（前端据此选择文案） */
export type DriveKind = 'drive' | 'root' | 'volume' | 'storage' | 'home';

/** 驱动器/卷信息（前端「本机」视图渲染用） */
export interface DriveInfo {
  /** 展示 token：Windows 盘符 'C'；其余平台为卷名/挂载点/主目录路径 */
  letter: string;
  /** 条目类型：drive=Windows 盘符；root=文件系统根；volume=挂载卷；storage=Android 存储；home=主目录 */
  kind: DriveKind;
  /** 驱动器/卷根绝对路径（'C:\' / '/' / '/Volumes/X' / '/storage/emulated/0'） */
  path: string;
  /** 总字节数（0 = 未知） */
  totalBytes: number;
  /** 可用字节数（0 = 未知） */
  freeBytes: number;
}

/** 读取驱动器容量（statfsSync；不可用/失败返回 0） */
function driveCapacity(p: string): { totalBytes: number; freeBytes: number } {
  try {
    if (typeof statfsSync !== 'function') return { totalBytes: 0, freeBytes: 0 };
    const s = statfsSync(p);
    return { totalBytes: s.bsize * s.blocks, freeBytes: s.bsize * s.bavail };
  } catch {
    return { totalBytes: 0, freeBytes: 0 };
  }
}

/** 伪文件系统类型：不作为「本机」卷展示（proc/sysfs/tmpfs/overlay 等） */
const PSEUDO_FS_TYPES = new Set([
  'proc', 'sysfs', 'tmpfs', 'devtmpfs', 'devpts', 'cgroup', 'cgroup2', 'overlay',
  'squashfs', 'autofs', 'mqueue', 'hugetlbfs', 'debugfs', 'tracefs', 'securityfs',
  'pstore', 'bpf', 'configfs', 'fusectl', 'ramfs', 'nsfs', 'rpc_pipefs', 'selinuxfs',
  'efivarfs',
]);

/** 挂载点前缀：系统/临时目录不展示（/run/media 属可移动介质，不在此列） */
const SKIP_MOUNT_PREFIXES = ['/proc', '/sys', '/dev', '/snap'];

/**
 * 解析 /proc/mounts 或 /etc/mtab 文本，返回需展示的真实挂载点（去重、排除 '/'）。
 * 纯函数（可单测）。行格式：device mountpoint fstype options dump pass。
 */
export function parseLinuxMounts(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const mountPoint = parts[1];
    const fstype = parts[2];
    if (!mountPoint || !mountPoint.startsWith('/')) continue;
    if (mountPoint === '/') continue;
    if (PSEUDO_FS_TYPES.has(fstype)) continue;
    if (SKIP_MOUNT_PREFIXES.some((p) => mountPoint === p || mountPoint.startsWith(`${p}/`))) continue;
    const key = mountPoint.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * 从 /Volumes 目录项筛选真实卷：排除符号链接（Macintosh HD 是指向 / 的链接）与非目录。
 * 纯函数（可单测）。
 */
export function selectDarwinVolumes(
  entries: ReadonlyArray<{ name: string; isSymlink: boolean; isDirectory: boolean }>,
): string[] {
  return entries
    .filter((e) => e.isDirectory && !e.isSymlink && e.name.length > 0 && !e.name.startsWith('.'))
    .map((e) => e.name);
}

/** 读取 macOS /Volumes 下真实卷名（IO 失败返回空） */
function listDarwinVolumes(): string[] {
  try {
    if (!isDirectorySafe('/Volumes')) return [];
    const dirents = readdirSync('/Volumes', { withFileTypes: true });
    const entries = dirents.map((d) => {
      const full = join('/Volumes', d.name);
      let isSymlink = false;
      try {
        isSymlink = lstatSync(full).isSymbolicLink();
      } catch {
        isSymlink = false;
      }
      return { name: d.name, isSymlink, isDirectory: isDirectorySafe(full) };
    });
    return selectDarwinVolumes(entries);
  } catch {
    return [];
  }
}

/** 读取 Linux 真实挂载点（/proc/mounts → /etc/mtab；均失败返回空） */
function listLinuxMounts(): string[] {
  for (const file of ['/proc/mounts', '/etc/mtab']) {
    try {
      const text = readFileSync(file, 'utf8');
      const mounts = parseLinuxMounts(text).filter((p) => isDirectorySafe(p));
      if (mounts.length > 0) return mounts;
    } catch {
      // 读取失败：尝试下一个来源
    }
  }
  return [];
}

/** 读取 Android /storage 下除 emulated 外的存储卷名（外置 SD/USB；符号链接由 isDirectory 自动排除） */
function listAndroidVolumes(): string[] {
  const base = '/storage';
  if (!isDirectorySafe(base)) return [];
  try {
    const dirents = readdirSync(base, { withFileTypes: true });
    return dirents
      .filter((d) => d.isDirectory() && d.name !== 'emulated' && d.name !== 'self')
      .map((d) => d.name)
      .filter((name) => isDirectorySafe(join(base, name)));
  } catch {
    return [];
  }
}

export function createListDrivesHandler(env: Environment): RouteHandler {
  return async (): Promise<HttpResponse> => {
    const drives: DriveInfo[] = [];
    if (env.isWindows) {
      for (let code = 65; code <= 90; code++) {
        const letter = String.fromCharCode(code);
        const root = `${letter}:\\`;
        if (!existsSync(root)) continue;
        drives.push({ letter, kind: 'drive', path: root, ...driveCapacity(root) });
      }
    } else if (env.isMac) {
      if (isDirectorySafe('/')) {
        drives.push({ letter: '/', kind: 'root', path: '/', ...driveCapacity('/') });
      }
      for (const name of listDarwinVolumes()) {
        const p = join('/Volumes', name);
        drives.push({ letter: name, kind: 'volume', path: p, ...driveCapacity(p) });
      }
    } else if (env.isAndroid) {
      const internal = '/storage/emulated/0';
      if (isDirectorySafe(internal)) {
        drives.push({ letter: internal, kind: 'storage', path: internal, ...driveCapacity(internal) });
      }
      for (const name of listAndroidVolumes()) {
        const p = join('/storage', name);
        drives.push({ letter: p, kind: 'storage', path: p, ...driveCapacity(p) });
      }
      if (isDirectorySafe(env.homeDir)) {
        drives.push({ letter: env.homeDir, kind: 'home', path: env.homeDir, ...driveCapacity(env.homeDir) });
      }
    } else {
      if (isDirectorySafe('/')) {
        drives.push({ letter: '/', kind: 'root', path: '/', ...driveCapacity('/') });
      }
      for (const mp of listLinuxMounts()) {
        drives.push({ letter: mp, kind: 'volume', path: mp, ...driveCapacity(mp) });
      }
    }
    return { status: 200, body: { drives } };
  };
}

// ============================================================================
// 附件「纯路径引用」路径解析
// 原 pick-file 的系统原生对话框已弃用：改由前端内建选择器选取路径后调用下方接口。
// 文件留在原位，消息仅引用路径，agent 用 filesys 工具读取。
// ============================================================================

// ============================================================================
// POST /api/filesystem/resolve-paths
// 解析前端内建选择器选中的绝对路径（stat 元数据），并把父目录自动授权进 filesys roots。
// 附件"纯路径引用"方案的数据源：文件留在原位，消息仅引用路径，agent 用 filesys 工具读取。
// 自动授权：把每个选中文件的父目录合并进 config.filesys.roots（去重），保证 agent 可读。
// ============================================================================

interface PickedFile {
  path: string;
  name: string;
  size: number;
}

/**
 * 把一组绝对路径解析为附件条目（stat 元数据），并把每个文件的父目录自动授权进
 * config.filesys.roots（去重；已存在的跳过），保证 agent 可读。
 * 非文件 / 不可访问的路径跳过；授权失败不阻断解析结果。
 */
async function resolvePickedPaths(
  env: Environment,
  config: ConfigService,
  paths: string[],
): Promise<{ files: PickedFile[]; grantedRoots: string[] }> {
  if (paths.length === 0) return { files: [], grantedRoots: [] };

  // stat 元数据 + 父目录收集
  const files: PickedFile[] = [];
  const parents = new Set<string>();
  for (const p of paths) {
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      files.push({ path: p, name: basenameOf(p), size: st.size });
      parents.add(dirnameOf(p));
    } catch {
      // 文件消失/不可访问：跳过
    }
  }

  // 自动授权：父目录合并进 filesys roots（去重；已存在的跳过）
  const grantedRoots: string[] = [];
  if (parents.size > 0) {
    try {
      const cfg = config.getAppConfig();
      const existing: string[] = Array.isArray(cfg.filesys?.roots) ? cfg.filesys.roots : [];
      const known = new Set(existing.map((r) => (env.isWindows ? r.toLowerCase() : r)));
      const merged = [...existing];
      for (const parent of parents) {
        if (!isDirectorySafe(parent)) continue;
        const key = env.isWindows ? parent.toLowerCase() : parent;
        if (known.has(key)) continue;
        known.add(key);
        merged.push(normalize(parent));
        grantedRoots.push(parent);
      }
      if (grantedRoots.length > 0) {
        await config.updateAppConfig({ filesys: { roots: merged } } as never);
      }
    } catch {
      // 授权失败不阻断解析结果（agent 读取时由权限体系兜底提示）
    }
  }

  return { files, grantedRoots };
}

export function createResolvePathsHandler(
  env: Environment,
  config: ConfigService,
): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const body = (req.body ?? {}) as { paths?: unknown };
    const raw = body.paths;
    if (!Array.isArray(raw) || raw.some((p) => typeof p !== 'string')) {
      return { status: 400, body: { error: ErrorCode.INVALID_BODY } };
    }
    const paths = raw
      .filter((p): p is string => typeof p === 'string')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const { files, grantedRoots } = await resolvePickedPaths(env, config, paths);
    return { status: 200, body: { files, grantedRoots } };
  };
}

/** 路径 → 文件名（跨平台分隔符） */
function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** 路径 → 父目录（跨平台分隔符；无分隔符返回原路径） */
function dirnameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return idx > 0 ? p.slice(0, idx) : p;
}

// ============================================================================
// POST /api/filesystem/save-attachment
// 粘贴附件落盘（图片/文件）：前端把剪贴板文件读成 base64（dataURL 去前缀）提交，后端写入
// ~/.moss/agent/attachments/ 并返回真实绝对路径。
// 与 resolve-paths 并列，是附件「纯路径引用」体系的另一个数据源：
// 文件本体落盘，消息只引用路径，agent 经 filesys 工具读取。
// 目录选择 ~/.moss/agent/attachments 的原因：.moss 白名单仅放行 agent/mcps/skills，
// 该目录天然可被 agent 读取，无需放宽安全规则。
// 自动授权：把 attachments 目录合并进 config.filesys.roots（去重），保证目录外也可读。
// 单文件体积上限 PASTE_MAX_BYTES（前端同值预校验，此处兜底防绕过）。
// ============================================================================

/** 粘贴附件单文件体积上限（解码后字节数）：25MB */
const PASTE_MAX_BYTES = 25 * 1024 * 1024;

interface SaveAttachmentBody {
  name?: string;
  dataBase64?: string;
}

/** 文件名安全化：去掉路径分隔符与 Windows 非法字符，限长；清洗后为空则回退 fallback */
function sanitizeAttachmentName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[\\/]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\u0000-\u001F]/g, '')
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}

/** 扩展名归一：仅保留 1-5 位字母数字，非法（缺失/过长）回退 bin（图片与任意文件通用） */
function safeAttachmentExt(name: string): string {
  const ext = extname(name).replace(/^\./, '');
  return /^[A-Za-z0-9]{1,5}$/.test(ext) ? ext.toLowerCase() : 'bin';
}

export function createSaveAttachmentHandler(
  env: Environment,
  config: ConfigService,
): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const body = (req.body ?? {}) as SaveAttachmentBody;
    const dataBase64 = body.dataBase64?.trim();
    if (!dataBase64) {
      return { status: 400, body: { error: ErrorCode.FS_ATTACHMENT_DATA_REQUIRED } };
    }
    // 体积上限兜底：base64 长度 ≈ 原始字节 * 4/3，超限直接拒绝（防绕过 + 防内存膨胀）
    if (dataBase64.length > Math.ceil((PASTE_MAX_BYTES * 4) / 3) + 4) {
      return { status: 400, body: { error: ErrorCode.FS_ATTACHMENT_TOO_LARGE } };
    }

    const dir = join(env.dataDir, 'agent', 'attachments');
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return { status: 500, body: { error: ErrorCode.FS_ATTACHMENT_SAVE_FAILED } };
    }

    // 文件名：<清洗后的原名>-<时间戳>-<随机>.<归一扩展名>，既保留可读性又避免覆盖
    const safeName = sanitizeAttachmentName(body.name ?? '', `file-${Date.now()}.bin`);
    const ext = safeAttachmentExt(safeName);
    const stem = sanitizeAttachmentName(safeName.replace(/\.[^.]*$/, ''), 'file').slice(0, 40);
    const fileName = `${stem}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const absPath = join(dir, fileName);

    let size = 0;
    try {
      const buf = Buffer.from(dataBase64, 'base64');
      if (buf.length > PASTE_MAX_BYTES) {
        return { status: 400, body: { error: ErrorCode.FS_ATTACHMENT_TOO_LARGE } };
      }
      writeFileSync(absPath, buf);
      size = buf.length;
    } catch {
      return { status: 500, body: { error: ErrorCode.FS_ATTACHMENT_SAVE_FAILED } };
    }

    // 自动授权：attachments 目录并入 filesys roots（去重；已存在的跳过），与 resolve-paths 一致
    const grantedRoots: string[] = [];
    try {
      const cfg = config.getAppConfig();
      const existing: string[] = Array.isArray(cfg.filesys?.roots) ? cfg.filesys.roots : [];
      const known = new Set(existing.map((r) => (env.isWindows ? r.toLowerCase() : r)));
      const key = env.isWindows ? dir.toLowerCase() : dir;
      if (!known.has(key)) {
        await config.updateAppConfig({ filesys: { roots: [...existing, normalize(dir)] } } as never);
        grantedRoots.push(dir);
      }
    } catch {
      // 授权失败不阻断落盘结果（读取时由权限体系兜底提示）
    }

    return { status: 200, body: { file: { path: absPath, name: fileName, size }, grantedRoots } };
  };
}

// ============================================================================
// POST /api/filesystem/upload
// 文件浏览器「上传」：前端把本机文件读成 base64（dataURL 去前缀）提交，后端写入当前浏览目录。
// 通道与 save-attachment 一致（走 base64 JSON：HTTP 层用 req.text() 读体，无法直接收二进制）。
// 权限：目标目录经 filesys.resolve（cwd 缺省 __system__）→ roots 越权 / .moss 硬屏蔽 → 403。
// 写盘后经 filesys.recordExternalWrite 广播 file-created 事件，前端文件浏览器自动刷新。
// 体积上限 UPLOAD_MAX_BYTES（与 HTTP 层 16MB 请求体上限协同，base64 约放大 4/3）。
// ============================================================================

/** 上传单文件体积上限（解码后字节数）：12MB */
const UPLOAD_MAX_BYTES = 12 * 1024 * 1024;

interface UploadFileBody {
  /** 目标目录绝对路径（必填） */
  dir?: string;
  /** 原始文件名（用于命名与推断扩展名） */
  name?: string;
  /** 文件内容 base64（不含 dataURL 前缀） */
  dataBase64?: string;
  /** 解析 dir 的作用域工作目录（缺省 __system__，与 list 一致） */
  cwd?: string;
  /** 发起上传的会话 id（用于把 file-created 事件投递给该会话的前端，实现列表自动刷新） */
  sessionId?: string;
}

export function createUploadFileHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const body = (req.body ?? {}) as UploadFileBody;
    const rawDir = (body.dir ?? '').trim();
    if (!rawDir) {
      return { status: 400, body: { error: 'dir is required' } };
    }
    const dataBase64 = (body.dataBase64 ?? '').trim();
    if (!dataBase64) {
      return { status: 400, body: { error: ErrorCode.FS_ATTACHMENT_DATA_REQUIRED } };
    }

    const filesys = services.tryResolve<FilesysService>(ServiceNames.FILESYS);
    if (!filesys) {
      return { status: 503, body: { error: 'filesys service unavailable' } };
    }

    const cwd = (body.cwd ?? '').trim() || SYSTEM_SCOPE;
    const dirAbs = filesys.resolve(rawDir, cwd);
    if (!dirAbs) {
      return {
        status: 403,
        body: { error: 'Access denied: target directory outside allowed roots or blocked' },
      };
    }
    if (!isDirectorySafe(dirAbs)) {
      return { status: 404, body: { error: `Not a directory: ${dirAbs}` } };
    }

    // 体积上限兜底：base64 长度 ≈ 原始字节 * 4/3，超限直接拒绝
    if (dataBase64.length > Math.ceil((UPLOAD_MAX_BYTES * 4) / 3) + 4) {
      return { status: 413, body: { error: ErrorCode.FS_ATTACHMENT_TOO_LARGE } };
    }

    // 文件名：清洗原名（去路径分隔符/非法字符），保留归一扩展名
    const safeName = sanitizeAttachmentName(body.name ?? '', `file-${Date.now()}.bin`);
    const ext = safeAttachmentExt(safeName);
    const stem = sanitizeAttachmentName(safeName.replace(/\.[^.]*$/, ''), 'file').slice(0, 60);
    const fileName = `${stem}.${ext}`;
    const absPath = join(dirAbs, fileName);

    // 重名不覆盖：交由前端提示用户改名或另选目录
    if (existsSync(absPath)) {
      return { status: 409, body: { error: 'File already exists', path: absPath } };
    }

    let buf: Buffer;
    let size = 0;
    try {
      buf = Buffer.from(dataBase64, 'base64');
      if (buf.length > UPLOAD_MAX_BYTES) {
        return { status: 413, body: { error: ErrorCode.FS_ATTACHMENT_TOO_LARGE } };
      }
      writeFileSync(absPath, buf);
      size = buf.length;
    } catch {
      return { status: 500, body: { error: 'Failed to write uploaded file' } };
    }

    // 广播 file-created（与 filesys 工具写入同一事件语义），前端文件浏览器自动刷新。
    // 必须带 sessionId：engine.onFilesysChange 对无 sessionId 的事件直接丢弃（不推送到任何会话）。
    const sessionId = (body.sessionId ?? '').trim();
    try {
      filesys.recordExternalWrite(
        absPath,
        { sha256: hashBuffer(buf), bytes: size },
        { source: 'upload', existed: false, ...(sessionId ? { sessionId } : {}) },
      );
    } catch {
      // 事件广播失败不阻断落盘结果
    }

    return { status: 200, body: { file: { path: absPath, name: fileName, size } } };
  };
}

// ============================================================================
// filesys roots 管理（虚拟文件系统的授权目录边界）
// GET  /api/filesys/roots — 读取配置的额外授权目录 + 当前实际生效列表
// PUT  /api/filesys/roots — 设置额外授权目录（写回 config.filesys.roots，热生效）
// ============================================================================

/** GET /api/filesys/roots */
export function createGetRootsHandler(
  services: ServiceRegistry,
): RouteHandler {
  return async (): Promise<HttpResponse> => {
    const filesys = services.tryResolve<{ listRoots(): string[] }>(ServiceNames.FILESYS);
    return {
      status: 200,
      body: {
        effective: filesys ? filesys.listRoots() : [],
      },
    };
  };
}

/** PUT /api/filesys/roots — body: { roots: string[] }（绝对路径数组；cwd 始终隐含，无需包含） */
export function createUpdateRootsHandler(
  services: ServiceRegistry,
  config: ConfigService,
): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const body = req.body as { roots?: unknown } | undefined;
    const raw = body?.roots;
    if (!Array.isArray(raw) || raw.some((r) => typeof r !== 'string')) {
      return { status: 400, body: { error: 'roots (string[]) is required' } };
    }
    // 校验：必须是绝对路径（存在的目录由 filesys.normalizeRoots 在生效时软过滤，这里只挡格式）
    const roots: string[] = [];
    for (const item of raw) {
      const p = String(item).trim();
      if (!p) continue;
      if (!isAbsolute(p)) {
        return { status: 400, body: { error: `root must be an absolute path: ${p}` } };
      }
      roots.push(normalize(p));
    }
    try {
      await config.updateAppConfig({ filesys: { roots } } as never);
      const filesys = services.tryResolve<{ listRoots(): string[] }>(ServiceNames.FILESYS);
      return { status: 200, body: { roots, effective: filesys ? filesys.listRoots() : [] } };
    } catch (err) {
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

// ============================================================================
// GET /api/filesystem/raw?path=<绝对路径>&cwd=<可选，默认 SYSTEM_SCOPE>
// 只读返回文件二进制内容（WebUI 渲染模块预览 docx/pdf/图片/3D 模型等）。
// 走 filesys.resolve 权限体系（与 read 工具同一套边界：roots 越权 / .moss 硬屏蔽 → 403）；
// 扩展名白名单（未知名 415）防止退化为任意文件下载器；支持 HTTP Range（206）流式读取。
// ============================================================================

// 预览扩展名白名单 / MIME / 文本类扩展名 / 媒体扩展名：单一真源见 ./preview-mime.ts
// （该模块为纯模块，便于一致性脚本直接校验「前端可预览扩展名 ⊆ 后端白名单」，防 415 回归）

/** 普通文件（raw）大小上限：100MB */
const RAW_MAX_BYTES = 100 * 1024 * 1024;

/** 单次 Range 响应最多返回的字节数（有界分块，防大文件整读入内存） */
const RAW_CHUNK_BYTES = 8 * 1024 * 1024;

/** 媒体路由「无 Range 请求」时允许整块返回的上限；超过则只返回首块（206） */
const MEDIA_FULL_READ_LIMIT = 64 * 1024 * 1024;

/** 媒体文件（media 路由）大小上限：2GB */
const MEDIA_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** 文本预览单次最多读取的字节数（防止超大文本文件整读进内存） */
const TEXT_READ_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 读取文件头部至多 maxBytes 字节（用于文本预览的 bounded 读取）。
 */
function readHead(absPath: string, maxBytes: number): Buffer {
  const st = statSync(absPath);
  const len = Math.min(st.size, maxBytes);
  const buf = Buffer.alloc(len);
  if (len === 0) return buf;
  const fd = openSync(absPath, 'r');
  try {
    readSync(fd, buf, 0, len, 0);
  } finally {
    closeSync(fd);
  }
  return buf;
}

/** 校验媒体路由的 query token（与 security.authToken 比对；未配置 token 时放行） */
function checkMediaToken(config: ConfigService, req: HttpRequest): boolean {
  const cfg = config.getAppConfig();
  if (!cfg.security.authToken) return true;
  return req.query.token === cfg.security.authToken;
}

/** stat 文件（不存在 / 非常规文件返回 null，避免 statSync 抛错变成 500） */
function statFileSafe(absPath: string): { size: number } | null {
  try {
    const st = statSync(absPath);
    return st.isFile() ? { size: st.size } : null;
  } catch {
    return null;
  }
}

/**
 * 按区间读取文件（端点含），返回字节。
 * 有界：内存占用 = 区间长度（调用方先用 clampChunk 夹紧区间）。
 */
function readByteRange(absPath: string, start: number, end: number): Uint8Array {
  const length = end - start + 1;
  if (length <= 0) return new Uint8Array(0);
  const buf = Buffer.alloc(length);
  const fd = openSync(absPath, 'r');
  try {
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buf, offset, length - offset, start + offset);
      if (read <= 0) break;
      offset += read;
    }
    return new Uint8Array(buf.subarray(0, offset));
  } finally {
    closeSync(fd);
  }
}

export function createReadFileHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const rawPath = (req.query.path ?? '').trim();
    if (!rawPath) {
      return { status: 400, body: { error: 'path is required' } };
    }
    const cwd = (req.query.cwd ?? '').trim() || SYSTEM_SCOPE;

    const filesys = services.tryResolve<FilesysService>(ServiceNames.FILESYS);
    if (!filesys) {
      return { status: 503, body: { error: 'filesys service unavailable' } };
    }

    const absPath = filesys.resolve(rawPath, cwd);
    if (!absPath) {
      return { status: 403, body: { error: 'Access denied: path outside allowed roots or blocked' } };
    }

    const ext = extOfFile(absPath);
    const mime = RAW_MIME_MAP[ext];
    if (!mime) {
      return { status: 415, body: { error: `Unsupported preview type: .${ext || '(none)'}` } };
    }

    const st = statFileSafe(absPath);
    if (!st) {
      return { status: 404, body: { error: 'File not found (or not a regular file)' } };
    }
    if (st.size > RAW_MAX_BYTES) {
      return { status: 413, body: { error: `File too large for preview (limit ${RAW_MAX_BYTES} bytes)` } };
    }

    // HTTP Range：只读所需区间（206，有界分块）。<video>/<audio> 直链由 /api/filesystem/media 提供，
    // 此处 Range 主要服务前端「带头 fetch 的 blob/PDF」与通用客户端。
    const range = parseRangeHeader(req.headers['range'], st.size);
    if (range) {
      const chunk = clampChunk(range, RAW_CHUNK_BYTES);
      return {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Content-Range': `bytes ${chunk.start}-${chunk.end}/${st.size}`,
          'Content-Length': String(chunk.end - chunk.start + 1),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        },
        body: readByteRange(absPath, chunk.start, chunk.end),
      };
    }

    // 无 Range：整块返回（≤ RAW_MAX_BYTES，走 filesys 读取缓存）
    const result = filesys.readFile(absPath);
    if (!result) {
      return { status: 404, body: { error: 'File not found (or not a regular file)' } };
    }
    return {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(result.size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      },
      body: new Uint8Array(result.rawBuffer),
    };
  };
}

// ============================================================================
// GET /api/filesystem/media?path=<绝对路径>&token=<authToken>
// 视频/音频直链：浏览器 <video>/<audio> 无法携带 Authorization 头，故鉴权改走 query token。
// 支持 HTTP Range（206，有界分块）播放与拖动进度；大小上限 2GB。
// 仅允许视频/音频扩展名（防退化为任意文件下载器）。
// ============================================================================

export function createMediaHandler(services: ServiceRegistry, config: ConfigService): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    // query token 鉴权（未配置 token 时放行）
    if (!checkMediaToken(config, req)) {
      return { status: 401, body: { error: 'Unauthorized' } };
    }

    const rawPath = (req.query.path ?? '').trim();
    if (!rawPath) {
      return { status: 400, body: { error: 'path is required' } };
    }
    const cwd = (req.query.cwd ?? '').trim() || SYSTEM_SCOPE;

    const filesys = services.tryResolve<FilesysService>(ServiceNames.FILESYS);
    if (!filesys) {
      return { status: 503, body: { error: 'filesys service unavailable' } };
    }

    const absPath = filesys.resolve(rawPath, cwd);
    if (!absPath) {
      return { status: 403, body: { error: 'Access denied: path outside allowed roots or blocked' } };
    }

    const ext = extOfFile(absPath);
    const mime = RAW_MIME_MAP[ext];
    if (!mime || !MEDIA_EXTS.has(ext)) {
      return { status: 415, body: { error: `Unsupported media type: .${ext || '(none)'}` } };
    }

    const st = statFileSafe(absPath);
    if (!st) {
      return { status: 404, body: { error: 'File not found (or not a regular file)' } };
    }
    if (st.size > MEDIA_MAX_BYTES) {
      return { status: 413, body: { error: `Media too large (limit ${MEDIA_MAX_BYTES} bytes)` } };
    }

    const range = parseRangeHeader(req.headers['range'], st.size);
    if (range) {
      const chunk = clampChunk(range, RAW_CHUNK_BYTES);
      return {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Content-Range': `bytes ${chunk.start}-${chunk.end}/${st.size}`,
          'Content-Length': String(chunk.end - chunk.start + 1),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        },
        body: readByteRange(absPath, chunk.start, chunk.end),
      };
    }

    // 无 Range（裸 GET 下载；浏览器 <video>/<audio> 必然先发 Range）：
    // ≤ MEDIA_FULL_READ_LIMIT 整块返回；超过则只返回首块（206），保证内存有界。
    if (st.size <= MEDIA_FULL_READ_LIMIT) {
      return {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(st.size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        },
        body: readByteRange(absPath, 0, Math.max(0, st.size - 1)),
      };
    }
    const firstChunk = clampChunk({ start: 0, end: st.size - 1 }, RAW_CHUNK_BYTES);
    return {
      status: 206,
      headers: {
        'Content-Type': mime,
        'Content-Range': `bytes ${firstChunk.start}-${firstChunk.end}/${st.size}`,
        'Content-Length': String(firstChunk.end - firstChunk.start + 1),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      },
      body: readByteRange(absPath, firstChunk.start, firstChunk.end),
    };
  };
}

// ============================================================================
// GET /api/filesystem/text?path=<绝对路径>&maxChars=<可选，默认 200000>
// 通用文本提取（后端）：Office/OpenDocument/电子书等「无前端渲染方案」格式的文本回退。
// 复用 read 工具的 handlers（mammoth / word-extractor / xlsx / officeparser / ebook）。
// 返回 { text, truncated }；越权/失败返回错误码。
// ============================================================================

export function createTextExtractHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const rawPath = (req.query.path ?? '').trim();
    if (!rawPath) {
      return { status: 400, body: { error: 'path is required' } };
    }
    const cwd = (req.query.cwd ?? '').trim() || SYSTEM_SCOPE;
    const maxChars = Number(req.query.maxChars ?? 200_000);

    const filesys = services.tryResolve<FilesysService>(ServiceNames.FILESYS);
    if (!filesys) {
      return { status: 503, body: { error: 'filesys service unavailable' } };
    }

    const absPath = filesys.resolve(rawPath, cwd);
    if (!absPath) {
      return { status: 403, body: { error: 'Access denied: path outside allowed roots or blocked' } };
    }

    // 仅接受已知预览类型（防止把任意文件当文本读）
    const ext = extOfFile(absPath);
    if (!(ext in RAW_MIME_MAP)) {
      return { status: 415, body: { error: `Unsupported text extraction type: .${ext || '(none)'}` } };
    }

    // 纯文本类：bounded 头部读取 + 编码检测（UTF-8 / GBK）
    if (isTextualExt(ext)) {
      const st = statFileSafe(absPath);
      if (!st) {
        return { status: 404, body: { error: 'File not found (or not a regular file)' } };
      }
      const headBuf = readHead(absPath, TEXT_READ_MAX_BYTES);
      // 含 NUL 字节 → 实为二进制，拒绝（避免展示乱码）
      if (headBuf.includes(0)) {
        return { status: 415, body: { error: `Not a text file: .${ext}` } };
      }
      let text = decodeTerminalOutput(headBuf);
      let truncated = st.size > TEXT_READ_MAX_BYTES;
      if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        truncated = true;
      }
      return { status: 200, body: { text, truncated } };
    }

    // Office/电子书：复用 read 工具 handlers（懒加载）
    try {
      const { readOffice } = await import('../../tools/read/handlers/office');
      const { readEbook } = await import('../../tools/read/handlers/ebook');
      let result;
      const officeExts = new Set([
        'docx', 'docm', 'dotx', 'doc', 'dot', 'xlsx', 'xlsm', 'xltx', 'xltm', 'xls', 'xlt', 'xlsb',
        'pptx', 'pptm', 'potx', 'ppsx', 'ppt', 'pot', 'odt', 'ods', 'odp', 'ott', 'ots', 'otp', 'rtf',
        // WPS 三族（文字/表格/演示）：与 read 工具 detector 的 office 扩展名集合对齐
        'wps', 'wpt', 'et', 'ett', 'dps', 'dpt',
      ]);
      const ebookExts = new Set(['epub', 'opf', 'mobi', 'azw3', 'azw', 'fb2']);
      if (officeExts.has(ext)) {
        result = await readOffice(absPath);
      } else if (ebookExts.has(ext)) {
        result = await readEbook(absPath);
      } else {
        return { status: 415, body: { error: `Unsupported text extraction type: .${ext}` } };
      }

      const parts = (result.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '');
      let text = parts.join('\n').replace(/^Error: /, '').trim();
      // handler 正常结果首行为「<绝对路径> (EXT)」文件头；仅在该形态下剥离，
      // 避免把「单行错误提示」的唯一一行也剥掉（如 mobi 不支持转换提示）。
      const firstLine = text.split('\n')[0] ?? '';
      if (firstLine.startsWith(absPath)) {
        text = text.slice(firstLine.length).trim();
      }
      const truncated = text.length > maxChars;
      if (truncated) text = text.slice(0, maxChars);
      return { status: 200, body: { text, truncated } };
    } catch (err) {
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}