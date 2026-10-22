// src/modules/terminal/clean-output.ts
// 终端命令回传清洗（纯函数，无外部依赖，便于单测）：
// 交互式 PTY（Windows ConPTY 尤甚）会回显输入、按终端宽度硬换行（把词切断）、插入光标
// 重绘碎片；若直接把原始缓冲切片当命令输出，模型会看到「命令回显 + 内部完成标记
// (__MOSS_DONE_*) + 语法碎片 + 提示符」的乱码，导致误判/任意出错。
// 本模块把切片还原为「该次命令的真实输出」。

/** 去除 ANSI 转义序列（工具返回给模型的可读输出） */
export function stripAnsi(s: string): string {
  return (
    s
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, '')
      // 未终止的 OSC（ConPTY 常把窗口标题序列截断在行尾）：去掉 ESC] 到行尾
      .replace(/\u001b\][^\r\n]*(?=\r|\n|$)/g, '')
      // 字符集选择 / 单字符转义（ESC ( B、ESC = 等）
      .replace(/\u001b[()][A-Za-z0-9]/g, '')
      .replace(/\u001b[=>]/g, '')
  );
}

/** 内部「命令完成标记」的稳定前缀：剔除被硬换行切碎的标记回显（含结果行） */
const MARKER_PREFIX = '__MOSS_DONE';
/** 各解释器完成标记命令 / 编码初始化命令的语法碎片（回显被换行切断后残留的特征串） */
const MARKER_SCAFFOLD = /if \(\$\?\)|\{0\}\s*else\s*\{1\}|%errorlevel%|chcp 65001|Console\]::OutputEncoding|\]::UTF8/;
/** 回显检索的最大前置行数（回显恒在切片头部；超出视为非回显，避免误删真实输出） */
const MAX_ECHO_HEAD_LINES = 8;

/** 人侧行过滤：脚手架整行丢弃特征（只来自标记命令回显，不可能是真实输出） */
const SCAFFOLD_LINE_RE = /if \(\$\?\)|\{0\}\s*else|\{1\}\)|%errorlevel%/i;

/** 人侧行过滤：用于判断「未完成行是否会演化为被丢弃行」的特征串（小写比较） */
const DROP_NEEDLES: readonly string[] = [
  MARKER_PREFIX,
  'if ($?)',
  '{0} else',
  '{1})',
  '%errorlevel%',
  "printf '__moss",
];

/** 行内是否存在标记相关特征（快速路径：绝大多数输出行不含这些串，可直接放行） */
const MARKER_QUICK_RE = /__MOSS|errorlevel|if \(\$\?\)|\{0\} else|\{1\}\)|printf '/i;

/** 被扣留的未完成行上限（超出直接放行，避免异常流无限占用） */
const MAX_PENDING_LINE = 512;

/**
 * 行内提示符模式（用于从「真实输出 + 提示符 + 标记命令」粘连行中剥离标记）。
 * 只匹配行内出现的提示符文本，不做替换；调用方自行决定保留提示符之前的内容。
 */
const INLINE_PROMPT_RE =
  /(?:PS [A-Za-z]:\\[^\r\n>]*>|[A-Za-z]:\\[^\r\n>]*>|[^\s@]+@[^\s:]+:[^\r\n$#]*[$#])/g;

/** 标记命令回显的关键字（提示符之后紧跟的部分；用于确认提示符确实是命令回显起点） */
const MARKER_CMD_SUFFIX_RE = /\s*(?:echo\s+|Write-Output\s+"?|printf\s+'?)?$/i;

/** 硬换行后常见的标记结果碎片（如 `NE_ab12__ 0`）——出现即标记块结束 */
const MARKER_FRAGMENT_RE = /^[A-Za-z0-9_]{0,24}__\s*-?\d+\s*$/;

/** 标记命令回显被硬换行后的续行碎片（只可能来自标记命令，不是真实输出） */
const MARKER_TAIL_FRAGMENT_RE =
  /(?:^evel%$|^errorlevel%?$|^\{0\}|^\{1\}|^if \(\$\?\)|^null\s|Code\)|\]::|\.UTF8|\$global:|\$LASTEXITCODE|\$\(if|\$\(|printf '|\s"\$\(|\.\s*'[^']*'\s*$)/i;

/** 找一行中最后一个合法提示符的起点（-1 = 没有） */
function lastPromptIndex(line: string): number {
  INLINE_PROMPT_RE.lastIndex = 0;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = INLINE_PROMPT_RE.exec(line)) !== null) {
    // 提示符之后必须只剩「标记命令关键字」或空白，避免把真实输出中的路径误判为提示符
    if (MARKER_CMD_SUFFIX_RE.test(line.slice(m.index + m[0].length))) last = m.index;
    if (m[0].length === 0) INLINE_PROMPT_RE.lastIndex++;
  }
  return last;
}

/**
 * 只删除一行中「标记命令/结果」的片段，保留其前面的真实输出。
 *
 * 关键场景（旧实现整行删除会导致真实输出丢失）：
 *   `abcC:\path>echo __MOSS_DONE_x %errorlevel%` → `abc`
 *   `abcPS C:\path>Write-Output "__MOSS_DONE_x 0"` → `abc`
 *   `__MOSS_DONE_x 0` → ``
 */
export function stripMarkerSegments(line: string): string {
  const idx = line.indexOf(MARKER_PREFIX);
  if (idx < 0) return line;
  const pre = line.slice(0, idx);
  if (!pre.trim()) return '';
  const prompt = lastPromptIndex(pre);
  if (prompt >= 0) return pre.slice(0, prompt).replace(/[ \t]+$/, '');
  // 没有提示符（回显行首的提示符可能被单独一行/清洗掉了）：若前缀只剩标记命令关键字，整行丢弃
  if (/^\s*(?:echo\s+|Write-Output\s+"?|printf\s+'?)?$/i.test(pre)) return '';
  return pre.replace(/[ \t]+$/, '');
}

/** 删除行尾的提示符片段（`abcPS C:\x>` → `abc`；纯提示符行 → 空串） */
export function stripInlinePrompt(line: string): string {
  const t = line.replace(/[ \t]+$/, '');
  if (!t) return line;
  INLINE_PROMPT_RE.lastIndex = 0;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = INLINE_PROMPT_RE.exec(t)) !== null) {
    if (m.index + m[0].length === t.length) last = m.index;
    if (m[0].length === 0) INLINE_PROMPT_RE.lastIndex++;
  }
  if (last < 0) return line;
  // 整行就是提示符 → 空；否则保留提示符之前的真实输出
  return last === 0 ? '' : t.slice(0, last);
}

/**
 * 在缓冲中定位「兼容完成标记 + 退出码」的真实输出（取最后一个匹配）。
 *
 * 旧实现用单个正则，要求 marker 后直接跟 ANSI + 空白 + 数字；ConPTY 在窄终端
 * 把 marker 行硬换行成两行时永远匹配不到（等满超时）。改为线性扫描：
 * 允许 marker 后跟 ANSI CSI、至多一个换行（硬换行）、任意空白，再匹配数字。
 * 回显行（`echo marker %errorlevel%`）因 marker 后是 `%` 不会被误匹配。
 */
export function findSentinel(
  buffer: string,
  from: number,
  marker: string,
): { index: number; exitCode?: number } | null {
  if (!marker) return null;
  let pos = Math.max(0, from);
  let last: { index: number; exitCode?: number } | null = null;
  for (;;) {
    const idx = buffer.indexOf(marker, pos);
    if (idx < 0) break;
    // 只接受「行首（允许 ANSI/空白）」的标记结果行。
    // CMD 在部分环境会把回显行里的 %errorlevel% 展开成数字（`echo marker 0`），
    // 若不排除回显行，会在结果行到达前把回显误当完成 → 输出为空/缺行。
    const lineStart = Math.max(buffer.lastIndexOf('\n', idx - 1), buffer.lastIndexOf('\r', idx - 1)) + 1;
    if (stripAnsi(buffer.slice(lineStart, idx)).trim() !== '') {
      pos = idx + marker.length;
      continue;
    }
    let j = idx + marker.length;
    // 跳过 ANSI CSI（ConPTY 常见）
    for (;;) {
      if (buffer[j] === '\u001b' && buffer[j + 1] === '[') {
        let k = j + 2;
        while (k < buffer.length && /[0-9;?]/.test(buffer[k] as string)) k++;
        if (k < buffer.length && /[A-Za-z]/.test(buffer[k] as string)) {
          j = k + 1;
          continue;
        }
      }
      break;
    }
    // 允许至多一个换行（硬换行把 marker 与退出码拆到两行）
    if (buffer[j] === '\r' && buffer[j + 1] === '\n') j += 2;
    else if (buffer[j] === '\n' || buffer[j] === '\r') j += 1;
    while (j < buffer.length && (buffer[j] === ' ' || buffer[j] === '\t')) j++;
    const m = /^-?\d+/.exec(buffer.slice(j, j + 24));
    if (m) {
      const end = j + m[0].length;
      // 数字必须完整（后面不能再跟数字，避免 0 前缀误匹配）
      if (!/[0-9]/.test(buffer[end] as string)) {
        last = { index: idx, exitCode: parseInt(m[0], 10) };
      }
    }
    pos = idx + marker.length;
  }
  return last;
}

/** 回显检索窗口（字符）：回显恒在提交点之后不远处，限制窗口避免无谓回溯 */
const ECHO_WINDOW = 4096;
/** 多行命令回显的检索窗口上限（按命令长度放宽，避免长命令被截断） */
const ECHO_WINDOW_MAX = 64_000;

/** 未完成行是否「可能继续长成被丢弃行」：命中特征或以其 ≥4 字符前缀结尾 */
function mightContinueIntoDropped(tail: string): boolean {
  const t = stripAnsi(tail).toLowerCase();
  for (const raw of DROP_NEEDLES) {
    const needle = raw.toLowerCase();
    if (t.includes(needle)) return true;
    const max = Math.min(needle.length - 1, t.length);
    for (let len = max; len >= 4; len--) {
      if (t.endsWith(needle.slice(0, len))) return true;
    }
  }
  return false;
}

/** ANSI 序列长度（CSI：ESC[…final；OSC：ESC]…BEL|ST）；非序列返回 0 */
function ansiLen(w: string, j: number): number {
  if (w[j + 1] === '[') {
    let k = j + 2;
    while (k < w.length && /[0-9;?]/.test(w[k] as string)) k++;
    return k < w.length && /[A-Za-z]/.test(w[k] as string) ? k + 1 - j : 0;
  }
  if (w[j + 1] === ']') {
    let k = j + 2;
    while (k < w.length) {
      if (w[k] === '\u0007') return k + 1 - j;
      if (w[k] === '\u001b' && w[k + 1] === '\\') return k + 2 - j;
      k++;
    }
  }
  return 0;
}

/** 跳过空白与 ANSI 序列（ConPTY 硬换行 / 光标重绘插入的噪声），返回新下标 */
function skipNoise(w: string, j: number): number {
  let k = j;
  for (;;) {
    const ch = w[k];
    if (ch === undefined) return k;
    if (/\s/.test(ch)) {
      k++;
      continue;
    }
    if (ch === '\u001b') {
      const n = ansiLen(w, k);
      if (n > 0) {
        k += n;
        continue;
      }
    }
    return k;
  }
}

/**
 * 跳过回显噪声：空白、ANSI 序列，以及**跨行后的续行提示符**（`>> ` / `> ` / `PS path>> `）。
 *
 * 多行命令是逐行提交的：shell 会在每行之间打印续行提示符。这些提示符不属于命令文本，
 * 匹配时必须跳过，否则整条命令的回显永远对不上（旧实现只看首行，导致后续行全残留在
 * AI 输出里）。仅当刚刚跨过换行时才把 `>` 当续行提示符，避免吞掉命令/输出里真正的 `>`。
 */
function skipEchoNoise(w: string, j: number): number {
  let k = j;
  let crossedNewline = false;
  for (;;) {
    const ch = w[k];
    if (ch === undefined) return k;
    if (ch === '\r' || ch === '\n') {
      crossedNewline = true;
      k++;
      continue;
    }
    if (/\s/.test(ch)) {
      k++;
      continue;
    }
    if (ch === '\u001b') {
      const n = ansiLen(w, k);
      if (n > 0) {
        k += n;
        continue;
      }
    }
    if (crossedNewline) {
      const rest = w.slice(k, k + 256);
      const m = /^(?:PS [^\r\n>]*)?>+\s?/.exec(rest);
      if (m && m[0].length > 0) {
        k += m[0].length;
        crossedNewline = false;
        continue;
      }
    }
    return k;
  }
}

/**
 * 定位命令回显的结束位置（返回 raw 中的下标；未命中返回 -1）。
 *
 * 以**整条命令**（所有行拼接、去空白）为 key：逐字符前进并跳过空白、ANSI 与续行提示符
 * （O(n) 线性扫描，无正则回溯风险），从而跨过硬换行、重绘与 PowerShell 的 `>>` 续行。
 * 这样 OSC 门控拿到的是「命令回显真正结束」的位置，AI 侧可以精确从该位置截取输出。
 */
export function findEchoEnd(raw: string, start: number, command: string): number {
  const key = command.replace(/\s/g, '');
  if (key.length < 2) return -1;
  const head = key[0] as string;
  const window = Math.min(ECHO_WINDOW_MAX, Math.max(ECHO_WINDOW, key.length * 3));
  const win = raw.slice(start, start + window);
  for (let i = 0; i < win.length; i++) {
    if (win[i] !== head) continue;
    let pos = i + 1;
    let ok = true;
    for (let c = 1; c < key.length; c++) {
      pos = skipEchoNoise(win, pos);
      if (win[pos] !== key[c]) {
        ok = false;
        break;
      }
      pos++;
    }
    if (ok) return start + pos;
  }
  return -1;
}

/**
 * shell 是否正停在「续行输入」状态（命令语法不完整）。
 *
 * 只认**纯续行提示符行**：PowerShell 为 `>> `，bash/zsh 为 `> `；普通提示符
 * （`PS C:\x> ` / `user@host:~$`）不算。用于看门狗提前取消卡死的多行命令，避免等满超时。
 */
export function isContinuationTail(
  raw: string,
  from: number,
  shell: 'powershell' | 'cmd' | 'bash' | 'zsh',
): boolean {
  if (shell === 'cmd') return false;
  const lines = stripAnsi(raw.slice(Math.max(0, from))).split(/\r\n|\r|\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] as string).trim();
    if (!line) continue;
    if (shell === 'powershell') return /^(?:PS [^>\r\n]*)?>>$/.test(line);
    return /^>+$/.test(line);
  }
  return false;
}

/** 提示符尾部识别窗口（字符）：只需看结尾一小段，避免大缓冲全量扫描 */
const PROMPT_TAIL_WINDOW = 4096;
/** 折行提示符最大拼接行数（cwd 很长时 ConPTY 会在终端宽度处硬换行） */
const PROMPT_WRAP_LINES = 3;

/**
 * 各 shell 的提示符「尾部形态」：
 * - cmd：`prompt $P$G` → `<盘符>:\<路径>>`（UNC 为 `\\server\share>`），路径不含 `>`；
 * - PowerShell：集成脚本固定返回 `PS <当前路径>> `；
 * - bash/zsh：`user@host:path[$#%]`。
 * 正则只锚定结尾（不锚定行首）：提示符可能出现在「无换行输出」的同一行尾部。
 */
const PROMPT_TAIL_RES: Record<'powershell' | 'cmd' | 'bash' | 'zsh', RegExp> = {
  cmd: /(?:[A-Za-z]:\\[^\r\n>]*|\\\\[^\r\n>]*)>$/,
  powershell: /(?:PS )?(?:[A-Za-z]:\\|\\\\)[^\r\n>]*>$/,
  bash: /[^\s@]+@[^\s]+:[^\r\n]*[$#]$/,
  zsh: /[^\s@]+@[^\s]+:[^\r\n]*[%#]$/,
};

/**
 * 把「去掉换行后的提示符文本」映射回 raw tail 的真实起始下标。
 * 折行提示符在 raw 里含 `\r\n`，但提示符字符本身是连续的 → 从末尾按「非换行字符数」反向走即可。
 */
function mapPromptStart(tail: string, prompt: string): number {
  const lastCh = prompt[prompt.length - 1];
  if (!lastCh) return -1;
  const end = tail.lastIndexOf(lastCh);
  if (end < 0) return -1;
  let need = prompt.length;
  let i = end;
  while (i >= 0 && need > 0) {
    const ch = tail[i] as string;
    if (ch !== '\r' && ch !== '\n') need--;
    i--;
  }
  return i + 1;
}

/**
 * 判断缓冲尾部是否停在「shell 提示符」（命令已执行完、等待输入），返回提示符起始下标。
 *
 * 用于 cmd（无 OSC 钩子）与 OSC 失效兜底：提示符是 shell 自己打印的，不需要敲入任何标记，
 * 因而人侧输出流可以原样透传（不删行 → 不与 ConPTY 屏幕模型分叉）。
 *
 * @param raw  原始输出缓冲（PTY 字节流解码后的字符串）
 * @param from 只允许从该下标之后寻找（通常是命令回显结束位置 / 提交点）
 * @returns 提示符起始下标；尾部不是提示符时返回 -1
 */
export function findPromptTail(
  raw: string,
  from: number,
  shell: 'powershell' | 'cmd' | 'bash' | 'zsh',
): number {
  const start = Math.max(0, Math.max(from, raw.length - PROMPT_TAIL_WINDOW));
  const tail = raw.slice(start);
  if (!tail) return -1;
  // 去 ANSI / 去尾部空白后，最后一段必须是「提示符 + 仅空白」
  const clean = stripAnsi(tail).replace(/\s+$/, '');
  if (!clean) return -1;
  const re = PROMPT_TAIL_RES[shell];

  // 1) 最后一行直接匹配（常规情况）
  const lineBreak = Math.max(clean.lastIndexOf('\n'), clean.lastIndexOf('\r'));
  const lastLine = clean.slice(lineBreak + 1);
  const direct = re.exec(lastLine);
  if (direct) {
    const idx = mapPromptStart(tail, direct[0]);
    if (idx >= 0) return start + idx;
  }

  // 2) 折行提示符：把最后 2~3 行去掉换行后拼接再匹配（cwd 超宽被 ConPTY 硬换行）
  const lines = clean.split(/\r\n|\r|\n/);
  for (let n = 2; n <= PROMPT_WRAP_LINES && n <= lines.length; n++) {
    const joined = lines.slice(-n).join('');
    re.lastIndex = 0;
    const m = re.exec(joined);
    if (!m) continue;
    const idx = mapPromptStart(tail, m[0]);
    if (idx >= 0) return start + idx;
  }
  return -1;
}

/**
 * 轻量清洗（OSC 精确窗口专用）：已知输出边界 [回显结束, D 标记) 时，只需去掉 ANSI、
 * 残留的兼容标记行、纯提示符/纯续行提示符行与首尾空白；不再做回显区域猜测。
 */
export function stripTerminalNoise(raw: string): string {
  return stripAnsi(raw)
    .split(/\r\n|\r|\n/)
    // 只删除标记片段，保留与标记粘连的真实输出前缀；再清掉行尾提示符
    .map((line) => stripInlinePrompt(stripMarkerSegments(line)))
    .filter((line) => line.trim() !== '' && !MARKER_SCAFFOLD.test(line))
    .filter((line) => !isBarePrompt(line) && !/^\s*>>\s*$/.test(line))
    .join('\n')
    .replace(/^[\s\n]+/, '')
    .replace(/\s+$/, '');
}

/**
 * 人侧（终端实时显示 / headless 序列化快照）行过滤器。
 *
 * 标记路径会向 PTY 敲入 `__MOSS_DONE_*` 命令并被回显：这些行及其语法碎片必须在**人看到之前**
 * 丢弃；同时逐行处理要跨分片保持状态（标记可能被分片切断）。未完成行只在「可能演化为被丢弃行」
 * 时扣留，普通提示符立即放行，避免提示符迟迟不显示。
 */
export class MarkerLineFilter {
  /** 被扣留的未完成行（可能正在形成标记行） */
  private pending = '';
  /**
   * 已确认标记行（命令回显）后进入「标记块」：丢弃其后的结果行与硬换行碎片，
   * 直到遇到提示符行。标记命令是输入队列的最后一条，其后只会是结果行/提示符，
   * 因此不会误吞真实输出；连续 30 行无提示符则强制结束，避免异常流无限丢弃。
   */
  private dropMarkerBlock = false;
  private dropBlockLines = 0;

  push(chunk: string): string {
    // 快速路径：无标记特征、无扣留、无待丢块时整块放行（高吞吐输出的主路径）
    if (!this.pending && !this.dropMarkerBlock && !MARKER_QUICK_RE.test(chunk)) return chunk;

    const text = this.pending + chunk;
    this.pending = '';
    let out = '';
    let pos = 0;
    for (;;) {
      const nl = text.indexOf('\n', pos);
      if (nl < 0) break;
      const line = text.slice(pos, nl);
      pos = nl + 1;

      if (this.dropMarkerBlock) {
        const plain = stripAnsi(line).trim();
        if (isBarePrompt(stripAnsi(line))) {
          this.dropMarkerBlock = false;
          out += `${line}\n`; // 提示符保留（人侧正常显示）
          continue;
        }
        if (MARKER_FRAGMENT_RE.test(plain)) {
          this.dropMarkerBlock = false; // 结果行：丢弃并结束块
          continue;
        }
        if (!plain || MARKER_TAIL_FRAGMENT_RE.test(plain)) {
          if (++this.dropBlockLines > 30) this.dropMarkerBlock = false;
          continue; // 折行碎片/空行：丢弃
        }
        // 非碎片行（真实输出）：结束块并正常处理该行
        this.dropMarkerBlock = false;
      }
      if (SCAFFOLD_LINE_RE.test(stripAnsi(line))) continue;

      const cleaned = stripMarkerSegments(line);
      if (cleaned !== line) {
        // 只丢弃标记片段，保留其前面的真实输出（如无换行输出与标记粘连）
        if (cleaned.trim()) out += `${cleaned}\n`;
        this.dropMarkerBlock = true;
        this.dropBlockLines = 0;
        continue;
      }
      out += `${line}\n`;
    }

    const tail = text.slice(pos);
    if (tail) {
      if (this.dropMarkerBlock) {
        const plain = stripAnsi(tail).trim();
        if (isBarePrompt(stripAnsi(tail))) {
          this.dropMarkerBlock = false;
          out += tail;
          return out;
        }
        if (MARKER_FRAGMENT_RE.test(plain)) {
          this.dropMarkerBlock = false;
          return out;
        }
        if (!plain || MARKER_TAIL_FRAGMENT_RE.test(plain)) {
          if (++this.dropBlockLines > 30) this.dropMarkerBlock = false;
          return out;
        }
        // tail 可能是「碎片 + 真实输出」粘连：无法安全拆分 → 丢弃 tail（下一片会重新同步）
        this.dropMarkerBlock = false;
        return out;
      }
      if (SCAFFOLD_LINE_RE.test(stripAnsi(tail))) {
        // 脚手架碎片：整段丢弃（不扣留，避免永久占用）
        return out;
      }
      const cleanedTail = stripMarkerSegments(tail);
      if (cleanedTail !== tail) {
        // 标记行未以换行结尾：输出真实前缀，并进入标记块丢弃后续碎片
        if (cleanedTail) out += cleanedTail;
        this.dropMarkerBlock = true;
        this.dropBlockLines = 0;
        return out;
      }
      if (mightContinueIntoDropped(tail)) {
        this.pending = tail;
        if (this.pending.length > MAX_PENDING_LINE) {
          out += this.pending;
          this.pending = '';
        }
      } else {
        out += tail;
      }
    }
    return out;
  }
}

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
  // 只统计「非空行」：启动横幅/重绘会插入大量仅含 ANSI 的空白行，不能把回显挤出搜索范围
  let considered = 0;
  for (let s = 0; s < lines.length && considered < MAX_ECHO_HEAD_LINES; s++) {
    if (!lines[s].trim()) continue;
    considered++;
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
    // 多行命令：每行都会在自己的提示符处回显，且上一行的输出可能夹在两段回显之间，
    // 整条命令无法连续匹配 → 再按单行分别定位（findEchoRegion 只搜前若干非空行，不会误删尾部输出）。
    if (/[\r\n]/.test(echo)) {
      for (const part of echo.split(/\r\n|\r|\n/)) {
        const key = part.replace(/\s/g, '');
        if (key.length < 2) continue;
        for (const idx of findEchoRegion(lines, key)) removed.add(idx);
      }
    }
  }
  return lines
    .filter((_, i) => !removed.has(i))
    // 只删除标记片段，保留粘连的真实输出；再清掉行尾提示符
    .map((line) => stripInlinePrompt(stripMarkerSegments(line)))
    .filter((line) => line.trim() !== '' && !MARKER_SCAFFOLD.test(line))
    .filter((line) => !isBarePrompt(line))
    .join('\n')
    .replace(/^[\s\n]+/, '')
    .replace(/\s+$/, '');
}
