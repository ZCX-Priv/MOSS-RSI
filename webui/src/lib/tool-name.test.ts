// webui/src/lib/tool-name.test.ts
// MCP 工具名展示格式化单测：mcp__server__tool → mcp.server.tool，非 MCP 工具名原样返回。
// 运行：bun test webui/src/lib/tool-name.test.ts

import { describe, it, expect } from 'bun:test';
import { formatToolDisplayName } from './tool-name';

describe('formatToolDisplayName', () => {
  it('MCP 工具：mcp__server__tool → mcp.server.tool', () => {
    expect(formatToolDisplayName('mcp__bing-cn-mcp-server__bing_search')).toBe(
      'mcp.bing-cn-mcp-server.bing_search',
    );
    expect(formatToolDisplayName('mcp__filesystem__read_file')).toBe(
      'mcp.filesystem.read_file',
    );
  });

  it('工具名自身含双下划线时只替换首个分隔符', () => {
    expect(formatToolDisplayName('mcp__srv__tool__x')).toBe('mcp.srv.tool__x');
  });

  it('缺少 tool 段时退化为 mcp.<server>', () => {
    expect(formatToolDisplayName('mcp__srv')).toBe('mcp.srv');
  });

  it('异常前缀原样返回', () => {
    expect(formatToolDisplayName('mcp__')).toBe('mcp__');
  });

  it('非 MCP 工具名原样返回', () => {
    expect(formatToolDisplayName('read')).toBe('read');
  });
});
