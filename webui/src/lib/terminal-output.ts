// webui/src/lib/terminal-output.ts
// 终端工具结果的展示层清洗（纯函数，无 React 依赖）。
//
// 背景：后端已对新产生的 PTY 输出做 cleanRunOutput / stripTerminalNoise，
// 但历史会话已把带噪声的文本落盘（PowerShell 提示符、编码初始化回显、
// __MOSS_DONE 标记回显等）。前端在展示前再做一次轻量清洗，避免旧会话继续显示无关信息。
//
// 只用于「展示」：不改历史数据；清洗后文本同时用于预览档与源码档。

/** 脚手架 / 内部标记特征（出现即整行丢弃） */
const SCAFFOLD_RE =
  /__MOSS_DONE|Console\]::OutputEncoding|\[System\.Text\.Encoding\]|chcp 65001|if \(\$\?\)|\{0\}\s*else\s*\{1\}|%errorlevel%|PSConsoleHostReadLine|Import-Module PSReadLine|\$global:__Moss/i;

/**
 * 行首提示符前缀：PowerShell（PS C:\x>）、cmd（C:\x> / \\server\share>）、
 * 续行（>> / [>）、POSIX（user@host:path$）。
 */
const PROMPT_PREFIX_RE =
  /^\s*(?:PS\s+[A-Za-z]:\\[^>\r\n]*>|[A-Za-z]:\\[^>\r\n]*>|\\\\[^>\r\n]*>|>>|\[>|[^\s@]+@[^\s:]+:[^\r\n$#]*[$#])\s*/;

/** 纯提示符 / 纯续行行（无实际输出） */
const PROMPT_ONLY_RE =
  /^\s*(?:(?:PS\s+)?[A-Za-z]:\\[^>\r\n]*>|\\\\[^>\r\n]*>|[^\s@]+@[^\s:]+:[^\r\n$#]*[$#]|>+|\[>)\s*$/;

/** 命令回显扫描窗口：最多累计多少个非空行 */
const MAX_ECHO_LINES = 20;

/** 去掉行首提示符（用于命令回显匹配） */
function stripPromptPrefix(line: string): string {
  return line.replace(PROMPT_PREFIX_RE, '');
}

/**
 * 定位「被回显的命令」区间。
 * 以整条命令去空白为 key：逐行去掉提示符后再去空白累加，
 * 能跨过 PTY 硬换行/多行命令的续行提示符，命中后整段删除。
 */
function findEchoIndexes(lines: string[], commandKey: string): Set<number> {
  const removed = new Set<number>();
  if (commandKey.length < 2) return removed;

  for (let start = 0; start < lines.length; start++) {
    let accumulated = '';
    let matchedEnd = -1;
    let scanned = 0;
    for (let i = start; i < lines.length && scanned < MAX_ECHO_LINES; i++) {
      const raw = lines[i] ?? '';
      if (!raw.trim() || SCAFFOLD_RE.test(raw)) continue;
      const piece = stripPromptPrefix(raw).replace(/\s+/g, '');
      if (!piece) continue;
      scanned++;
      const next = accumulated + piece;
      if (!commandKey.startsWith(next)) break;
      accumulated = next;
      if (accumulated === commandKey) {
        matchedEnd = i;
        break;
      }
    }
    if (matchedEnd >= start) {
      for (let i = start; i <= matchedEnd; i++) removed.add(i);
    }
  }

  return removed;
}

/**
 * 清洗终端工具结果文本（保留结果头与摘要提示行）。
 * @param text 工具结果原文
 * @param command 本次执行的命令（用于定位命令回显；read 等动作可缺省）
 */
export function sanitizeTerminalOutput(text: string, command?: string): string {
  if (!text) return text;

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const commandKey = command ? command.replace(/\s+/g, '') : '';
  const echoes = findEchoIndexes(lines, commandKey);

  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (echoes.has(i)) continue;
    const line = (lines[i] ?? '').replace(/[ \t]+$/, '');
    if (SCAFFOLD_RE.test(line)) continue;
    if (PROMPT_ONLY_RE.test(line)) continue;
    // 提示符开头的行视为命令回显/提示符残留（旧会话无法可靠拆出粘连的真实输出）
    if (PROMPT_PREFIX_RE.test(line)) continue;
    kept.push(line);
  }

  // 连续空行压缩为 1，去掉首尾空行
  const collapsed: string[] = [];
  for (const line of kept) {
    if (line.trim() === '') {
      if (collapsed.length === 0 || collapsed[collapsed.length - 1] === '') continue;
      collapsed.push('');
    } else {
      collapsed.push(line);
    }
  }
  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === '') collapsed.pop();

  return collapsed.join('\n');
}
