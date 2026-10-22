// src/modules/terminal/output-digest.ts
// 终端输出精简（发给模型的内容）——借鉴 l0-compressor / @linger-alpha/cca 的成熟规则：
//   1) 归一化：进度条按 `\r` 覆盖取最终帧、退格回退、去 BEL/NUL 等 C0 控制符；
//   2) 压缩连续空行、折叠连续相同行（×N）；
//   3) 受保护块（Traceback / Error / FAIL / Exception / 栈帧 / 编译错误）连同上下文无损保留；
//   4) 超长时保留头尾窗口 + 保护块，中间以「省略 N 行」标记；
//   5) 成功且无错误信号时进一步收紧尾部。
// 完整原文由调用方落盘（output-store），模型可按 ref 读取——本模块只负责「精简摘要」。

import { stripAnsi } from './clean-output';

/** 精简选项 */
export interface DigestOptions {
  /** 命令退出码（0 且无错误信号时使用更激进的裁剪） */
  exitCode?: number;
  /** 摘要最大字符数（默认 60k） */
  maxChars?: number;
}

/** 精简统计 */
export interface DigestStats {
  /** 原始总行数 */
  totalLines: number;
  /** 原始总字符数 */
  totalChars: number;
  /** 摘要行数 */
  shownLines: number;
  /** 被省略的行数 */
  omittedLines: number;
  /** 被折叠的重复行数 */
  collapsedLines: number;
}

export interface DigestResult {
  text: string;
  stats: DigestStats;
}

/** 小输出阈值：低于此值只做归一化，不做窗口裁剪 */
const SMALL_LINES = 120;
const SMALL_CHARS = 8000;

/** 错误/诊断信号（命中行及其上下文必须保留） */
const ERROR_SIGNAL =
  /(?:Traceback \(most recent call last\)|\b(?:ERROR|FAIL|FAILED|FATAL|PANIC|Exception|panic|fatal)\b|npm ERR!|error TS\d|Caused by:|^\s*at\s+\S+.*\(|File "[^"]+", line \d+|^\s*\^+\s*$)/;

/** 受保护行的上下文（前/后行数） */
const PROTECT_BEFORE = 2;
const PROTECT_AFTER = 8;

/** 退格处理：删除前一个已输出字符 */
function applyBackspace(s: string): string {
  if (!s.includes('\b')) return s;
  const out: string[] = [];
  for (const ch of s) {
    if (ch === '\b') out.pop();
    else out.push(ch);
  }
  return out.join('');
}

/**
 * 归一化原始输出为「行数组」：
 * - `\r` 行内覆盖（进度条只保留最终帧，取最后一个非空段）；
 * - 退格回退；
 * - 去除 C0 控制符（保留 \t），行尾空白清理。
 */
export function normalizeOutput(raw: string): string[] {
  const src = stripAnsi(raw).replace(/\r\n/g, '\n');
  const lines: string[] = [];
  for (const rawLine of src.split('\n')) {
    const segs = rawLine.split('\r').filter((segment) => segment.length > 0);
    const line = applyBackspace(segs.length > 0 ? (segs[segs.length - 1] as string) : '')
      // 保留 \t；去掉其余 C0 与 DEL
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/[ \t]+$/, '');
    lines.push(line);
  }
  // 文件末尾的换行会产生一个空行：去掉尾部空行
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 折叠连续相同行（≥3 次）与连续空行 */
function collapseRuns(lines: string[]): { lines: string[]; collapsed: number } {
  const out: string[] = [];
  let collapsed = 0;
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i] as string;
    let j = i + 1;
    while (j < lines.length && lines[j] === cur) j++;
    const count = j - i;
    if (cur.trim() === '') {
      // 连续空行压缩为 1
      out.push('');
      collapsed += count - 1;
    } else if (count >= 3 && !ERROR_SIGNAL.test(cur)) {
      out.push(`${cur}  [×${count}]`);
      collapsed += count - 1;
    } else {
      for (let k = i; k < j; k++) out.push(lines[k] as string);
    }
    i = j;
  }
  return { lines: out, collapsed };
}

/** 标记受保护行及其上下文 */
function protectedIndices(lines: string[]): Set<number> {
  const keep = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!ERROR_SIGNAL.test(lines[i] as string)) continue;
    const from = Math.max(0, i - PROTECT_BEFORE);
    const to = Math.min(lines.length - 1, i + PROTECT_AFTER);
    for (let k = from; k <= to; k++) keep.add(k);
  }
  return keep;
}

/**
 * 精简命令输出。默认只对「大输出」裁剪；小输出仅做归一化与重复折叠。
 */
export function digestCommandOutput(raw: string, opts: DigestOptions = {}): DigestResult {
  const maxChars = Math.max(2000, opts.maxChars ?? 60_000);
  const normalized = normalizeOutput(raw);
  const totalLines = normalized.length;
  const totalChars = raw.length;

  const collapsed = collapseRuns(normalized);
  const lines = collapsed.lines;

  // 小输出：不裁剪窗口
  if (lines.length <= SMALL_LINES && raw.length <= SMALL_CHARS) {
    const text = lines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
    return {
      text,
      stats: {
        totalLines,
        totalChars,
        shownLines: text ? text.split('\n').length : 0,
        omittedLines: 0,
        collapsedLines: collapsed.collapsed,
      },
    };
  }

  // 成功且无错误信号 → 更激进的窗口（构建/安装成功的刷屏日志）
  const hasError = normalized.some((line) => ERROR_SIGNAL.test(line));
  const success = opts.exitCode === 0 && !hasError;
  const headBudget = success ? 20 : 60;
  const tailBudget = success ? 30 : 80;

  const keep = protectedIndices(lines);
  for (let i = 0; i < Math.min(headBudget, lines.length); i++) keep.add(i);
  for (let i = Math.max(0, lines.length - tailBudget); i < lines.length; i++) keep.add(i);

  const out: string[] = [];
  let omitted = 0;
  let omittedTotal = 0;
  const flushOmitted = (): void => {
    if (omitted > 0) {
      out.push(`… 省略 ${omitted} 行 …`);
      omitted = 0;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      flushOmitted();
      out.push(lines[i] as string);
    } else {
      omitted++;
      omittedTotal++;
    }
  }
  flushOmitted();

  let text = out.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  let shownLines = text ? text.split('\n').length : 0;

  // 字符上限兜底：保留头尾（错误块通常位于尾部 / 头部窗口内）
  if (text.length > maxChars) {
    const head = Math.floor(maxChars * 0.45);
    const tail = Math.floor(maxChars * 0.45);
    const cut = text.length - head - tail;
    text = `${text.slice(0, head)}\n… 省略 ${cut} 字符 …\n${text.slice(-tail)}`;
    shownLines = text.split('\n').length;
  }

  return {
    text,
    stats: {
      totalLines,
      totalChars,
      shownLines,
      omittedLines: omittedTotal,
      collapsedLines: collapsed.collapsed,
    },
  };
}
