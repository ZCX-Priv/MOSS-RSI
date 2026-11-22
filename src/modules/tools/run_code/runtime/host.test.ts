// src/modules/tools/run_code/runtime/host.test.ts
// run_code 子进程运行时最小闭环测试：转译、注入、工具调用、日志、返回值、UISpec。

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
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

  test('pushes a validated UI snapshot at ui.render before the program ends', async () => {
    const snapshots: unknown[] = [];
    const result = await runCodeProgram({
      program: ["ui.render(ui.text({}, 'streamed'));", 'await sleep(300);', "return 'ok';"].join('\n'),
      bindings: [],
      cwd: process.cwd(),
      limits: LIMITS,
      uiEnabled: true,
      invokeTool: echoTool(),
      isConcurrencySafe: () => true,
      onProgress: (event) => {
        if (event.phase === 'ui') snapshots.push(event.uiSpec);
      },
    });

    expect(result.error).toBeUndefined();
    expect(snapshots.length).toBeGreaterThan(0);
    const first = validateUISpec(snapshots[0]);
    expect(first.fatal).toBe(false);
    expect(first.spec?.root.type).toBe('Text');
  });

  test('严格模式：任意诊断都不推送渐进 UI 快照', async () => {
    const snapshots: unknown[] = [];
    const result = await runCodeProgram({
      program: [
        "const status = ui.state('status', 0);",
        "ui.render(ui.box({}, [ui.button({ label: 'x', onClick: ui.apply('status', 'status.value') })]));",
        'await sleep(100);',
        "return 'ok';",
      ].join('\n'),
      bindings: [],
      cwd: process.cwd(),
      limits: LIMITS,
      uiEnabled: true,
      invokeTool: echoTool(),
      isConcurrencySafe: () => true,
      onProgress: (event) => {
        if (event.phase === 'ui') snapshots.push(event.uiSpec);
      },
    });

    expect(result.error).toBeUndefined();
    expect(snapshots.length).toBe(0);
    const diagnostics = result.uiDiagnostics as Array<{ code?: string }> | undefined;
    expect(diagnostics?.some((item) => item.code === 'invalid_expr')).toBe(true);
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

  test('两次大调用都保留完整富数据（不再有整次总量配额）', async () => {
    const bigTool = async (): Promise<ToolResult> => ({
      content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }],
      metadata: { value: { items: Array.from({ length: 1000 }, (_unused, index) => `item-${index}`) } },
    });
    const result = await runCodeProgram({
      program: 'await tools.big();\nawait tools.big();\nreturn { ok: true };',
      bindings: ['big'],
      cwd: process.cwd(),
      limits: LIMITS,
      uiEnabled: false,
      invokeTool: bigTool,
      isConcurrencySafe: () => true,
    });
    expect(result.error).toBeUndefined();
    expect(result.calls.length).toBe(2);
    for (const call of result.calls) {
      expect(call.resultText?.length).toBe(256 * 1024);
      const value = call.resultMetadata?.value as { items?: unknown[] } | undefined;
      expect(value?.items?.length).toBe(1000);
    }
  });

  test('大入参完整保留（不再按 16KB 截断）', async () => {
    const echo = async (name: string, args: unknown): Promise<ToolResult> => ({
      content: [{ type: 'text', text: JSON.stringify({ name, size: (args as { payload?: string }).payload?.length ?? 0 }) }],
    });
    const result = await runCodeProgram({
      program: "const r = await tools.echo({ payload: 'y'.repeat(64 * 1024) });\nreturn r;",
      bindings: ['echo'],
      cwd: process.cwd(),
      limits: LIMITS,
      uiEnabled: false,
      invokeTool: echo,
      isConcurrencySafe: () => true,
    });
    expect(result.error).toBeUndefined();
    expect(result.calls[0]?.argumentsJson?.length ?? 0).toBeGreaterThan(64 * 1024);
  });

  test('大日志按单条上限截断并标注', async () => {
    const result = await runCodeProgram({
      program: "console.log('z'.repeat(2 * 1024 * 1024));\nreturn 'ok';",
      bindings: [],
      cwd: process.cwd(),
      limits: LIMITS,
      uiEnabled: false,
      invokeTool: echoTool(),
      isConcurrencySafe: () => true,
    });
    expect(result.error).toBeUndefined();
    const log = result.logs[0] ?? '';
    expect(log.length).toBeLessThan(2 * 1024 * 1024);
    expect(log).toContain('单条日志过长');
  });

  test('完全体：原生 import + 真实 process.env', async () => {
    process.env.MOSS_PTC_TEST = 'ok';
    try {
      const result = await runCodeProgram({
        program: [
          "import { join as joinPath } from 'node:path';",
          'return { path: joinPath("a", "b"), env: process.env.MOSS_PTC_TEST };',
        ].join('\n'),
        bindings: [],
        cwd: process.cwd(),
        limits: LIMITS,
        uiEnabled: false,
        fullAccess: true,
        invokeTool: echoTool(),
        isConcurrencySafe: () => true,
      });

      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({ path: join('a', 'b'), env: 'ok' });
    } finally {
      delete process.env.MOSS_PTC_TEST;
    }
  });

  test('完全体：fetch 可访问本地服务', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('pong');
      },
    });
    try {
      const result = await runCodeProgram({
        program: `const resp = await fetch('http://127.0.0.1:${server.port}'); return await resp.text();`,
        bindings: [],
        cwd: process.cwd(),
        limits: LIMITS,
        uiEnabled: false,
        fullAccess: true,
        invokeTool: echoTool(),
        isConcurrencySafe: () => true,
      });

      expect(result.error).toBeUndefined();
      expect(result.value).toBe('pong');
    } finally {
      server.stop(true);
    }
  });

  test('完全体：require 可加载 node 内置模块', async () => {
    const result = await runCodeProgram({
      program: "const fs = require('node:fs'); return typeof fs.readFileSync;",
      bindings: [],
      cwd: process.cwd(),
      limits: LIMITS,
      uiEnabled: false,
      fullAccess: true,
      invokeTool: echoTool(),
      isConcurrencySafe: () => true,
    });

    expect(result.error).toBeUndefined();
    expect(result.value).toBe('function');
  });

  test('ask/agent/todo 仍被拒绝，run_code 可注入', async () => {
    const forbidden = await runCodeProgram({
      program: "try { tools.ask; return 'accessed'; } catch (err) { return String(err); }",
      bindings: [],
      cwd: process.cwd(),
      limits: LIMITS,
      uiEnabled: false,
      invokeTool: echoTool(),
      isConcurrencySafe: () => true,
    });
    expect(forbidden.error).toBeUndefined();
    expect(String(forbidden.value)).toContain('cannot be used inside run_code');

    const allowed = await runCodeProgram({
      program: 'return typeof tools.run_code;',
      bindings: ['run_code'],
      cwd: process.cwd(),
      limits: LIMITS,
      uiEnabled: false,
      invokeTool: echoTool(),
      isConcurrencySafe: () => true,
    });
    expect(allowed.error).toBeUndefined();
    expect(allowed.value).toBe('function');
  });

  test('嵌套 run_code 通过 invokeTool 透传', async () => {
    const seen: string[] = [];
    const result = await runCodeProgram({
      program: [
        "const nested = await tools.run_code({ code: 'return 1', description: 'nested' });",
        'return nested;',
      ].join('\n'),
      bindings: ['run_code'],
      cwd: process.cwd(),
      limits: LIMITS,
      uiEnabled: false,
      invokeTool: async (name) => {
        seen.push(name);
        return { content: [{ type: 'text', text: 'nested-ok' }] };
      },
      isConcurrencySafe: () => true,
    });

    expect(result.error).toBeUndefined();
    expect(seen).toEqual(['run_code']);
    expect(result.value).toBe('nested-ok');
  });

  test('并发上限：满额立即返回 capacity', async () => {
    const limits = { ...LIMITS, maxConcurrentPrograms: 1 };
    const first = runCodeProgram({
      program: "await sleep(600);\nreturn 'first';",
      bindings: [],
      cwd: process.cwd(),
      limits,
      uiEnabled: false,
      invokeTool: echoTool(),
      isConcurrencySafe: () => true,
    });
    await Bun.sleep(80);
    const second = await runCodeProgram({
      program: "return 'second';",
      bindings: [],
      cwd: process.cwd(),
      limits,
      uiEnabled: false,
      invokeTool: echoTool(),
      isConcurrencySafe: () => true,
    });

    expect(second.error?.kind).toBe('capacity');
    const firstResult = await first;
    expect(firstResult.error).toBeUndefined();
    expect(firstResult.value).toBe('first');
  });

  test('并发上限 0 = 不限制', async () => {
    const limits = { ...LIMITS, maxConcurrentPrograms: 0 };
    const [a, b] = await Promise.all([
      runCodeProgram({
        program: 'return 1;',
        bindings: [],
        cwd: process.cwd(),
        limits,
        uiEnabled: false,
        invokeTool: echoTool(),
        isConcurrencySafe: () => true,
      }),
      runCodeProgram({
        program: 'return 2;',
        bindings: [],
        cwd: process.cwd(),
        limits,
        uiEnabled: false,
        invokeTool: echoTool(),
        isConcurrencySafe: () => true,
      }),
    ]);

    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    expect([a.value, b.value].sort()).toEqual([1, 2]);
  });

  test('process.exit 只影响子进程，host 返回错误且不崩溃', async () => {
    const result = await runCodeProgram({
      program: 'process.exit(3);',
      bindings: [],
      cwd: process.cwd(),
      limits: LIMITS,
      uiEnabled: false,
      fullAccess: true,
      invokeTool: echoTool(),
      isConcurrencySafe: () => true,
    });

    expect(result.error).toBeDefined();
    expect(['worker-exit', 'protocol']).toContain(result.error?.kind ?? '');
  });
});
