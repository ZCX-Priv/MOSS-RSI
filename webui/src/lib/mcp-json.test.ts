// webui/src/lib/mcp-json.test.ts
// MCP JSON 导入解析纯函数单测：标准包裹格式（Claude Desktop/Cursor/VS Code）、
// type 别名、原生单定义/map/数组、边界与非法输入。
// 运行：bun test webui/src/lib/mcp-json.test.ts

import { describe, it, expect } from 'bun:test';
import { parseMcpJsonInput, normalizeMcpDef } from './mcp-json';

describe('parseMcpJsonInput - 标准 mcpServers 包裹格式', () => {
  it('Claude Desktop 片段（mcpServers + command/args/env）→ 归一化为 stdio', () => {
    const raw = JSON.stringify({
      mcpServers: {
        Playwright: {
          command: 'npx',
          args: ['-y', '@executeautomation/playwright-mcp-server'],
          env: {},
        },
      },
    });
    const defs = parseMcpJsonInput(raw);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe('Playwright');
    expect(defs[0]?.transport).toBe('stdio');
    expect(defs[0]?.command).toBe('npx');
    expect(defs[0]?.args).toEqual(['-y', '@executeautomation/playwright-mcp-server']);
    // 空 env 对象被丢弃
    expect(defs[0]?.env).toBeUndefined();
  });

  it('type 别名：sse / streamable-http / http（大小写不敏感）', () => {
    const sse = parseMcpJsonInput(
      JSON.stringify({ mcpServers: { x: { type: 'sse', url: 'http://a/sse' } } }),
    );
    expect(sse[0]?.transport).toBe('sse');

    const streamable = parseMcpJsonInput(
      JSON.stringify({ mcpServers: { y: { type: 'streamable-http', url: 'http://a/mcp' } } }),
    );
    expect(streamable[0]?.transport).toBe('http');

    const upper = parseMcpJsonInput(
      JSON.stringify({ mcpServers: { z: { type: 'HTTP', url: 'http://a/mcp' } } }),
    );
    expect(upper[0]?.transport).toBe('http');
  });

  it('MOSS 自身复制片段（type:http + url + headers）可回导', () => {
    const defs = parseMcpJsonInput(
      JSON.stringify({
        mcpServers: {
          moss: {
            type: 'http',
            url: 'http://127.0.0.1:7766/mcp',
            headers: { Authorization: 'Bearer t' },
          },
        },
      }),
    );
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe('moss');
    expect(defs[0]?.transport).toBe('http');
    expect(defs[0]?.url).toBe('http://127.0.0.1:7766/mcp');
    expect(defs[0]?.headers).toEqual({ Authorization: 'Bearer t' });
  });

  it('VS Code 包裹键 servers（type:stdio + command）', () => {
    const defs = parseMcpJsonInput(
      JSON.stringify({ servers: { z: { type: 'stdio', command: 'node', args: ['s.js'] } } }),
    );
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe('z');
    expect(defs[0]?.transport).toBe('stdio');
    expect(defs[0]?.command).toBe('node');
  });

  it('包裹格式批量：mcpServers 下多个 server', () => {
    const defs = parseMcpJsonInput(
      JSON.stringify({
        mcpServers: {
          a: { command: 'npx' },
          b: { url: 'http://b/mcp' },
        },
      }),
    );
    expect(defs.map((d) => d.name).sort()).toEqual(['a', 'b']);
    expect(defs.find((d) => d.name === 'b')?.transport).toBe('http');
  });
});

describe('parseMcpJsonInput - 回归（旧格式零行为变化）', () => {
  it('无包裹 map（{名称: 定义}）', () => {
    const defs = parseMcpJsonInput(JSON.stringify({ foo: { command: 'npx', args: ['-y', 'x'] } }));
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe('foo');
    expect(defs[0]?.transport).toBe('stdio');
  });

  it('原生单定义（含 name/transport）', () => {
    const defs = parseMcpJsonInput(
      JSON.stringify({ name: 'b', transport: 'http', url: 'http://x/mcp' }),
    );
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe('b');
    expect(defs[0]?.transport).toBe('http');
  });

  it('数组：原生定义 + 包裹对象混合', () => {
    const defs = parseMcpJsonInput(
      JSON.stringify([
        { name: 'c', transport: 'stdio', command: 'c1' },
        { mcpServers: { d: { command: 'd1' } } },
      ]),
    );
    expect(defs.map((d) => d.name).sort()).toEqual(['c', 'd']);
  });
});

describe('parseMcpJsonInput - 边界与非法输入', () => {
  it('{} 与仅包裹键但内部为空 → 空数组', () => {
    expect(parseMcpJsonInput('{}')).toEqual([]);
    expect(parseMcpJsonInput(JSON.stringify({ mcpServers: {} }))).toEqual([]);
  });

  it('包裹内定义缺 command/url → 被丢弃', () => {
    expect(parseMcpJsonInput(JSON.stringify({ mcpServers: { x: {} } }))).toEqual([]);
  });

  it('stdio 缺 command / http 缺 url → 被丢弃', () => {
    expect(
      parseMcpJsonInput(JSON.stringify({ mcpServers: { a: { type: 'stdio' } } })),
    ).toEqual([]);
    expect(
      parseMcpJsonInput(JSON.stringify({ mcpServers: { b: { type: 'http' } } })),
    ).toEqual([]);
  });

  it('JSON 语法错误 → 抛错（由调用方捕获）', () => {
    expect(() => parseMcpJsonInput('not json')).toThrow();
  });
});

describe('normalizeMcpDef', () => {
  it('name 优先取定义内 name，否则取 map 的 key', () => {
    expect(normalizeMcpDef({ command: 'npx' }, 'k')?.name).toBe('k');
    expect(normalizeMcpDef({ name: 'inner', command: 'npx' }, 'k')?.name).toBe('inner');
  });

  it('非对象 / 无 name 来源 → null', () => {
    expect(normalizeMcpDef('str', 'k')).toBeNull();
    expect(normalizeMcpDef(['a'])).toBeNull();
    expect(normalizeMcpDef({ command: 'npx' })).toBeNull();
  });
});
