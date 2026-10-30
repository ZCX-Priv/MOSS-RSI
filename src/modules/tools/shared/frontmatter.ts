// src/modules/tools/shared/frontmatter.ts
// 统一的 YAML front-matter 解析器（skills.ts 与 specs.ts 共享，消除重复实现）。
// 简易 YAML 子集：支持 `key: value`、`key: >`（折叠多行）、`key: |`（保留换行的多行）。
// 不引入额外依赖（js-yaml 等）。

export interface ParsedFrontMatter {
  [key: string]: unknown;
}

/**
 * 解析 `--- ... ---` front-matter 与 Markdown body。
 * 无 front-matter 时返回空对象 + 原文作为 body。
 */
export function splitFrontMatter(
  raw: string,
): { frontMatter: ParsedFrontMatter; body: string } {
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { frontMatter: {}, body: raw };
  }
  const fmText = fmMatch[1];
  const body = fmMatch[2] ?? '';
  const fm: ParsedFrontMatter = {};
  const lines = fmText.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 跳过空行与注释
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    let value = m[2];
    if (value.trim() === '>' || value.trim() === '|') {
      // 折叠多行：`>` 空格连接；`|` 换行保留
      const folded: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        // 缩进 2 空格视为续行
        if (next.startsWith('  ') || next.startsWith('\t')) {
          folded.push(next.replace(/^  /, ''));
          i++;
        } else {
          break;
        }
      }
      value =
        value.trim() === '>'
          ? folded.join(' ').trim()
          : folded.join('\n').trim();
    } else {
      i++;
    }
    // 去除字符串两端引号
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return { frontMatter: fm, body };
}
