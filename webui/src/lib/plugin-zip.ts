// webui/src/lib/plugin-zip.ts
// 插件 zip 扫描器：递归自动发现技能（SKILL.md）与 MCP 配置（JSON）。
//
// 规则：
//  - 支持多层级目录；每个技能文件归属「最长匹配」的技能根（父技能不吞子技能文件）
//  - 技能名规范化为 ^[a-z][a-z0-9-]*$，并改写 SKILL.md frontmatter 的 name
//  - MCP 配置兼容 mcpServers/servers 包裹、ServerConfig 单定义、name→定义 映射
//  - 安全：拒绝绝对路径 / .. / NUL / 隐藏目录；限制条目数与读取体积

import JSZip from 'jszip';
import { parseMcpJsonInput, type ParsedMcpDef } from './mcp-json';

/** 文本扩展名白名单：白名单内以 utf8 文本传输，其余走 base64 */
export const TEXT_EXT_RE =
  /\.(md|markdown|txt|json|js|mjs|cjs|ts|tsx|jsx|py|sh|bat|ps1|yml|yaml|toml|csv|html|css|xml|svg)$/i;

const MAX_ENTRIES = 2000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 1 * 1024 * 1024;
const MAX_PATH_LENGTH = 512;

export interface ZipSkillFile {
  path: string;
  content?: string;
  base64?: string;
}

export interface ZipSkillCandidate {
  kind: 'skill';
  name: string;
  description: string;
  /** zip 内 SKILL.md 路径（展示/排错） */
  sourcePath: string;
  /** 相对技能根的文件列表 */
  files: ZipSkillFile[];
}

export interface ZipMcpCandidate extends ParsedMcpDef {
  kind: 'mcp';
  sourcePath: string;
}

export interface ZipScanResult {
  skills: ZipSkillCandidate[];
  mcps: ZipMcpCandidate[];
  warnings: string[];
}

/** Uint8Array → base64（分块避免 String.fromCharCode 栈溢出） */
export function u8ToBase64(u8: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

/** 路径安全：相对、无 .. / 隐藏段 / NUL，长度受限 */
function isSafePath(path: string): boolean {
  if (path === '' || path.length > MAX_PATH_LENGTH || path.includes('\0')) return false;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  const segs = path.split('/');
  return !segs.some(
    (seg) => seg === '' || seg === '..' || seg.startsWith('.') || seg === '__MACOSX',
  );
}

/** 读取 YAML frontmatter 的顶层标量字段（去引号） */
function readFrontMatterField(markdown: string, key: string): string {
  const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? '';
  const matched = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm').exec(fm)?.[1]?.trim() ?? '';
  return matched.replace(/^["']|["']$/g, '');
}

/** 改写 SKILL.md frontmatter 的 name；无 frontmatter name 时补一行 */
function rewriteSkillName(markdown: string, name: string): string {
  if (!/^---\s*\r?\n/.test(markdown)) return markdown;
  const fmEnd = markdown.indexOf('\n---', 4);
  if (fmEnd < 0) return markdown;
  const head = markdown.slice(0, fmEnd);
  const tail = markdown.slice(fmEnd);
  const nameLine = /^name\s*:\s*.*$/m;
  if (nameLine.test(head)) return head.replace(nameLine, `name: ${name}`) + tail;
  return `${head}\nname: ${name}${tail}`;
}

/** 任意名称 → 技能名（小写、非法字符转 -、数字开头补 skill-） */
export function normalizeSkillName(raw: string): string {
  const n = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (n === '') return 'skill';
  return /^[a-z]/.test(n) ? n : `skill-${n}`;
}

/** 任意名称 → MCP 服务器名（保留后端允许的字符集） */
function normalizeMcpName(raw: string): string {
  const n = raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return n === '' ? 'mcp-server' : n;
}

/** 集合内重名：追加 -2、-3… */
function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (used.has(`${base}-${index}`)) index += 1;
  const name = `${base}-${index}`;
  used.add(name);
  return name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 是否像 MCP 配置（避免把 package.json / tsconfig.json 等误认为服务器定义） */
function looksLikeMcpConfig(raw: unknown, defCount: number, basename: string): boolean {
  if (defCount === 0) return false;
  const rec = isRecord(raw) ? raw : null;
  const wrapped = rec !== null && ('mcpServers' in rec || 'servers' in rec);
  const explicit =
    rec !== null &&
    (typeof rec.transport === 'string' || typeof rec.type === 'string') &&
    (typeof rec.command === 'string' || typeof rec.url === 'string');
  const named = /mcp/i.test(basename);
  return wrapped || explicit || named;
}

/** 体积超限必须冒泡给调用方，不能降级成单文件跳过 */
function rethrowLimit(err: unknown): void {
  if (err instanceof Error && err.message === 'ZIP_TOO_LARGE') throw err;
}

/**
 * 扫描 zip：返回可导入的技能与 MCP 服务器候选（保持 zip 内顺序）。
 * 解析失败抛出 `Error('ZIP_INVALID')`；超限抛出 `Error('ZIP_TOO_LARGE')`。
 */
export async function scanPluginZip(file: File): Promise<ZipScanResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error('ZIP_INVALID');
  }

  const allPaths = Object.keys(zip.files).filter((path) => !zip.files[path].dir);
  if (allPaths.length > MAX_ENTRIES) throw new Error('ZIP_TOO_LARGE');

  const entries = allPaths.map((path) => path.replace(/\\/g, '/')).filter(isSafePath);
  const warnings: string[] = [];
  let readBytes = 0;

  /** 读取单个条目并累计体积（超限抛出 ZIP_TOO_LARGE） */
  const readBytesOf = async (path: string): Promise<Uint8Array> => {
    const data = await zip.files[path].async('uint8array');
    if (data.byteLength > MAX_FILE_BYTES) throw new Error('ZIP_TOO_LARGE');
    readBytes += data.byteLength;
    if (readBytes > MAX_TOTAL_BYTES) throw new Error('ZIP_TOO_LARGE');
    return data;
  };
  const readText = async (path: string): Promise<string> =>
    new TextDecoder('utf-8').decode(await readBytesOf(path));

  // ---- 技能根发现（SKILL.md 所在目录） ----
  const skillMdPaths = entries.filter(
    (path) => (path.split('/').pop() ?? '').toLowerCase() === 'skill.md',
  );
  /** 技能根 → 实际 SKILL.md 路径（zip 内文件名大小写敏感，不能凭根拼回） */
  const skillMdByRoot = new Map<string, string>();
  for (const path of skillMdPaths) {
    skillMdByRoot.set(path.split('/').slice(0, -1).join('/'), path);
  }
  const roots = [...skillMdByRoot.keys()].sort(
    (a, b) => a.split('/').length - b.split('/').length,
  );

  /** 文件归属的技能根：最长匹配（'' = zip 根） */
  const ownerRootOf = (path: string): string | null => {
    let owner: string | null = null;
    for (const root of roots) {
      const matched = root === '' ? true : path === root || path.startsWith(`${root}/`);
      if (matched && (owner === null || root.length > owner.length)) owner = root;
    }
    return owner;
  };

  const usedSkillNames = new Set<string>();
  const skills: ZipSkillCandidate[] = [];
  for (const root of roots) {
    const skillMdPath = skillMdByRoot.get(root) ?? (root === '' ? 'SKILL.md' : `${root}/SKILL.md`);
    let markdown: string;
    try {
      markdown = await readText(skillMdPath);
    } catch {
      warnings.push(`SKILL.md unreadable: ${skillMdPath}`);
      continue;
    }
    const dirName = root === '' ? file.name.replace(/\.zip$/i, '') : (root.split('/').pop() ?? '');
    const fmName = readFrontMatterField(markdown, 'name');
    const base = normalizeSkillName(fmName || dirName);
    const name = uniqueName(base, usedSkillNames);
    const description = readFrontMatterField(markdown, 'description');

    const files: ZipSkillFile[] = [];
    for (const path of entries) {
      if (ownerRootOf(path) !== root) continue;
      const rel = root === '' ? path : path.slice(root.length + 1);
      if (rel === '') continue;
      if (rel.toLowerCase() === 'skill.md') {
        files.push({ path: 'SKILL.md', content: rewriteSkillName(markdown, name) });
        continue;
      }
      if (!isSafePath(rel)) continue;
      if (TEXT_EXT_RE.test(rel)) {
        try {
          files.push({ path: rel, content: await readText(path) });
        } catch (err) {
          rethrowLimit(err);
          warnings.push(`Skipped unreadable file: ${path}`);
        }
      } else {
        try {
          files.push({ path: rel, base64: u8ToBase64(await readBytesOf(path)) });
        } catch (err) {
          rethrowLimit(err);
          warnings.push(`Skipped unreadable file: ${path}`);
        }
      }
    }
    skills.push({ kind: 'skill', name, description, sourcePath: skillMdPath, files });
  }

  // ---- MCP 配置发现（排除非根技能目录内的文件，避免把技能自带示例配置误装） ----
  const usedMcpNames = new Set<string>();
  const mcps: ZipMcpCandidate[] = [];
  for (const path of entries) {
    if (!path.toLowerCase().endsWith('.json')) continue;
    const owner = ownerRootOf(path);
    if (owner !== null && owner !== '') continue;
    const raw = await readBytesOf(path).catch((err: unknown) => {
      rethrowLimit(err);
      return null;
    });
    if (raw === null || raw.byteLength > MAX_JSON_BYTES) continue;
    const text = new TextDecoder('utf-8').decode(raw);
    let parsed: unknown;
    let defs: ParsedMcpDef[];
    try {
      parsed = JSON.parse(text);
      defs = parseMcpJsonInput(text);
    } catch {
      continue;
    }
    const basename = path.split('/').pop() ?? '';
    if (!looksLikeMcpConfig(parsed, defs.length, basename)) continue;
    for (const def of defs) {
      const name = normalizeMcpName(def.name);
      if (usedMcpNames.has(name)) {
        warnings.push(`Duplicate MCP server skipped: ${name} (${path})`);
        continue;
      }
      usedMcpNames.add(name);
      mcps.push({ ...def, name, kind: 'mcp', sourcePath: path });
    }
  }

  return { skills, mcps, warnings };
}
