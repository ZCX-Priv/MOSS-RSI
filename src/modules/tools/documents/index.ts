// src/modules/tools/documents/index.ts
// documents 工具：检索 agent/documents 能力最佳实践文档库（list/search/read，只读）。
// 文档根优先 ~/.moss/agent/documents（用户可增改），缺失时回退包内 agent/documents。
// 直接读数据目录，不受工作目录 roots 限制；所有路径限制在文档根内。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { t } from '../../../core/i18n';
import type { Environment } from '../../../core/types';
import type { ToolContext, ToolResult } from '../types';

interface DocumentsParams {
  action?: string;
  topic?: string;
  query?: string;
  path?: string;
}

/** 单次 search 的命中/文件上限 */
const MAX_SEARCH_MATCHES = 40;
const MAX_SEARCH_FILES = 20;
/** read 单次返回的字符上限 */
const MAX_READ_CHARS = 200_000;

function textResult(text: string, metadata?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(metadata ? { metadata } : {}),
  };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** 剥离 UTF-8 BOM */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 文档根：用户数据目录优先，包内目录兜底 */
function resolveDocumentsRoot(env: Environment): string | null {
  const candidates = [
    join(env.dataDir, 'agent', 'documents'),
    ...(typeof env.packageRoot === 'string' && env.packageRoot !== ''
      ? [join(env.packageRoot, 'agent', 'documents')]
      : []),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null;
}

/** 归一化相对路径：拒绝绝对路径、空段与 ../ 越界 */
function normalizeRelative(raw: string): string | null {
  if (isAbsolute(raw)) return null;
  const normalized = raw.replace(/\\/g, '/').trim();
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

/** 递归收集 .md 文件（跳过隐藏项）；topic 为空时扫描整个文档根 */
function listMarkdownFiles(root: string, topic?: string): string[] {
  const base = topic ? resolve(root, ...topic.split('/')) : root;
  const relBase = relative(root, base).replace(/\\/g, '/');
  if (relBase.startsWith('..') || isAbsolute(relBase)) return [];

  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (st.isFile() && name.toLowerCase().endsWith('.md')) out.push(full);
      } catch {
        // 单文件失败忽略
      }
    }
  };
  walk(base);
  return out.sort();
}

/** 读取首个一级标题作为文档说明 */
function firstHeading(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^#\s+(.+)$/.exec(line.trim());
    if (match) return match[1].trim();
  }
  return null;
}

/** 相对文档根的 posix 路径 */
function toRelative(root: string, file: string): string {
  return relative(root, file).replace(/\\/g, '/');
}

function runList(root: string, p: DocumentsParams): ToolResult {
  let topic: string | undefined;
  if (p.topic !== undefined && String(p.topic).trim() !== '') {
    const normalized = normalizeRelative(String(p.topic));
    if (!normalized) return errorResult(t('tools.documentsPathInvalid', { path: String(p.topic) }));
    topic = normalized;
  }

  const files = listMarkdownFiles(root, topic);
  if (files.length === 0) return errorResult(t('tools.documentsEmpty'));

  const lines = files.map((file) => {
    const rel = toRelative(root, file);
    let title: string | null = null;
    try {
      title = firstHeading(stripBom(readFileSync(file, 'utf8')));
    } catch {
      // 标题读取失败只显示路径
    }
    return `- ${rel}${title ? ` — ${title}` : ''}`;
  });

  return textResult(
    `${t('tools.documentsListHeader', { count: files.length })}:\n${lines.join('\n')}`,
    { action: 'list', count: files.length, ...(topic ? { topic } : {}) },
  );
}

function runSearch(root: string, p: DocumentsParams): ToolResult {
  const query = typeof p.query === 'string' ? p.query.trim() : '';
  if (!query) return errorResult(t('tools.documentsQueryRequired'));

  const needle = query.toLowerCase();
  const files = listMarkdownFiles(root);
  const matches: string[] = [];
  let matchedFiles = 0;
  let truncated = false;

  outer: for (const file of files) {
    let text: string;
    try {
      text = stripBom(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    let fileMatched = false;
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].toLowerCase().includes(needle)) continue;
      if (!fileMatched) {
        if (matchedFiles >= MAX_SEARCH_FILES) {
          truncated = true;
          break outer;
        }
        matchedFiles += 1;
        fileMatched = true;
      }
      const trimmed = lines[index].trim();
      matches.push(
        `${toRelative(root, file)}:${index + 1}: ${trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed}`,
      );
      if (matches.length >= MAX_SEARCH_MATCHES) {
        truncated = true;
        break outer;
      }
    }
  }

  if (matches.length === 0) {
    return errorResult(t('tools.documentsNoMatches', { query }));
  }

  const suffix = truncated ? `\n\n${t('tools.documentsSearchTruncated')}` : '';
  return textResult(
    `${t('tools.documentsSearchHeader', { query, count: matches.length, files: matchedFiles })}:\n${matches.join('\n')}${suffix}`,
    { action: 'search', query, count: matches.length, files: matchedFiles, truncated },
  );
}

function runRead(root: string, p: DocumentsParams): ToolResult {
  const rawPath = typeof p.path === 'string' ? p.path.trim() : '';
  if (!rawPath) return errorResult(t('tools.documentsPathRequired'));

  const rel = normalizeRelative(rawPath);
  if (!rel || !rel.toLowerCase().endsWith('.md')) {
    return errorResult(t('tools.documentsPathInvalid', { path: rawPath }));
  }

  const abs = resolve(root, ...rel.split('/'));
  const relCheck = relative(root, abs).replace(/\\/g, '/');
  if (!relCheck || relCheck.startsWith('..') || isAbsolute(relCheck)) {
    return errorResult(t('tools.documentsPathInvalid', { path: rawPath }));
  }
  if (!existsSync(abs)) {
    return errorResult(t('tools.documentsNotFound', { path: rel }));
  }

  let text: string;
  try {
    text = stripBom(readFileSync(abs, 'utf8'));
  } catch {
    return errorResult(t('tools.documentsNotFound', { path: rel }));
  }

  let truncated = false;
  if (text.length > MAX_READ_CHARS) {
    text = `${text.slice(0, MAX_READ_CHARS)}\n\n${t('tools.documentsReadTruncated', { max: String(MAX_READ_CHARS) })}`;
    truncated = true;
  }

  return textResult(text, { action: 'read', path: rel, chars: text.length, truncated });
}

export default function createExecute(env: Environment) {
  return {
    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const p = (params ?? {}) as DocumentsParams;
      const action = typeof p.action === 'string' ? p.action : '';
      if (action !== 'list' && action !== 'search' && action !== 'read') {
        return errorResult(t('tools.documentsActionRequired'));
      }

      const root = resolveDocumentsRoot(env);
      if (!root) return errorResult(t('tools.documentsRootUnavailable'));

      switch (action) {
        case 'list':
          return runList(root, p);
        case 'search':
          return runSearch(root, p);
        case 'read':
          return runRead(root, p);
        default:
          return errorResult(t('tools.documentsActionRequired'));
      }
    },
  };
}
