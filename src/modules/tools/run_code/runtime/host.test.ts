// src/modules/tools/run_code/runtime/host.test.ts
// run_code 子进程运行时最小闭环测试：转译、注入、工具调用、日志、返回值、UISpec。

import { describe, expect, test } from 'bun:test';
import type { ToolResult } from '../../types';
import { runCodeProgram } from './host';

const LIMITS = {
  timeoutMs: 15_000,
  maxOutputBytes: 262_144,
  maxCodeChars: 20_000,
  maxParallelSubCalls: 4,
};

function echoTool(): (name: string, args: unknown) => Promise<ToolResult> {
  return async (_name, args) => {
    const value = args as { value?: unknown };
    return {
      content: [{ type: 'text', text: JSON.stringify({ value: value.value ?? null }) }],
      metadata: { value: { value: value.value ?? null } },
    };
  };
}

describe('run_code runtime host', () => {
  test('executes a program with a nested tool call and logs', async () => {
    const result = await runCodeProgram({
      program: [
        'const a = await tools.echo({ value: 21 });',
        'console.log("hello from child");',
        'return { total: (a as { value: number }).value * 2 };',
      ].join('\n'),
      bindings: ['echo'],
      cwd: process.cwd(),
      limits: LIMITS,
      uiEnabled: true,
      invokeTool: echoTool(),
      isConcurrencySafe: () => true,
    });

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ total: 42 });
    expect(result.logs.some((line) => line.includes('hello from child'))).toBe(true);
    expect(result.nestedCalls).toBe(1);
    expect(result.calls[0]?.ok).toBe(true);
  });

  test('returns a validated raw UISpec when ui.render is used', async () => {
    const result = await runCodeProgram({
      program: [
        "const seats = ui.state('seats', 8);",
        "const price = ui.expr('seats * 29');",
        'ui.render(ui.box({ gap: 2 }, [',
        "  ui.title({ size: 'xl' }, 'Team plan'),",
        "  ui.slider({ min: 1, max: 50, value: seats, onChange: ui.set('seats') }),",
        '  ui.text({}, price),',
        ']));',
        "return 'ok';",
      ].join('\n'),
      bindings: [],
      cwd: process.cwd(),
      limits: LIMITS,
      uiEnabled: true,
      invokeTool: echoTool(),
      isConcurrencySafe: () => true,
    });

    expect(result.error).toBeUndefined();
    expect(result.hasUi).toBe(true);
    expect(result.ui).toBeTruthy();
  });

  test('reports a timeout instead of hanging', async () => {
    const started = Date.now();
    const result = await runCodeProgram({
      program: 'while (true) {}',
      bindings: [],
      cwd: process.cwd(),
      limits: { ...LIMITS, timeoutMs: 800 },
      uiEnabled: false,
      invokeTool: echoTool(),
      isConcurrencySafe: () => true,
    });
    expect(result.error?.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
