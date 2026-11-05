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

// ============================================================================
// 回归：SDK 的 protocol 在传入 signal 上 addEventListener('abort') 且请求结束后
// 不移除。若把 run 级 signal 直传，一次 run 内每次 MCP 调用都会留下一个死监听器，
// 用户停止时已完成调用会集中发送 notifications/cancelled（Bun 子进程 stdin 上叠加
// 成 drain 监听器 → MaxListenersExceededWarning）。以下测试锁死「每次调用独立 signal」。
// ============================================================================

describe('McpClient.callTool 的 AbortSignal 隔离', () => {
  /** 替换私有 sdkClient，记录每次调用收到的 signal，并返回固定结果 */
  function stubRecordingSignals(client: McpClient, signals: AbortSignal[]): void {
    (client as unknown as { sdkClient: unknown }).sdkClient = {
      callTool: async (...args: unknown[]) => {
        const options = args[2] as { signal?: AbortSignal } | undefined;
        if (options?.signal) signals.push(options.signal);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
  }

  it('每次调用派生独立 signal；已完成调用在中止 run 时不会被重放取消', async () => {
    const client = makeClient();
    const signals: AbortSignal[] = [];
    stubRecordingSignals(client, signals);

    const run = new AbortController();
    await client.callTool('a', {}, { signal: run.signal });
    await client.callTool('b', {}, { signal: run.signal });

    expect(signals).toHaveLength(2);
    // 每次调用必须拿到新的 signal，而不是同一个 run signal
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(false);
    expect(signals[1]?.aborted).toBe(false);

    // 模拟用户点停止：已完成调用的 signal 不应被触发（否则会重放 cancel 通知）
    run.abort();
    expect(signals.every(s => !s.aborted)).toBe(true);
  });

  it('中止 run 时只终止在途调用的 signal', async () => {
    const client = makeClient();
    let captured: AbortSignal | undefined;
    let release: ((value: unknown) => void) | undefined;
    (client as unknown as { sdkClient: unknown }).sdkClient = {
      callTool: (...args: unknown[]) => {
        captured = (args[2] as { signal?: AbortSignal } | undefined)?.signal;
        return new Promise(resolve => {
          release = resolve;
        });
      },
    };

    const run = new AbortController();
    const pending = client.callTool('a', {}, { signal: run.signal });
    run.abort();

    expect(captured?.aborted).toBe(true);
    release?.({ content: [{ type: 'text', text: 'ok' }] });
    await pending;
  });

  it('传入已中止的 signal 时直接拒绝，不向 SDK 发请求', async () => {
    const client = makeClient();
    const captured: CapturedArgs = [];
    stubSdkClient(client, captured);

    const run = new AbortController();
    run.abort();
    await expect(client.callTool('a', {}, { signal: run.signal })).rejects.toThrow('aborted');
    expect(captured).toHaveLength(0);
  });
});
