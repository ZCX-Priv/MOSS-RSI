// src/modules/tools/run_code/runtime/syntax.test.ts
// 结构扫描/顶层切块/错误定位的回归测试。

import { describe, expect, test } from 'bun:test';
import {
  formatSourceExcerpt,
  locateChunkFailure,
  scanStructure,
  splitTopLevelChunks,
} from './syntax';

function issueOf(source: string) {
  const result = scanStructure(source);
  if (result.ok) throw new Error('expected a syntax issue');
  return result.issue;
}

describe('scanStructure', () => {
  test('定位多余的 }（会话中的真实错误）', () => {
    const source = ['const a = ui.box({ gap: 1 }, [', "  ui.text({}, 'x'),", '] }));', "return 'ok';"].join('\n');
    const issue = issueOf(source);
    expect(issue.line).toBe(3);
    expect(issue.column).toBe(3);
    expect(issue.message).toContain("多余的 '}'");
    expect(issue.message).toContain('第 1 行第 17 列');
    expect(issue.excerpt).toContain('> 3 | ] }));');
    expect(issue.excerpt).toContain('^');
  });

  test('报告未闭合的 (', () => {
    const issue = issueOf("ui.render(ui.box({ gap: 1 }, [ui.text({}, 'x')]);");
    expect(issue.message).toContain("'(' 未闭合");
    expect(issue.line).toBe(1);
  });

  test('报告未闭合的模板字符串', () => {
    const issue = issueOf('const a = `hello ${name');
    expect(issue.message).toContain('模板字符串');
  });

  test('报告未闭合的块注释', () => {
    const issue = issueOf('const a = 1;\n/* comment');
    expect(issue.message).toContain('块注释未闭合');
    expect(issue.line).toBe(2);
  });

  test('字符串内的括号不参与配对', () => {
    expect(scanStructure("const s = ']}';\nreturn s;").ok).toBe(true);
  });

  test('注释内的括号不参与配对', () => {
    expect(scanStructure('// } ] )\nconst a = 1;\nreturn a;').ok).toBe(true);
  });

  test('正则字面量内的括号不参与配对', () => {
    expect(scanStructure('const re = /[}\\]]/;\nreturn re.test("}");').ok).toBe(true);
  });

  test('模板字符串 ${} 嵌套正常配对', () => {
    expect(scanStructure('const a = `x${ { k: 1 }.k }`;\nreturn a;').ok).toBe(true);
  });

  test('CRLF 与中文不误报', () => {
    const source = "const a = {\r\n  标题: '中文',\r\n};\r\nreturn a;";
    expect(scanStructure(source).ok).toBe(true);
  });
});

describe('splitTopLevelChunks / locateChunkFailure', () => {
  test('按顶层语句切块', () => {
    const program = ['const a = 1;', 'const b = {', '  x: 2,', '};', "return 'ok';"].join('\n');
    const chunks = splitTopLevelChunks(program);
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[1]?.startLine).toBe(2);
    expect(chunks[2]?.startLine).toBe(5);
  });

  test('能定位到第一个失败语句', () => {
    const program = ['const a = 1;', 'const b = 2;', 'const BAD = 3;', "return 'ok';"].join('\n');
    const located = locateChunkFailure(program, (candidate) => {
      if (candidate.includes('BAD')) throw new Error('bad chunk');
    });
    expect(located?.line).toBe(3);
    expect(located?.chunk).toContain('const BAD = 3;');
  });

  test('全部合法时返回 null', () => {
    const located = locateChunkFailure('const a = 1;\nreturn a;', () => undefined);
    expect(located).toBeNull();
  });

  test('formatSourceExcerpt 带行号与 caret', () => {
    const excerpt = formatSourceExcerpt('a\nb\nc', 2, 1);
    expect(excerpt).toContain('> 2 | b');
    expect(excerpt).toContain('^');
  });
});
