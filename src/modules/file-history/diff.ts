// src/modules/file-history/diff.ts
// 手写基于 LCS 的行级 unified diff（避免新增 npm 依赖）。
// 输出标准 unified diff 格式，供 write/edit 返回给 LLM 审视改动。
//
// 算法：最长公共子序列（LCS）+ 回溯生成 hunks（带上下文行）。
// 复杂度 O(n*m) 时间和空间，对代码文件（几千行）可接受。
// 大文件（>5000 行）跳过 diff，返回占位提示，避免阻塞。

const MAX_DIFF_LINES = 5000;

/** 快照 diff 的字节上限（新增/删除文件全量快照；超过则不生成，避免 transcript 膨胀） */
const MAX_SNAPSHOT_DIFF_BYTES = 1 * 1024 * 1024;

/** 按行拆分并剔除末尾换行产生的空元素（避免行数多算 1；空内容返回空数组） */
function splitSnapshotLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 新建文件的全量新增 diff（create 条目用）。
 * 不复用 computeLineDiff('', content)：后者会把空 before 拆出一个 '-' 空行，
 * 导致面板统计出现 "−1" 的假删除。
 *
 * @param content 文件内容（文本）
 * @returns unified diff；空文件返回 ''；超过字节/行数上限返回 undefined（调用方不写 diff）
 */
export function computeAddedFileDiff(content: string): string | undefined {
  if (Buffer.byteLength(content, 'utf8') > MAX_SNAPSHOT_DIFF_BYTES) return undefined;
  const lines = splitSnapshotLines(content);
  if (lines.length > MAX_DIFF_LINES) return undefined;
  if (lines.length === 0) return '';
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}\n`;
}

/**
 * 删除文件的全量删除 diff（delete 条目用）。
 *
 * @param content 删除前的文件内容（文本）
 * @returns unified diff；空文件返回 ''；超过字节/行数上限返回 undefined（调用方不写 diff）
 */
export function computeDeletedFileDiff(content: string): string | undefined {
  if (Buffer.byteLength(content, 'utf8') > MAX_SNAPSHOT_DIFF_BYTES) return undefined;
  const lines = splitSnapshotLines(content);
  if (lines.length > MAX_DIFF_LINES) return undefined;
  if (lines.length === 0) return '';
  return `@@ -1,${lines.length} +0,0 @@\n${lines.map(line => `-${line}`).join('\n')}\n`;
}

/**
 * 计算两个字符串的 unified diff。
 * @param before 变更前内容
 * @param after 变更后内容
 * @param contextLines 上下文行数（默认 3）
 * @returns unified diff 文本；若内容相同或超大则返回相应提示
 */
export function computeLineDiff(before: string, after: string, contextLines = 3): string {
  if (before === after) return '';

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  // 大文件保护：超过阈值跳过
  if (beforeLines.length > MAX_DIFF_LINES || afterLines.length > MAX_DIFF_LINES) {
    return `[diff skipped: file too large (>${MAX_DIFF_LINES} lines)]`;
  }

  // 计算 LCS 矩阵
  const lcs = buildLcsTable(beforeLines, afterLines);

  // 回溯生成 diff 行（带 +/- 标记）
  const diffLines = backtrackDiff(beforeLines, afterLines, lcs);

  // 按 hunks 分组（连续的变更 + 上下文）
  const hunks = groupHunks(diffLines, contextLines);

  if (hunks.length === 0) return '';

  // 格式化为 unified diff
  return hunks.map(h => formatHunk(h)).join('\n') + '\n';
}

interface DiffLine {
  type: 'context' | 'add' | 'del';
  content: string;
  oldLineNo: number; // 1-based，del/context 用
  newLineNo: number; // 1-based，add/context 用
}

/** 构建 LCS 动态规划表 */
function buildLcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = a[0..i-1] 与 b[0..j-1] 的 LCS 长度
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}

/** 回溯 LCS 表生成 diff 行序列 */
function backtrackDiff(a: string[], b: string[], dp: number[][]): DiffLine[] {
  const result: DiffLine[] = [];
  let i = a.length;
  let j = b.length;
  let oldLine = a.length;
  let newLine = b.length;

  // 逆序回溯，最后 reverse
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      // 相同行（context）
      result.push({ type: 'context', content: a[i - 1], oldLineNo: oldLine, newLineNo: newLine });
      i--; j--;
      oldLine = i + 1;
      newLine = j + 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      // b 独有（add）
      result.push({ type: 'add', content: b[j - 1], oldLineNo: 0, newLineNo: newLine });
      j--;
      newLine = j + 1;
    } else {
      // a 独有（del）
      result.push({ type: 'del', content: a[i - 1], oldLineNo: oldLine, newLineNo: 0 });
      i--;
      oldLine = i + 1;
    }
  }

  return result.reverse();
}

interface Hunk {
  lines: DiffLine[];
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** 将 diff 行分组为 hunks（连续变更 + 上下文） */
function groupHunks(lines: DiffLine[], context: number): Hunk[] {
  const hunks: Hunk[] = [];
  let currentHunk: DiffLine[] | null = null;
  let changePending = 0; // 距离上次变更的行数

  for (const line of lines) {
    if (line.type !== 'context') {
      // 变更行
      if (!currentHunk) {
        // 新 hunk 开始：回溯 context 行
        currentHunk = [];
      }
      currentHunk.push(line);
      changePending = 0;
    } else {
      // context 行
      if (currentHunk) {
        currentHunk.push(line);
        changePending++;
        // 超过 2*context 行无变更 → 关闭 hunk
        if (changePending > context * 2) {
          // 截断尾部 context（保留 context 行）
          const trimmed = currentHunk.slice(0, currentHunk.length - (changePending - context));
          hunks.push(finalizeHunk(trimmed));
          currentHunk = null;
          changePending = 0;
        }
      }
      // 否则跳过（hunk 外的 context 行不记录）
    }
  }

  // 收尾：最后一个未关闭的 hunk
  if (currentHunk) {
    // 截断尾部多余 context
    let lastChangeIdx = -1;
    for (let k = currentHunk.length - 1; k >= 0; k--) {
      if (currentHunk[k].type !== 'context') {
        lastChangeIdx = k;
        break;
      }
    }
    const trimmed = lastChangeIdx >= 0
      ? currentHunk.slice(0, Math.min(currentHunk.length, lastChangeIdx + 1 + context))
      : currentHunk;
    hunks.push(finalizeHunk(trimmed));
  }

  return hunks;
}

/** 计算 hunk 的行号范围并返回 */
function finalizeHunk(lines: DiffLine[]): Hunk {
  // 找到第一个有效行号
  let oldStart = 0;
  let newStart = 0;
  for (const l of lines) {
    if (oldStart === 0 && l.oldLineNo > 0) oldStart = l.oldLineNo;
    if (newStart === 0 && l.newLineNo > 0) newStart = l.newLineNo;
    if (oldStart > 0 && newStart > 0) break;
  }
  if (oldStart === 0) oldStart = 1;
  if (newStart === 0) newStart = 1;

  const oldCount = lines.filter(l => l.type !== 'add').length;
  const newCount = lines.filter(l => l.type !== 'del').length;

  return { lines, oldStart, oldCount, newStart, newCount };
}

/** 格式化单个 hunk 为 unified diff 文本 */
function formatHunk(h: Hunk): string {
  const header = `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`;
  const body = h.lines.map(l => {
    const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
    return prefix + l.content;
  });
  return [header, ...body].join('\n');
}
