// src/modules/tools/wait/logic.test.ts
// wait 工具纯逻辑单测：时间解析、窗口换算、条件归一化与组合判定。
// 不依赖任何服务实例；执行入口的服务编排由人工/集成验证覆盖。

import { describe, expect, test } from 'bun:test';
import {
  WAIT_LIMITS,
  judgeConditions,
  normalizeConditions,
  parseDuration,
  parseUntil,
  resolveWindow,
} from './logic';

describe('parseDuration', () => {
  test('合法单位', () => {
    expect(parseDuration('1500ms')).toEqual({ ok: true, value: 1500 });
    expect(parseDuration('30s')).toEqual({ ok: true, value: 30_000 });
    expect(parseDuration('5MIN')).toEqual({ ok: true, value: 300_000 });
    expect(parseDuration('1.5min')).toEqual({ ok: true, value: 90_000 });
  });

  test('非法与过小', () => {
    expect(parseDuration('30').ok).toBe(false);
    expect(parseDuration('0s').ok).toBe(false);
    expect(parseDuration('50ms').ok).toBe(false);
    expect(parseDuration('abc').ok).toBe(false);
    expect(parseDuration('30h').ok).toBe(false);
  });
});

describe('parseUntil', () => {
  // 本地时间 2026-11-01 14:00:00
  const now = new Date(2026, 10, 1, 14, 0, 0).getTime();

  test('HH:mm 未来与已过（取下一次）', () => {
    const future = parseUntil('15:30', now);
    expect(future.ok).toBe(true);
    if (future.ok) expect(new Date(future.value).getHours()).toBe(15);

    const past = parseUntil('09:00', now);
    expect(past.ok).toBe(true);
    // 今天已过 → 明天的 09:00，必然大于当前时间
    if (past.ok) expect(past.value).toBeGreaterThan(now);
  });

  test('ISO 早于当前时间仍可解析（时间条件立即满足）', () => {
    const r = parseUntil('2026-11-01T00:00:00+08:00', now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeLessThan(now);
  });

  test('非法时刻/格式', () => {
    expect(parseUntil('25:00', now).ok).toBe(false);
    expect(parseUntil('12:99', now).ok).toBe(false);
    expect(parseUntil('not-a-time', now).ok).toBe(false);
  });
});

describe('resolveWindow', () => {
  const now = 1_000_000;
  const maxMs = WAIT_LIMITS.maxDurationMs;

  test('duration / until / 默认上限', () => {
    const d = resolveWindow({ duration: '30s' }, now, 600_000, maxMs);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.value.kind).toBe('duration');
      expect(d.value.endAt).toBe(now + 30_000);
    }

    const def = resolveWindow(undefined, now, 600_000, maxMs);
    expect(def.ok).toBe(true);
    if (def.ok) {
      expect(def.value.kind).toBe('default');
      expect(def.value.endAt).toBe(now + 600_000);
    }
  });

  test('互斥与超上限', () => {
    expect(resolveWindow({ duration: '1s', until: '15:30' }, now, 600_000, maxMs).ok).toBe(false);
    expect(resolveWindow({ duration: '31min' }, now, 600_000, maxMs).ok).toBe(false);
  });
});

describe('judgeConditions', () => {
  test('all / any / 空条件', () => {
    expect(judgeConditions([], 'all')).toBe(true);
    expect(judgeConditions([true, true], 'all')).toBe(true);
    expect(judgeConditions([true, false], 'all')).toBe(false);
    expect(judgeConditions([false, true], 'any')).toBe(true);
    expect(judgeConditions([false, false], 'any')).toBe(false);
  });
});

describe('normalizeConditions', () => {
  const defaults = { sessionId: 's1', maxConditions: 16 };

  test('会话条件', () => {
    const r = normalizeConditions([{ kind: 'session', sessionId: 's2' }], defaults);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([{ kind: 'session', sessionId: 's2' }]);
  });

  test('终端与工具条件的默认会话', () => {
    const r = normalizeConditions(
      [{ kind: 'terminal', terminalId: 't1' }, { kind: 'tool', toolCallId: 'tc1' }],
      defaults,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0]).toEqual({ kind: 'terminal', sessionId: 's1', terminalId: 't1' });
      expect(r.value[1]).toEqual({ kind: 'tool', sessionId: 's1', toolCallId: 'tc1' });
    }
  });

  test('结构非法', () => {
    expect(normalizeConditions('bad', defaults).ok).toBe(false);
    expect(normalizeConditions([{ kind: 'session' }], defaults).ok).toBe(false);
    expect(normalizeConditions([{ kind: 'tool' }], defaults).ok).toBe(false);
    expect(normalizeConditions([{ kind: 'unknown' }], defaults).ok).toBe(false);
  });

  test('数量上限', () => {
    const many = Array.from({ length: 17 }, () => ({ kind: 'session', sessionId: 's' }));
    expect(normalizeConditions(many, defaults).ok).toBe(false);
  });
});
