// src/modules/terminal/osc.ts
// OSC 133 shell-integration 序列扫描器（纯函数，可单测）。
//
// 背景：交互式 PTY 下"敲进去"的任何完成标记都会被回显、无法隐藏。改用 shell 集成钩子
// （PowerShell prompt / bash PROMPT_COMMAND / zsh precmd / cmd PROMPT）在**提示符处**发
// 不可见的 OSC 序列标注"命令完成 + 退出码"。xterm 对未知 OSC 直接丢弃 → 人与自然端均零可见。
//
// 本模块从原始 PTY 分片中增量识别 `ESC ] 133 ; <A|C|D> [; <param>...] BEL|ST`，
// 仅接受携带本终端 nonce 的序列（防命令输出伪造）。

/** 一条识别到的 OSC 133 标记 */
export interface OscMarker {
  /** A = 提示符开始；C = 命令行已读入（开始执行）；D = 命令完成 */
  kind: 'A' | 'C' | 'D';
  /** D 的退出码（解析不到为 undefined，如 cmd 的 PROMPT 无退出码） */
  exitCode?: number;
  /** 单调递增计数（每个被接受的标记 +1；用于"等待下一个 D"） */
  seq: number;
  /** 该序列 ESC] 在终端累计输出流中的绝对偏移（用于「回显之后」位置门控） */
  at: number;
}

const OSC_INTRO = '\u001b]';
/** 未完成序列的保留上限（防异常流无限增长） */
const MAX_CARRY = 4096;

export class OscScanner {
  /** 未完成尾部（含可能的 `ESC]` 前缀） */
  private carry = '';
  /** 已被接受的标记计数 */
  private seq = 0;
  /** carry 首字符在累计流中的绝对偏移 */
  private base = 0;
  /** 本终端 nonce（仅接受携带它的序列） */
  private readonly nonce: string;

  constructor(nonce: string) {
    this.nonce = nonce;
  }

  /** 已识别标记总数 */
  get count(): number {
    return this.seq;
  }

  /** 解析序列载荷；非 133 / 非 A|C|D / 未携带本终端 nonce → null */
  private parsePayload(payload: string): { kind: 'A' | 'C' | 'D'; exitCode?: number } | null {
    const parts = payload.split(';');
    if (parts[0] !== '133') return null;
    const kind = parts[1];
    if (kind !== 'A' && kind !== 'C' && kind !== 'D') return null;
    const params = parts.slice(2);
    // 防伪：必须携带本终端 nonce（shell 集成脚本注入，命令输出无从得知）
    if (params.indexOf(this.nonce) === -1) return null;
    let exitCode: number | undefined;
    for (const p of params) {
      if (p === this.nonce) continue;
      if (/^-?\d+$/.test(p)) exitCode = parseInt(p, 10);
    }
    return exitCode === undefined ? { kind } : { kind, exitCode };
  }

  /**
   * 追加一段原始流分片，返回本次新识别到的标记（按出现顺序）。
   * 跨分片被截断的序列会保留到下次 push 再拼。
   */
  push(chunk: string): OscMarker[] {
    const text = this.carry + chunk;
    const out: OscMarker[] = [];
    let i = 0;
    while (i < text.length) {
      const idx = text.indexOf(OSC_INTRO, i);
      if (idx < 0) {
        i = text.length;
        break;
      }
      // 查找终止符：BEL（\x07）或 ST（ESC \）
      let end = -1;
      let endLen = 0;
      for (let j = idx + 2; j < text.length; j++) {
        if (text[j] === '\u0007') {
          end = j;
          endLen = 1;
          break;
        }
        if (text[j] === '\u001b' && text[j + 1] === '\\') {
          end = j;
          endLen = 2;
          break;
        }
      }
      if (end < 0) {
        i = idx; // 未完成：从 ESC] 起保留为 carry
        break;
      }
      const parsed = this.parsePayload(text.slice(idx + 2, end));
      if (parsed) {
        this.seq++;
        out.push({
          kind: parsed.kind,
          ...(parsed.exitCode === undefined ? {} : { exitCode: parsed.exitCode }),
          seq: this.seq,
          at: this.base + idx,
        });
      }
      i = end + endLen;
    }
    this.carry = text.slice(i);
    this.base += i;
    if (this.carry.length > MAX_CARRY) {
      const drop = this.carry.length - MAX_CARRY;
      this.carry = this.carry.slice(-MAX_CARRY);
      this.base += drop;
    }
    return out;
  }
}

/** 生成一个终端级随机 nonce（注入 shell 集成脚本；解析器据此防伪） */
export function makeNonce(): string {
  return `m${Math.random().toString(36).slice(2, 10)}`;
}
