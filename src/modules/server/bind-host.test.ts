// src/modules/server/bind-host.test.ts
// 后端绑定地址解析测试：dev 模式强制回环，防止把开发环境暴露到局域网。
//
// 判定优先级：dev（MOSS_DEV=1）→ remote.enabled（0.0.0.0）→ bindLocalhostOnly → server.host。

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { computeBindHost } from './index';

type Cfg = Parameters<typeof computeBindHost>[0];

function cfg(opts: { remoteEnabled?: boolean; bindLocalhostOnly?: boolean; host?: string }): Cfg {
  return {
    remote: { enabled: opts.remoteEnabled ?? false },
    security: { bindLocalhostOnly: opts.bindLocalhostOnly ?? true },
    server: { host: opts.host ?? '127.0.0.1' },
  };
}

describe('computeBindHost', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.MOSS_DEV;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.MOSS_DEV;
    else process.env.MOSS_DEV = saved;
  });

  test('dev 模式覆盖 remote.enabled：即使远程开启也强制回环', () => {
    process.env.MOSS_DEV = '1';
    expect(computeBindHost(cfg({ remoteEnabled: true, bindLocalhostOnly: true }))).toBe('127.0.0.1');
  });

  test('dev 模式覆盖自定义 host（0.0.0.0 也强制回环）', () => {
    process.env.MOSS_DEV = '1';
    expect(
      computeBindHost(cfg({ remoteEnabled: false, bindLocalhostOnly: false, host: '0.0.0.0' })),
    ).toBe('127.0.0.1');
  });

  test('非 dev + remote.enabled：绑定 0.0.0.0', () => {
    delete process.env.MOSS_DEV;
    expect(computeBindHost(cfg({ remoteEnabled: true, bindLocalhostOnly: true }))).toBe('0.0.0.0');
  });

  test('非 dev + bindLocalhostOnly：绑定回环', () => {
    delete process.env.MOSS_DEV;
    expect(computeBindHost(cfg({ remoteEnabled: false, bindLocalhostOnly: true }))).toBe('127.0.0.1');
  });

  test('非 dev + 自定义 host：沿用 server.host', () => {
    delete process.env.MOSS_DEV;
    expect(
      computeBindHost(cfg({ remoteEnabled: false, bindLocalhostOnly: false, host: '192.168.1.5' })),
    ).toBe('192.168.1.5');
  });
});