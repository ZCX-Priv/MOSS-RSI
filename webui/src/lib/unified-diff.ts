// webui/src/lib/unified-diff.ts
// unified diff 解析：把后端返回的 unified diff 文本解析成可渲染的 hunk / 行模型。
// 用于「文件变更」面板的 inline diff（双行号 + 折叠未变更区域）。

export interface ParsedDiffLine {
  type: 'context' | 'add' | 'del';
  content: string;
  /** 旧文件行号（add 行为 null） */
  oldNo: number | null;
  /** 新文件行号（del 行为 null） */
  newNo: number | null;
}

export interface ParsedDiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedDiffLine[];
  /** 与本 hunk 之前隐藏的行数（新文件侧；用于「N 行已隐藏」折叠条） */
  skippedBefore: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * 解析 unified diff。
 * 非 unified diff 内容（例如 `[diff skipped: file too large]` 占位）返回空数组，
 * 由调用方显示提示文案。
 */
export function parseUnifiedDiff(diff: string): ParsedDiffHunk[] {
  if (!diff.trim()) return [];
  const hunks: ParsedDiffHunk[] = [];
  let current: ParsedDiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  /** 上一个 hunk 结束后，新文件的下一个行号（1-based） */
  let prevNewEnd = 1;

  for (const line of diff.split('\n')) {
    // 标准 diff 文件头（我们自己的 diff 不输出，但兼容外部输入）
    if (line.startsWith('---') || line.startsWith('+++')) continue;

    if (line.startsWith('@@')) {
      const m = HUNK_HEADER.exec(line);
      if (!m) continue;
      const oldStart = Number(m[1]);
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      current = {
        header: line,
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [],
        skippedBefore: Math.max(0, newStart - prevNewEnd),
      };
      hunks.push(current);
      oldNo = oldStart;
      newNo = newStart;
      prevNewEnd = newStart + newCount;
      continue;
    }

    if (!current) continue; // hunk 之外的说明文本（如 diff skipped 占位）
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"

    if (line.startsWith('+')) {
      current.lines.push({ type: 'add', content: line.slice(1), oldNo: null, newNo });
      newNo++;
    } else if (line.startsWith('-')) {
      current.lines.push({ type: 'del', content: line.slice(1), oldNo, newNo: null });
      oldNo++;
    } else if (line.startsWith(' ')) {
      current.lines.push({ type: 'context', content: line.slice(1), oldNo, newNo });
      oldNo++;
      newNo++;
    }
    // 其余（空行 / 非 diff 文本）跳过
  }

  return hunks;
}
