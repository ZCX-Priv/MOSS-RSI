// src/modules/tools/run_code/ui/validate.test.ts
// UISpec 净化边界：Grid/动态绑定/本地动作序列可用，危险表达式与非法结构被拒。

import { describe, expect, test } from 'bun:test';
import { createUiBuilder } from './builder';
import { isSafeExprSource } from './spec';
import { validateUISpec } from './validate';

describe('validateUISpec', () => {
  test('accepts Grid, bound scalar props and action sequences', () => {
    const result = validateUISpec({
      version: 1,
      root: {
        type: 'Grid',
        props: { columns: 10, gap: 1 },
        children: [
          {
            type: 'Box',
            props: { height: 26, tone: { $expr: "status == 0 ? 'success' : 'muted'" } },
          },
          {
            type: 'Button',
            props: {
              label: 'step',
              value: 'up',
              onClick: {
                $action: {
                  kind: 'seq',
                  actions: [
                    { kind: 'apply', key: 'status', expr: 'status + 1' },
                    { kind: 'reset' },
                  ],
                },
              },
            },
          },
        ],
      },
      state: { status: 0 },
    });

    expect(result.fatal).toBe(false);
    expect(result.spec?.root.type).toBe('Grid');
    expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(false);
  });

  test('rejects assignment while allowing comparisons', () => {
    expect(isSafeExprSource('a == 1').ok).toBe(true);
    expect(isSafeExprSource('a != 1 && b >= 2').ok).toBe(true);
    expect(isSafeExprSource('a = 1').ok).toBe(false);
    expect(isSafeExprSource('a.b').ok).toBe(false);
  });

  test('accepts the snake example expressions', () => {
    const expressions = [
      'status == 2 ? hx : hx + (dir == "left" ? -1 : dir == "right" ? 1 : 0)',
      'status == 2 ? 0 : (nx < 0 || nx > 9 || ny < 0 || ny > 9 || contains(slice(body, 0, lastIndexOf(body, ";")), nx + "," + ny) ? 1 : 0)',
      'hit == 1 ? body : (eat == 1 ? nx + "," + ny + ";" + body : nx + "," + ny + ";" + slice(body, 0, lastIndexOf(body, ";")))',
      "contains(body, '5,5') ? (hx == 5 && hy == 5 ? 'primary' : 'success') : (5 == fx && 5 == fy ? 'warning' : 'muted')",
    ];
    for (const expression of expressions) {
      expect(isSafeExprSource(expression).ok).toBe(true);
    }
  });

  test('drops an unsafe apply expression', () => {
    const result = validateUISpec({
      version: 1,
      root: {
        type: 'Button',
        props: {
          label: 'x',
          onClick: { $action: { kind: 'apply', key: 'status', expr: 'status.__proto__' } },
        },
      },
      state: { status: 0 },
    });

    expect(result.diagnostics.some((d) => d.code === 'invalid_action')).toBe(true);
    expect(result.spec?.root.type).toBe('Button');
    expect(result.spec?.root.props?.onClick).toBeUndefined();
  });

  test('rejects an action used as a child', () => {
    const result = validateUISpec({
      version: 1,
      root: {
        type: 'Box',
        children: [{ $action: { kind: 'set', key: 'status' } }],
      },
      state: { status: 0 },
    });

    expect(result.diagnostics.some((d) => d.code === 'invalid_binding')).toBe(true);
    expect(result.spec?.root.children).toBeUndefined();
  });

  test('replaces unknown components with an Unsupported placeholder', () => {
    const result = validateUISpec({ version: 1, root: { type: 'Nope' }, state: {} });

    expect(result.fatal).toBe(false);
    expect(result.spec?.root.type).toBe('Unsupported');
    expect(result.spec?.root.props?.component).toBe('Nope');
  });

  test('drops Grid without required columns', () => {
    const result = validateUISpec({
      version: 1,
      root: { type: 'Grid', children: [{ type: 'Box' }] },
      state: {},
    });

    expect(result.fatal).toBe(true);
    expect(result.spec).toBeUndefined();
    expect(result.diagnostics.some((d) => d.code === 'missing_prop')).toBe(true);
  });

  test('builds a Grid + seq UI that passes validation', () => {
    const builder = createUiBuilder();
    const ui = builder.ui;
    ui.state('status', 0);
    ui.state('dir', 'right');
    ui.render(
      ui.grid({ columns: 10, gap: 1 }, [
        ui.box({ height: 26, tone: ui.expr("status == 0 ? 'success' : 'muted'") }),
        ui.button({
          label: 'step',
          value: 'up',
          onClick: ui.seq(
            ui.apply('status', 'status + 1'),
            ui.set('dir'),
            ui.reset(),
          ),
        }),
      ]),
    );

    const built = builder.getResult();
    expect(built.hasUi).toBe(true);
    expect(built.diagnostics.filter((d) => d.severity === 'error').length).toBe(0);

    const result = validateUISpec({ version: 1, root: built.root, state: built.state });
    expect(result.fatal).toBe(false);
    expect(result.spec?.root.type).toBe('Grid');
    expect(result.diagnostics.filter((d) => d.severity === 'error').length).toBe(0);
  });
});
