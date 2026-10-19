// src/modules/terminal/clean-output.ts
// 终端命令回传清洗（纯函数，无外部依赖，便于单测）：
// 交互式 PTY（Windows ConPTY 尤甚）会回显输入、按终端宽度硬换行（把词切断）、插入光标
// 重绘碎片；若直接把原始缓冲切片当命令输出，模型会看到「命令回显 + 内部完成标记
// (__MOSS_DONE_*) + 语法碎片 + 提示符」的乱码，导致误判/任意出错。
// 本模块把切片还原为「该次命令的真实输出」。

/** 去除 ANSI 转义序列（工具返回给模型的可读输出） */
export function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, '');
}

/** 内部「命令完成标记」的稳定前缀：剔除被硬换行切碎的标记回显（含结果行） */
const MARKER_PREFIX = '__MOSS_DONE';
/** 各解释器完成标记命令 / 编码初始化命令的语法碎片（回显被换行切断后残留的特征串） */
const MARKER_SCAFFOLD = /if \(\$\?\)|\{0\}\s*else\s*\{1\}|%errorlevel%|chcp 65001|Console\]::OutputEncoding|\]::UTF8/;
/** 回显检索的最大前置行数（回显恒在切片头部；超出视为非回显，避免误删真实输出） */
const MAX_ECHO_HEAD_LINES = 8;

/** 去掉行首连续出现的提示符（ConPTY 重绘可能叠加多个提示符） */
function stripPromptPrefix(line: string): string {
  let s = line;
  for (let i = 0; i < 6; i++) {
    const m = /^[^\n]*?>\s?/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s;
}

/** 纯提示符行（无实际输出）：Windows（盘符路径 / PS 前缀，以 > 结尾）或 POSIX（user@host:…[$#]） */
function isBarePrompt(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return /^(?:PS\s+)?[A-Za-z]:\\[^\n]*>$/.test(t) || /^[^\s@]+@[^\s@]+:[^\n]*[$#]$/.test(t);
}

/**
 * 定位「被回显的命令」所占行区间。
 *
 * 交互式 shell 会回显输入并按终端宽度硬换行（可能把词从中切断），故先去掉提示符、
 * 再去掉所有空白后逐行拼接，即可跨越硬换行复原被切断的命令文本；命中即返回该行索引
 * 集合（含其前置的重绘残留碎片）。未命中返回空集（管道模式无回显时保持原样）。
 */
function findEchoRegion(lines: string[], key: string): Set<number> {
  const removed = new Set<number>();
  if (!key) return removed;
  const head = Math.min(lines.length, MAX_ECHO_HEAD_LINES);
  for (let s = 0; s < head; s++) {
    let acc = '';
    let end = -1;
    for (let i = s; i < lines.length; i++) {
      // 首行可能带提示符（甚至多个叠加），其余行是被硬换行切开的续行
      const piece = (i === s ? stripPromptPrefix(lines[i]) : lines[i]).replace(/\s/g, '');
      if (!piece) continue; // 空行不推进拼接进度
      const next = acc + piece;
      if (!key.startsWith(next)) break;
      acc = next;
      if (acc === key) {
        end = i;
        break;
      }
    }
    if (end < 0) continue;
    // 起点前的孤立重绘碎片若是命令前缀（重绘切断所致）一并删除；否则从命中起点删
    const pre = lines.slice(0, s).join('').replace(/\s/g, '');
    const from = pre && key.startsWith(pre) ? 0 : s;
    for (let i = from; i <= end; i++) removed.add(i);
    return removed;
  }
  return removed;
}

/**
 * 清洗交互式 PTY 命令回传：剔除命令回显、内部完成标记及其语法碎片、提示符噪声，
 * 使模型只看到该次命令的真实输出。
 *
 * @param raw    run() 截取的原始 PTY 缓冲切片
 * @param echoes 需要剔除回显的命令文本（本次 command + 解释器编码初始化命令等）
 */
export function cleanRunOutput(raw: string, echoes: readonly (string | null | undefined)[]): string {
  const lines = stripAnsi(raw).split(/\r\n|\r|\n/);
  const removed = new Set<number>();
  for (const echo of echoes) {
    if (!echo) continue;
    for (const idx of findEchoRegion(lines, echo.replace(/\s/g, ''))) removed.add(idx);
  }
  return lines
    .filter((_, i) => !removed.has(i))
    .filter((line) => !line.includes(MARKER_PREFIX) && !MARKER_SCAFFOLD.test(line))
    .filter((line) => !isBarePrompt(line))
    .join('\n')
    .replace(/^[\s\n]+/, '')
    .replace(/\s+$/, '');
}
