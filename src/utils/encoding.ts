// src/utils/encoding.ts
// 统一编码处理：UTF-8 严格验证、BOM 处理、终端输出智能解码。
// 解决 Windows 中文环境下 GBK/CP936 输出被强制按 UTF-8 解码导致的乱码，
// 以及 BOM 文件读取异常、二进制检测误判中文等问题。

import iconv from 'iconv-lite';

/**
 * 严格验证字节流是否为合法 UTF-8。
 * 拒绝：非法首字节、overlong 编码、surrogate 半区（U+D800-U+DFFF）、超出 Unicode 范围。
 * 用于 isBinaryFile 判定与终端输出解码前的编码探测。
 */
export function isValidUtf8(buf: Buffer): boolean {
  let i = 0;
  const len = buf.length;
  while (i < len) {
    const b0 = buf[i];
    // ASCII 单字节
    if (b0 < 0x80) {
      i++;
      continue;
    }
    // 0xC0-0xC1 是 overlong 2 字节序列的非法首字节；0x80-0xBF 是孤立续字节；>0xF4 超出 Unicode
    if (b0 < 0xC2 || b0 > 0xF4) return false;

    let need: number;       // 后续续字节数量
    let minC1 = 0x80;       // 第一个续字节的最小值（防 overlong）
    let maxC1 = 0xBF;       // 第一个续字节的最大值（防 surrogate / 超 Unicode）

    if (b0 < 0xE0) {
      // 2 字节序列：C2-DF + 80-BF
      need = 1;
    } else if (b0 < 0xF0) {
      // 3 字节序列：E0-EF + 2 续字节
      need = 2;
      if (b0 === 0xE0) {
        minC1 = 0xA0; // 防 overlong（U+0000-U+07FF 已由 2 字节覆盖）
      } else if (b0 === 0xED) {
        maxC1 = 0x9F; // 拒绝 surrogate 半区 U+D800-U+DFFF
      }
    } else {
      // 4 字节序列：F0-F4 + 3 续字节
      need = 3;
      if (b0 === 0xF0) {
        minC1 = 0x90; // 防 overlong
      } else if (b0 === 0xF4) {
        maxC1 = 0x8F; // 限制上限 U+10FFFF
      }
    }

    // 截断检测
    if (i + need >= len) return false;

    const c1 = buf[i + 1];
    if (c1 < minC1 || c1 > maxC1) return false;

    // 剩余续字节必须在 0x80-0xBF
    for (let j = 2; j <= need; j++) {
      const c = buf[i + j];
      if (c < 0x80 || c > 0xBF) return false;
    }
    i += 1 + need;
  }
  return true;
}

/** 检测字节流首部是否为 UTF-8 BOM（EF BB BF） */
export function hasUtf8Bom(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
}

/** 剥离首部 BOM 字符（\uFEFF）；无 BOM 则原样返回 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/** UTF-8 序列特征统计，用于区分真正 UTF-8 中文与 GBK 碰撞字 */
interface Utf8Stats {
  /** 是否完全合法 UTF-8（等价于 isValidUtf8） */
  valid: boolean;
  /** 2 字节序列数（0xC2-0xDF + 0x80-0xBF，可能是 GBK 碰撞或拉丁扩展） */
  twoByteSeqCount: number;
  /** 3 字节 CJK 序列数（0xE4-0xE9 + 2 续字节，覆盖中日韩常用字 U+4E00-U+9FFF） */
  cjkSeqCount: number;
}

/**
 * 统计字节流的 UTF-8 序列特征，用于区分真正 UTF-8 中文与 GBK 碰撞。
 * GBK 双字节字符满足 UTF-8 2 字节模式（0xC2-0xDF + 0x80-0xBF）的概率约 20%，
 * 但真正的 UTF-8 中文是 3 字节序列（首字节 0xE4-0xE9）。
 */
function analyzeUtf8(buf: Buffer): Utf8Stats {
  let i = 0;
  const len = buf.length;
  let valid = true;
  let twoByteSeqCount = 0;
  let cjkSeqCount = 0;

  while (i < len) {
    const b0 = buf[i];
    if (b0 < 0x80) { i++; continue; }            // ASCII 单字节
    if (b0 < 0xC2 || b0 > 0xF4) { valid = false; break; }

    let need: number;
    let minC1 = 0x80;
    let maxC1 = 0xBF;

    if (b0 < 0xE0) {
      need = 1;
    } else if (b0 < 0xF0) {
      need = 2;
      if (b0 === 0xE0) minC1 = 0xA0;
      else if (b0 === 0xED) maxC1 = 0x9F;
    } else {
      need = 3;
      if (b0 === 0xF0) minC1 = 0x90;
      else if (b0 === 0xF4) maxC1 = 0x8F;
    }

    if (i + need >= len) { valid = false; break; }
    const c1 = buf[i + 1];
    if (c1 < minC1 || c1 > maxC1) { valid = false; break; }
    let okTail = true;
    for (let j = 2; j <= need; j++) {
      const c = buf[i + j];
      if (c < 0x80 || c > 0xBF) { valid = false; okTail = false; break; }
    }
    if (!okTail) break;

    // 统计序列类型
    if (b0 < 0xE0) {
      twoByteSeqCount++;
    } else if (b0 >= 0xE4 && b0 <= 0xE9) {
      // CJK 统一表意符号（U+4E00-U+9FFF，常用中日韩汉字）
      cjkSeqCount++;
    }

    i += 1 + need;
  }

  return { valid, twoByteSeqCount, cjkSeqCount };
}

/**
 * 解码终端子进程输出字节流。
 * 通过分析 UTF-8 序列特征区分真正 UTF-8 中文与 GBK 碰撞字：
 * 1. 合法 UTF-8 + 含 CJK 3字节序列 → UTF-8（chcp 65001 生效的中文输出）
 * 2. 合法 UTF-8 + 只有 2字节序列（无 CJK）→ 可能是 GBK 碰撞，优先 GBK
 * 3. 有非法 UTF-8 字节 → GBK 回退
 * iconv-lite 解码失败时最终回退到 UTF-8（含替换字符 U+FFFD）。
 */
export function decodeTerminalOutput(buf: Buffer): string {
  if (buf.length === 0) return '';
  const stats = analyzeUtf8(buf);

  // 1. 有明确的 UTF-8 CJK 序列且完全合法 → 信任 UTF-8
  if (stats.valid && stats.cjkSeqCount > 0) {
    return buf.toString('utf8');
  }

  // 2. 完全合法但只有 2 字节序列（无 CJK）→ 可能是 GBK 碰撞，优先 GBK
  //    真正的 UTF-8 中文是 3 字节序列；2 字节序列对应拉丁扩展/西里尔等，罕见于 Windows 终端输出
  //    仅当 GBK 解码出多字中文内容（≥2 个 CJK）才采信 GBK：单字符碰撞
  //    （如 é = 0xC3 0xA9 在 GBK 中恰为「茅」）应回退 UTF-8
  if (stats.valid && stats.twoByteSeqCount > 0 && stats.cjkSeqCount === 0) {
    try {
      const gbkDecoded = iconv.decode(buf, 'gbk');
      const cjkCount = (gbkDecoded.match(/[\u4e00-\u9fff]/g) || []).length;
      if (cjkCount >= 2) {
        return gbkDecoded;
      }
      // GBK 无多字中文，可能是纯拉丁扩展，回退 UTF-8（更通用）
      return buf.toString('utf8');
    } catch {
      return buf.toString('utf8');
    }
  }

  // 3. 完全合法且无非 ASCII 多字节序列（纯 ASCII）→ UTF-8
  if (stats.valid) {
    return buf.toString('utf8');
  }

  // 4. 有非法 UTF-8 字节 → GBK 回退
  try {
    return iconv.decode(buf, 'gbk');
  } catch {
    return buf.toString('utf8');
  }
}
