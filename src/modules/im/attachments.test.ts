// src/modules/im/attachments.test.ts
// 附件暂存/限额/命名/prompt 清单测试。

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../../core/types';
import {
  MAX_ATTACHMENTS,
  buildPromptWithAttachments,
  formatBytes,
  safeFileName,
  stageAttachments,
} from './attachments';
import type { ImMediaRef } from './types';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'moss-im-attach-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function logger(): Logger {
  const noop = (): void => undefined;
  const log: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => log,
    setLevel: noop,
    getLevel: () => 'error',
  };
  return log;
}

function media(content: string, name: string, kind: ImMediaRef['kind'] = 'file'): ImMediaRef {
  return {
    kind,
    name,
    mimeType: 'text/plain',
    load: async () => Buffer.from(content),
  };
}

describe('safeFileName', () => {
  test('去掉路径与控制字符，保留可读名', () => {
    expect(safeFileName('../../etc/passwd', 'file')).toBe('passwd');
    expect(safeFileName('a/b c.txt', 'file')).toBe('b c.txt');
    expect(safeFileName('  ...  ', 'file')).toBe('file');
    expect(safeFileName('报告 2026.pdf', 'file')).toBe('报告 2026.pdf');
  });
});

describe('stageAttachments', () => {
  test('落盘、命名、内容正确', async () => {
    const dir = tempDir();
    const result = await stageAttachments(
      dir,
      'bot1',
      [media('hello', 'a.txt'), media('world', 'b.txt', 'image')],
      new AbortController().signal,
      logger(),
    );
    expect(result.staged.length).toBe(2);
    expect(result.directory).not.toBeNull();
    const first = result.staged[0];
    expect(first?.name).toBe('a.txt');
    expect(first?.path.endsWith('01-a.txt')).toBe(true);
    expect(existsSync(first!.path)).toBe(true);
    expect(readFileSync(first!.path, 'utf8')).toBe('hello');
    expect(result.staged[1]?.kind).toBe('image');
  });

  test('超过数量上限的文件被跳过，不中断整条消息', async () => {
    const dir = tempDir();
    const many = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, index) => media(`x${index}`, `f${index}.txt`));
    const result = await stageAttachments(dir, 'bot1', many, new AbortController().signal, logger());
    expect(result.staged.length).toBe(MAX_ATTACHMENTS);
    expect(result.skipped.length).toBe(2);
    expect(result.skipped[0]?.reason).toContain('附件');
  });

  test('下载失败记为 skipped', async () => {
    const dir = tempDir();
    const broken: ImMediaRef = {
      kind: 'file',
      name: 'bad.bin',
      load: async () => {
        throw new Error('network down');
      },
    };
    const result = await stageAttachments(dir, 'bot1', [broken], new AbortController().signal, logger());
    expect(result.staged.length).toBe(0);
    expect(result.skipped[0]?.reason).toContain('network down');
  });
});

describe('prompt 与格式', () => {
  test('有文本 + 附件清单', async () => {
    const dir = tempDir();
    const result = await stageAttachments(dir, 'bot1', [media('x', 'a.txt')], new AbortController().signal, logger());
    const prompt = buildPromptWithAttachments('帮我看看', result.staged, result.skipped, 'qq-onebot');
    expect(prompt).toContain('帮我看看');
    expect(prompt).toContain('[IM 附件 · qq-onebot]');
    expect(prompt).toContain(result.staged[0]!.path);
  });

  test('纯附件时给出处理提示', async () => {
    const dir = tempDir();
    const result = await stageAttachments(dir, 'bot1', [media('x', 'a.txt')], new AbortController().signal, logger());
    const prompt = buildPromptWithAttachments('', result.staged, result.skipped, 'wechat-ilink');
    expect(prompt).toContain('请查看并处理下面的附件');
    expect(prompt).toContain(result.staged[0]!.path);
  });

  test('formatBytes', () => {
    expect(formatBytes(10)).toBe('10 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
