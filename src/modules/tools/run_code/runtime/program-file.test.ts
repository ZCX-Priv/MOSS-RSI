// src/modules/tools/run_code/runtime/program-file.test.ts
// 超级PTC 临时模块：import 提升、相对路径重写、临时目录清理。

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cleanupProgramFile,
  prepareProgramFile,
  rewriteRelativeImports,
  splitLeadingImports,
} from './program-file';

function withTempCwd(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'moss-ptc-test-'));
  try {
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('splitLeadingImports', () => {
  test('提升单行 import 并保留主体行号', () => {
    const source = ["import { readFileSync } from 'node:fs';", '', 'return 42;'].join('\n');
    const split = splitLeadingImports(source);
    expect(split.head).toContain("import { readFileSync } from 'node:fs';");
    expect(split.body).toBe('return 42;');
    expect(split.bodyStartLine).toBe(3);
  });

  test('支持多行 import 与 import type', () => {
    const source = [
      'import type { Stats } from "node:fs";',
      'import {',
      '  join,',
      '  resolve,',
      '} from "node:path";',
      '',
      'return 1;',
    ].join('\n');
    const split = splitLeadingImports(source);
    expect(split.head).toContain('import type { Stats }');
    expect(split.head).toContain('} from "node:path";');
    expect(split.body.trim()).toBe('return 1;');
  });

  test('没有 import 时 head 为空', () => {
    const split = splitLeadingImports('const a = 1;\nreturn a;');
    expect(split.head).toBe('');
    expect(split.bodyStartLine).toBe(1);
  });

  test('多行块注释后的 import 仍被提升', () => {
    const source = [
      '/**',
      ' * 程序说明',
      ' */',
      "import { join } from 'node:path';",
      'return join("a", "b");',
    ].join('\n');
    const split = splitLeadingImports(source);
    expect(split.head).toContain("import { join } from 'node:path';");
    expect(split.body).toBe('return join("a", "b");');
    expect(split.bodyStartLine).toBe(5);
  });

  test('import 行尾注释不影响语句结束判断', () => {
    const source = [
      "import { join } from 'node:path'; // 用于拼路径",
      'return join("a", "b");',
    ].join('\n');
    const split = splitLeadingImports(source);
    expect(split.head).toContain("import { join } from 'node:path';");
    expect(split.body).toBe('return join("a", "b");');
    expect(split.bodyStartLine).toBe(2);
  });
});

describe('rewriteRelativeImports', () => {
  test('相对路径重写为 file://，包名与 node: 保持不变', () => {
    const head = [
      "import { a } from './lib.ts';",
      "import thing from '../shared/thing';",
      "import 'side-effect';",
      "import fs from 'node:fs';",
      "import zod from 'zod';",
    ].join('\n');
    const rewritten = rewriteRelativeImports(head, process.cwd());
    expect(rewritten).toContain(pathToFileURL(join(process.cwd(), 'lib.ts')).href);
    expect(rewritten).toContain(pathToFileURL(join(process.cwd(), '..', 'shared', 'thing')).href);
    expect(rewritten).toContain("import 'side-effect';");
    expect(rewritten).toContain("from 'node:fs'");
    expect(rewritten).toContain("from 'zod'");
  });
});

describe('prepareProgramFile / cleanupProgramFile', () => {
  test('写入可执行模块并清理临时目录', () => {
    withTempCwd((cwd) => {
      const file = prepareProgramFile(
        ["import { join } from 'node:path';", 'return join("a", "b");'].join('\n'),
        cwd,
      );
      expect(existsSync(file.path)).toBe(true);
      expect(file.path.endsWith('program.ts')).toBe(true);

      const content = readFileSync(file.path, 'utf8');
      expect(content).toContain("import { join } from 'node:path';");
      expect(content).toContain('export default async function __moss_program_main__');
      expect(content).toContain('return join("a", "b");');
      expect(content).toContain('__moss_ptc_ctx');

      cleanupProgramFile(file.dir);
      expect(existsSync(file.dir)).toBe(false);
    });
  });

  test('行号偏移可把生成行映射回原程序', () => {
    withTempCwd((cwd) => {
      const file = prepareProgramFile(["import 'node:fs';", '', 'return 1;'].join('\n'), cwd);
      // 原程序第 3 行（return 1;）应映射回生成文件中的同一语句
      const generatedLine = 3 + file.lineOffset;
      const lines = readFileSync(file.path, 'utf8').split(/\r\n|\r|\n/);
      expect(lines[generatedLine - 1]?.trim()).toBe('return 1;');
      cleanupProgramFile(file.dir);
    });
  });
});
