// src/modules/tools/run_code/runtime/host.test.ts
// run_code 子进程运行时最小闭环测试：转译、注入、工具调用、日志、返回值、UISpec。

import { describe, expect, test } from 'bun:test';
import type { ToolResult } from '../../types';
import { validateUISpec } from '../ui/validate';
import { runCodeProgram } from './host';

const LIMITS = {
  timeoutMs: 15_000,
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

  test('injects Grid and local computation actions into the child namespace', async () => {
    const result = await runCodeProgram({
      program: [
        "const status = ui.state('status', 0);",
        'const cells = [];',
        'for (let i = 0; i < 12; i++) {',
        "  cells.push(ui.box({ height: 20, tone: ui.expr(`status == ${i % 2} ? 'success' : 'muted'`) }));",
        '}',
        'ui.render(ui.grid({ columns: 4, gap: 1 }, [',
        '  ...cells,',
        "  ui.button({ label: 'next', onClick: ui.seq(ui.apply('status', 'status + 1'), ui.reset()) }),",
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
    const validation = validateUISpec(result.ui);
    expect(validation.fatal).toBe(false);
    expect(validation.spec?.root.type).toBe('Grid');
    expect(validation.diagnostics.filter((d) => d.severity === 'error').length).toBe(0);
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

  test('语法错误返回 syntax 且带程序行号与代码片段', async () => {
    const result = await runCodeProgram({
      program: ['const a = ui.box({ gap: 1 }, [', "  ui.text({}, 'x'),", '] }));', "return 'ok';"].join('\n'),
      bindings: [],
      cwd: process.cwd(),
      limits: LIMITS,
      uiEnabled: true,
      invokeTool: echoTool(),
      isConcurrencySafe: () => true,
    });
    expect(result.error?.kind).toBe('syntax');
    expect(result.error?.message).toContain('第 3 行第 3 列');
    expect(result.error?.message).toContain("多余的 '}'");
    expect(result.error?.message).toContain('] }));');
  });

  test('返回值自动净化：undefined/Date 不再导致整次失败', async () => {
    const result = await runCodeProgram({
      program: 'return { a: undefined, d: new Date("2026-11-01T00:00:00Z"), n: NaN };',
      bindings: [],
      cwd: process.cwd(),
      limits: LIMITS,
      uiEnabled: false,
      invokeTool: echoTool(),
      isConcurrencySafe: () => true,
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ d: '2026-11-01T00:00:00.000Z', n: null });
    expect(result.valueWarnings?.some((warning) => warning.path === 'root.a')).toBe(true);
  });

  test('返回值不设输出预算：约 1MB 结果仍完整返回', async () => {
    const result = await runCodeProgram({
      program: "return { text: 'x'.repeat(1024 * 1024) };",
      bindings: [],
      cwd: process.cwd(),
      limits: LIMITS,
      uiEnabled: false,
      invokeTool: echoTool(),
      isConcurrencySafe: () => true,
    });
    expect(result.error).toBeUndefined();
    const text = (result.value as { text?: string } | undefined)?.text ?? '';
    expect(text.length).toBe(1024 * 1024);
  });

  test('metadata.value 与 metadata.structured 都能进入程序', async () => {
    const valueTool = async (name: string): Promise<ToolResult> => {
      if (name === 'withValue') {
        return { content: [{ type: 'text', text: 'display text' }], metadata: { value: { items: [1, 2] } } };
      }
      return { content: [{ type: 'text', text: 'display text' }], metadata: { structured: { ok: true } } };
    };
    const result = await runCodeProgram({
      program: 'const a = await tools.withValue();\nconst b = await tools.withStructured();\nreturn { a, b };',
      bindings: ['withValue', 'withStructured'],
      cwd: process.cwd(),
      limits: LIMITS,
      uiEnabled: false,
      invokeTool: valueTool,
      isConcurrencySafe: () => true,
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ a: { items: [1, 2] }, b: { ok: true } });
  });
});
