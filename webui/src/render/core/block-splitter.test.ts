// render/core/block-splitter.test.ts
// 分块器：顶层围栏快速通道（流式即成代码卡片）+ 既有空行/缩进围栏/数学块语义。

import { describe, expect, test } from 'bun:test';
import { splitBlocks } from './block-splitter';

describe('splitBlocks 顶层围栏', () => {
  test('未闭合围栏：单块、closed=false、raw 为代码体', () => {
    const blocks = splitBlocks('```html\n<div>\n\n<p>x</p>');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      index: 0,
      raw: '<div>\n\n<p>x</p>',
      closed: false,
      fenceLang: 'html',
    });
  });

  test('闭合围栏后继续正文：围栏块闭合 + 后文活跃', () => {
    const blocks = splitBlocks('```js\nconst a = 1;\n```\n\n后文');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ raw: 'const a = 1;', closed: true, fenceLang: 'js' });
    expect(blocks[1]).toMatchObject({ raw: '后文', closed: false });
    expect(blocks[1].fenceLang).toBeUndefined();
  });

  test('围栏前无空行的说明文字被拆为独立闭块', () => {
    const blocks = splitBlocks('说明：\n```md\n# 标题');
    expect(blocks.map((b) => b.raw)).toEqual(['说明：', '# 标题']);
    expect(blocks[0].closed).toBe(true);
    expect(blocks[1]).toMatchObject({ closed: false, fenceLang: 'md' });
  });

  test('无语言围栏：fenceLang 为空串', () => {
    const blocks = splitBlocks('```\nx\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ raw: 'x', closed: true, fenceLang: '' });
  });

  test('~~~ 围栏与更长的闭合标记', () => {
    const blocks = splitBlocks('````md\n```\n代码\n```\n````');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ raw: '```\n代码\n```', closed: true, fenceLang: 'md' });
  });

  test('缩进围栏仍走 markdown 块（不破坏列表嵌套）', () => {
    const blocks = splitBlocks('1. 步骤\n   ```js\n   x\n   ```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].fenceLang).toBeUndefined();
    expect(blocks[0].raw).toContain('```js');
  });

  test('CRLF 输入可识别围栏', () => {
    const blocks = splitBlocks('```html\r\n<div>\r\n```\r\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ raw: '<div>', closed: true, fenceLang: 'html' });
  });

  test('$$ 数学块跨空行仍为单块', () => {
    const blocks = splitBlocks('$$\na\n\nb\n$$');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].fenceLang).toBeUndefined();
    expect(blocks[0].closed).toBe(false);
  });
});
