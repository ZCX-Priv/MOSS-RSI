// src/modules/terminal/osc.test.ts
// OscScanner 单测：A/D 识别、退出码、nonce 防伪、BEL/ST 两种终止符、跨分片续接。
// 运行：bun test src/modules/terminal/osc.test.ts

import { describe, it, expect } from 'bun:test';
import { OscScanner, makeNonce } from './osc';

const BEL = '\u0007';
const ST = '\u001b\\';
const intro = (payload: string, term: string) => `\u001b]${payload}${term}`;

describe('OscScanner', () => {
  it('识别 D（含退出码与 nonce），BEL 终止', () => {
    const n = 'abc';
    const s = new OscScanner(n);
    const ms = s.push(intro(`133;D;1;${n}`, BEL));
    expect(ms.length).toBe(1);
    expect(ms[0].kind).toBe('D');
    expect(ms[0].exitCode).toBe(1);
  });

  it('识别 A 与 ST 终止符', () => {
    const n = 'abc';
    const s = new OscScanner(n);
    const ms = s.push(intro(`133;A;${n}`, ST));
    expect(ms.length).toBe(1);
    expect(ms[0].kind).toBe('A');
    expect(ms[0].exitCode).toBeUndefined();
  });

  it('D 无退出码（cmd 形态）仍可识别', () => {
    const n = 'abc';
    const s = new OscScanner(n);
    const ms = s.push(intro(`133;D;${n}`, BEL));
    expect(ms.length).toBe(1);
    expect(ms[0].kind).toBe('D');
    expect(ms[0].exitCode).toBeUndefined();
  });

  it('nonce 不匹配被忽略（防伪造）', () => {
    const s = new OscScanner('real');
    expect(s.push(intro('133;D;0;forged', BEL)).length).toBe(0);
  });

  it('非 133 / 非 A|D 被忽略', () => {
    const n = 'abc';
    const s = new OscScanner(n);
    expect(s.push(intro(`0;title`, BEL)).length).toBe(0);
    expect(s.push(intro(`133;C;${n}`, BEL)).length).toBe(0);
  });

  it('跨分片续接：序列被切断仍能识别', () => {
    const n = 'abc';
    const s = new OscScanner(n);
    const full = 'pre' + intro(`133;D;5;${n}`, BEL) + 'post';
    const a = full.slice(0, 8);
    const b = full.slice(8);
    expect(s.push(a).length).toBe(0);
    const ms = s.push(b);
    expect(ms.length).toBe(1);
    expect(ms[0].exitCode).toBe(5);
  });

  it('seq 单调递增', () => {
    const n = 'abc';
    const s = new OscScanner(n);
    const first = s.push(intro(`133;A;${n}`, BEL));
    const second = s.push(intro(`133;D;0;${n}`, BEL));
    expect(first[0].seq).toBe(1);
    expect(second[0].seq).toBe(2);
    expect(s.count).toBe(2);
  });

  it('makeNonce 生成唯一且非空', () => {
    const a = makeNonce();
    const b = makeNonce();
    expect(a.length).toBeGreaterThan(3);
    expect(a).not.toBe(b);
  });
});
