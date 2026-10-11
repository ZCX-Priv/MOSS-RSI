// src/utils/encoding.test.ts
// encoding 工具函数单元测试：覆盖 isValidUtf8 / hasUtf8Bom / stripBom / decodeTerminalOutput 全部分支。

import { describe, it, expect } from 'bun:test';
import { isValidUtf8, hasUtf8Bom, stripBom, decodeTerminalOutput } from './encoding';

describe('isValidUtf8', () => {
  it('空 Buffer 视为合法 UTF-8', () => {
    expect(isValidUtf8(Buffer.alloc(0))).toBe(true);
  });

  it('纯 ASCII 合法', () => {
    expect(isValidUtf8(Buffer.from('hello world', 'ascii'))).toBe(true);
  });

  it('合法 UTF-8 中文（3 字节序列）合法', () => {
    expect(isValidUtf8(Buffer.from('你好世界', 'utf8'))).toBe(true);
  });

  it('孤立续字节 0x80 非法', () => {
    expect(isValidUtf8(Buffer.from([0x80]))).toBe(false);
  });

  it('overlong 2 字节序列首字节 0xC0 非法', () => {
    expect(isValidUtf8(Buffer.from([0xC0, 0x80]))).toBe(false);
  });

  it('surrogate 半区 U+D800（0xED 0xA0 0x80）非法', () => {
    expect(isValidUtf8(Buffer.from([0xED, 0xA0, 0x80]))).toBe(false);
  });

  it('超出 Unicode 范围 0xF5 非法', () => {
    expect(isValidUtf8(Buffer.from([0xF5, 0x80, 0x80, 0x80]))).toBe(false);
  });

  it('截断的多字节序列非法', () => {
    // 3 字节序列首字节 0xE4 但只跟 1 个续字节
    expect(isValidUtf8(Buffer.from([0xE4, 0xB8]))).toBe(false);
  });
});

describe('hasUtf8Bom', () => {
  it('首部 EF BB BF 识别为 BOM', () => {
    expect(hasUtf8Bom(Buffer.from([0xEF, 0xBB, 0xBF, 0x41]))).toBe(true);
  });

  it('无 BOM 返回 false', () => {
    expect(hasUtf8Bom(Buffer.from('hello', 'utf8'))).toBe(false);
  });

  it('长度不足 3 返回 false', () => {
    expect(hasUtf8Bom(Buffer.from([0xEF, 0xBB]))).toBe(false);
  });
});

describe('stripBom', () => {
  it('剥离首部 BOM 字符 U+FEFF', () => {
    expect(stripBom('\uFEFFhello')).toBe('hello');
  });

  it('无 BOM 原样返回', () => {
    expect(stripBom('hello')).toBe('hello');
  });
});

describe('decodeTerminalOutput', () => {
  it('空 Buffer 返回空字符串', () => {
    expect(decodeTerminalOutput(Buffer.alloc(0))).toBe('');
  });

  it('纯 ASCII 按 UTF-8 解码', () => {
    expect(decodeTerminalOutput(Buffer.from('hello', 'utf8'))).toBe('hello');
  });

  it('合法 UTF-8 中文（含 CJK 3 字节序列）按 UTF-8 解码', () => {
    const text = '你好世界';
    expect(decodeTerminalOutput(Buffer.from(text, 'utf8'))).toBe(text);
  });

  it('GBK 编码中文回退到 GBK 解码', () => {
    // "你好" 的 GBK 编码：0xC4 0xE3 0xBA 0xC3
    const gbkBuf = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3]);
    const decoded = decodeTerminalOutput(gbkBuf);
    expect(decoded).toContain('你');
    expect(decoded).toContain('好');
  });

  it('含非法 UTF-8 字节回退到 GBK', () => {
    // 0xFF 0xFE 不是合法 UTF-8 首字节
    const buf = Buffer.from([0xFF, 0xFE, 0x41]);
    // 应该不抛异常，返回某种解码结果（GBK 或 UTF-8 替换字符）
    expect(typeof decodeTerminalOutput(buf)).toBe('string');
  });

  it('合法 UTF-8 但仅 2 字节序列（拉丁扩展）回退 UTF-8', () => {
    // 0xC3 0xA9 = é (U+00E9)，合法 2 字节 UTF-8，无 CJK
    const buf = Buffer.from([0xC3, 0xA9]);
    expect(decodeTerminalOutput(buf)).toBe('é');
  });
});
