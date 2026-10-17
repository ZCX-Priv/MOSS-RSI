// src/modules/mcp/client.test.ts
// McpClient.callTool 实参顺序回归单测。
//
// 背景（历史 bug）：SDK 1.30 的签名是 callTool(params, resultSchema?, options?)。
// 若把请求选项对象放到第 2 位，SDK 会把它当成「结果校验 schema」，
// 收到响应后执行 safeParse(选项, result) → 运行时 TypeError：
// "schema.safeParse is not a function"。本测试锁死实参位置。
//
// 运行：bun test src/modules/mcp/client.test.ts

import { describe, it, expect } from 'bun:test';
import { McpClient } from './client';
import type { Logger, EventBus } from '../../core/types';

/** sdkClient 实际收到的实参列表（每个元素是一次调用的 args 数组） */
type CapturedArgs = unknown[][];

/** 用最小假实现替换私有 sdkClient，记录 SDK 收到的实参（避免 mock 动态 import） */
function stubSdkClient(client: McpClient, captured: CapturedArgs): void {
  (client as unknown as { sdkClient: unknown }).sdkClient = {
    callTool: async (...args: unknown[]) => {
      captured.push(args);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
}

const noopLogger = {} as unknown as Logger;
const noopEventBus = {} as unknown as EventBus;

function makeClient(): McpClient {
  return new McpClient(
    'Playwright',
    { transport: 'stdio', command: 'npx' },
    noopLogger,
    noopEventBus,
  );
}

describe('McpClient.callTool 实参顺序（SDK callTool(params, resultSchema?, options?)）', () => {
  it('options 落在第 3 位，第 2 位 resultSchema 为 undefined', async () => {
    const client = makeClient();
    const captured: CapturedArgs = [];
    stubSdkClient(client, captured);

    await client.callTool('playwright_navigate', { url: 'https://example.com' }, { timeoutMs: 1234 });

    expect(captured).toHaveLength(1);
    const args = captured[0] ?? [];
    // 第 1 参：tools/call 参数
    expect(args[0]).toEqual({ name: 'playwright_navigate', arguments: { url: 'https://example.com' } });
    // 第 2 参：必须为 undefined（交由 SDK 默认 CallToolResultSchema），绝不能是选项对象
    expect(args[1]).toBeUndefined();
    // 第 3 参：请求选项
    expect(args[2]).toMatchObject({ timeout: 1234, resetTimeoutOnProgress: true });
  });

  it('未传 timeoutMs 时仍保留 resetTimeoutOnProgress，且第 2 参保持 undefined', async () => {
    const client = makeClient();
    const captured: CapturedArgs = [];
    stubSdkClient(client, captured);

    await client.callTool('playwright_navigate', {});

    const args = captured[0] ?? [];
    expect(args[1]).toBeUndefined();
    const options = args[2] as { timeout?: number; resetTimeoutOnProgress?: boolean } | undefined;
    expect(options?.resetTimeoutOnProgress).toBe(true);
    expect(options?.timeout).toBeUndefined();
  });

  it('返回值归一化：text 内容与 isError 原样返回', async () => {
    const client = makeClient();
    const captured: CapturedArgs = [];
    stubSdkClient(client, captured);

    const result = await client.callTool('playwright_navigate', {});
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(result.isError).toBe(false);
  });

  it('未连接（sdkClient 为空）时抛出错误，不发请求', async () => {
    const client = makeClient();
    const captured: CapturedArgs = [];
    await expect(client.callTool('playwright_navigate', {})).rejects.toThrow();
    expect(captured).toHaveLength(0);
  });
});
