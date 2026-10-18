// src/modules/remote/guard.test.ts
// 请求门卫安全判定矩阵测试（核心防伪造逻辑）：
// 客户端 IP × Host 组合、登录端点、HTML/API 分流、checkWS 一致性。
//
// 安全原理：
// - 局域网攻击者无法把 TCP 源地址伪装成 loopback；
// - 非 loopback 来源声称隧道域名 → 一律按公网强密码处理，伪造无收益。

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '../../core/types';
import { RemoteAuth, REMOTE_COOKIE } from './auth';
import { RemoteGuard, isLoopbackAddress, hostnameOf, isTunnelHost, effectiveClientIp } from './guard';
import type { GuardRequestContext } from '../server/types';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'moss-remote-guard-'));
}

interface ConfigShape {
  remote: { enabled: boolean; lanEnabled: boolean; lanPasswordEnabled: boolean; lanIpOverride: string };
  security: { authToken: string; bindLocalhostOnly: boolean };
}

/** 形状 mock：getAppConfig 返回同一引用（测试直接 mutate shape 即时生效） */
function mockConfig(shape: ConfigShape): ConfigService {
  return { getAppConfig: () => shape } as unknown as ConfigService;
}

function ctx(opts: Partial<GuardRequestContext> & { clientIp: string; host: string }): GuardRequestContext {
  return {
    method: opts.method ?? 'GET',
    url: opts.url ?? '/',
    headers: opts.headers ?? { host: opts.host },
    clientIp: opts.clientIp,
  };
}

describe('地址判定工具', () => {
  test('isLoopbackAddress：兼容 IPv6-mapped', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('127.0.0.5')).toBe(true);
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackAddress('::ffff:192.168.1.5')).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });

  test('hostnameOf：去端口 / 去 IPv6 方括号', () => {
    expect(hostnameOf('127.0.0.1:7766')).toBe('127.0.0.1');
    expect(hostnameOf('abc-xyz.trycloudflare.com')).toBe('abc-xyz.trycloudflare.com');
    expect(hostnameOf('abc-xyz.trycloudflare.com:443')).toBe('abc-xyz.trycloudflare.com');
    expect(hostnameOf('[::1]:8080')).toBe('::1');
  });

  test('isTunnelHost：仅 trycloudflare 域', () => {
    expect(isTunnelHost('abc-xyz.trycloudflare.com')).toBe(true);
    expect(isTunnelHost('ABC-XYZ.TRYCLOUDFLARE.COM:443')).toBe(true);
    expect(isTunnelHost('127.0.0.1:7766')).toBe(false);
    expect(isTunnelHost('192.168.1.5:7766')).toBe(false);
    expect(isTunnelHost('evil.com')).toBe(false);
  });

  test('effectiveClientIp：仅隧道流量信任 cf-connecting-ip', () => {
    const tunnel = ctx({
      clientIp: '::ffff:127.0.0.1',
      host: 'abc.trycloudflare.com',
      headers: { host: 'abc.trycloudflare.com', 'cf-connecting-ip': '203.0.113.9' },
    });
    expect(effectiveClientIp(tunnel)).toBe('203.0.113.9');

    // 非隧道流量：伪造 cf-connecting-ip 不被信任
    const lan = ctx({
      clientIp: '192.168.1.5',
      host: '192.168.1.100:7766',
      headers: { host: '192.168.1.100:7766', 'cf-connecting-ip': '1.2.3.4' },
    });
    expect(effectiveClientIp(lan)).toBe('192.168.1.5');
  });
});

describe('RemoteGuard 判定矩阵', () => {
  let dir: string;
  let auth: RemoteAuth;
  let guard: RemoteGuard;
  let tunnelRunning: boolean;
  let config: ConfigShape;

  beforeEach(async () => {
    dir = tempDir();
    auth = new RemoteAuth(dir);
    await auth.loadOrInit();
    tunnelRunning = true;
    config = {
      remote: { enabled: true, lanEnabled: true, lanPasswordEnabled: true, lanIpOverride: '' },
      security: { authToken: 'secret-token', bindLocalhostOnly: true },
    };
    guard = new RemoteGuard({
      config: mockConfig(config),
      auth,
      isTunnelRunning: () => tunnelRunning,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('远程未启用 → 一切直通（零开销路径）', () => {
    config.remote.enabled = false;
    const verdict = guard.precheck(ctx({ clientIp: '192.168.1.5', host: '192.168.1.100:7766' }));
    expect(verdict.action).toBe('pass');
  });

  test('本机（loopback 客户端 + 非隧道 Host）→ 现状行为不变', () => {
    const verdict = guard.precheck(ctx({ clientIp: '::ffff:127.0.0.1', host: '127.0.0.1:7766' }));
    expect(verdict.action).toBe('pass');
  });

  test('公网（隧道 Host，无论客户端 IP）+ 无 cookie → HTML 返回登录页', () => {
    // cloudflared 回连场景（loopback 客户端）
    const v1 = guard.precheck(ctx({
      clientIp: '::ffff:127.0.0.1',
      host: 'abc.trycloudflare.com',
      url: '/',
      headers: { host: 'abc.trycloudflare.com', accept: 'text/html' },
    }));
    expect(v1.action).toBe('respond');
    if (v1.action === 'respond') {
      expect(v1.response.status).toBe(200);
      expect(v1.response.headers['content-type']).toContain('text/html');
      expect(v1.response.body).toContain('remote/login');
    }
    // 伪造直连场景（非 loopback 客户端声称隧道域名）→ 同样强制公网密码
    const v2 = guard.precheck(ctx({
      clientIp: '192.168.1.5',
      host: 'abc.trycloudflare.com',
      url: '/',
      headers: { host: 'abc.trycloudflare.com', accept: 'text/html' },
    }));
    expect(v2.action).toBe('respond');
  });

  test('公网 + API 请求（无 cookie）→ 401 JSON', () => {
    const verdict = guard.precheck(ctx({
      clientIp: '::ffff:127.0.0.1',
      host: 'abc.trycloudflare.com',
      url: '/api/session',
      headers: { host: 'abc.trycloudflare.com', accept: 'application/json' },
    }));
    expect(verdict.action).toBe('respond');
    if (verdict.action === 'respond') {
      expect(verdict.response.status).toBe(401);
      expect(verdict.response.body).toContain('unauthorized');
    }
  });

  test('隧道未运行 + 隧道 Host → 403（防伪造探活）', () => {
    tunnelRunning = false;
    const verdict = guard.precheck(ctx({
      clientIp: '192.168.1.5',
      host: 'abc.trycloudflare.com',
      url: '/',
      headers: { host: 'abc.trycloudflare.com', accept: 'text/html' },
    }));
    expect(verdict.action).toBe('respond');
    if (verdict.action === 'respond') expect(verdict.response.status).toBe(403);
  });

  test('公网 + 有效 public cookie → pass-authenticated（注入 Authorization）', () => {
    const cookie = `${REMOTE_COOKIE}=${auth.cookieValue('public')}`;
    const verdict = guard.precheck(ctx({
      clientIp: '::ffff:127.0.0.1',
      host: 'abc.trycloudflare.com',
      url: '/api/session',
      headers: { host: 'abc.trycloudflare.com', cookie },
    }));
    expect(verdict.action).toBe('pass-authenticated');
    if (verdict.action === 'pass-authenticated') {
      expect(verdict.authorization).toBe('Bearer secret-token');
    }
  });

  test('authToken 为空时 cookie 认证仍放行（pass，无需注入）', () => {
    config.security.authToken = '';
    const cookie = `${REMOTE_COOKIE}=${auth.cookieValue('public')}`;
    const verdict = guard.precheck(ctx({
      clientIp: '::ffff:127.0.0.1',
      host: 'abc.trycloudflare.com',
      headers: { host: 'abc.trycloudflare.com', cookie },
    }));
    expect(verdict.action).toBe('pass');
  });

  test('lan cookie 不能过公网域（严格分域）', () => {
    const cookie = `${REMOTE_COOKIE}=${auth.cookieValue('lan')}`;
    const verdict = guard.precheck(ctx({
      clientIp: '::ffff:127.0.0.1',
      host: 'abc.trycloudflare.com',
      headers: { host: 'abc.trycloudflare.com', cookie },
    }));
    expect(verdict.action).toBe('respond');
  });

  test('局域网（非 loopback 客户端）+ lanEnabled=false → 403', () => {
    config.remote.lanEnabled = false;
    const html = guard.precheck(ctx({
      clientIp: '192.168.1.5',
      host: '192.168.1.100:7766',
      url: '/',
      headers: { host: '192.168.1.100:7766', accept: 'text/html' },
    }));
    expect(html.action).toBe('respond');
    if (html.action === 'respond') {
      expect(html.response.status).toBe(403);
      expect(html.response.body).toContain('局域网访问已关闭');
    }
    const api = guard.precheck(ctx({
      clientIp: '192.168.1.5',
      host: '192.168.1.100:7766',
      url: '/api/session',
      headers: { host: '192.168.1.100:7766', accept: 'application/json' },
    }));
    expect(api.action).toBe('respond');
    if (api.action === 'respond') {
      expect(api.response.status).toBe(403);
      expect(api.response.body).toContain('lan-disabled');
    }
  });

  test('局域网 + 密码关 → 直接放行', () => {
    config.remote.lanPasswordEnabled = false;
    const verdict = guard.precheck(ctx({ clientIp: '192.168.1.5', host: '192.168.1.100:7766' }));
    expect(verdict.action).toBe('pass');
  });

  test('登录页公开资源 /MOSS.png：未认证也放行（GET）；POST 或其他路径不放行', () => {
    // 局域网 + 密码开，未认证 → 图标放行
    const lan = guard.precheck(ctx({
      clientIp: '192.168.1.5',
      host: '192.168.1.100:7766',
      url: '/MOSS.png',
      headers: { host: '192.168.1.100:7766' },
    }));
    expect(lan.action).toBe('pass');
    // 公网（隧道 Host）未认证 → 图标放行
    const pub = guard.precheck(ctx({
      clientIp: '::ffff:127.0.0.1',
      host: 'abc.trycloudflare.com',
      url: '/MOSS.png',
      headers: { host: 'abc.trycloudflare.com' },
    }));
    expect(pub.action).toBe('pass');
    // 非 GET/HEAD → 不因白名单放行
    const post = guard.precheck(ctx({
      method: 'POST',
      clientIp: '192.168.1.5',
      host: '192.168.1.100:7766',
      url: '/MOSS.png',
      headers: { host: '192.168.1.100:7766' },
    }));
    expect(post.action).not.toBe('pass');
    // 其他路径 → 不因白名单放行
    const other = guard.precheck(ctx({
      clientIp: '192.168.1.5',
      host: '192.168.1.100:7766',
      url: '/other.png',
      headers: { host: '192.168.1.100:7766' },
    }));
    expect(other.action).not.toBe('pass');
  });

  test('登录页逃生路径 /api/remote-gate：未认证返回登录页；已认证 302 回首页', () => {
    // 局域网未认证 → 直接返回登录页
    const lanHtml = guard.precheck(ctx({
      clientIp: '192.168.1.5',
      host: '192.168.1.100:7766',
      url: '/api/remote-gate',
      headers: { host: '192.168.1.100:7766', accept: 'text/html' },
    }));
    expect(lanHtml.action).toBe('respond');
    if (lanHtml.action === 'respond') {
      expect(lanHtml.response.status).toBe(200);
      expect(lanHtml.response.body).toContain('remote/login');
    }
    // 公网（隧道 Host）未认证 → 直接返回登录页
    const pubHtml = guard.precheck(ctx({
      clientIp: '::ffff:127.0.0.1',
      host: 'abc.trycloudflare.com',
      url: '/api/remote-gate',
      headers: { host: 'abc.trycloudflare.com', accept: 'text/html' },
    }));
    expect(pubHtml.action).toBe('respond');
    if (pubHtml.action === 'respond') {
      expect(pubHtml.response.status).toBe(200);
      expect(pubHtml.response.body).toContain('remote/login');
    }
    // 已认证（lan cookie）→ 302 回首页
    const cookie = `${REMOTE_COOKIE}=${auth.cookieValue('lan')}`;
    const authed = guard.precheck(ctx({
      clientIp: '192.168.1.5',
      host: '192.168.1.100:7766',
      url: '/api/remote-gate',
      headers: { host: '192.168.1.100:7766', accept: 'text/html', cookie },
    }));
    expect(authed.action).toBe('respond');
    if (authed.action === 'respond') {
      expect(authed.response.status).toBe(302);
      expect(authed.response.headers['location']).toBe('/');
    }
    // POST 不特殊处理：返回 401 JSON 而非登录页
    const post = guard.precheck(ctx({
      method: 'POST',
      clientIp: '192.168.1.5',
      host: '192.168.1.100:7766',
      url: '/api/remote-gate',
      headers: { host: '192.168.1.100:7766' },
    }));
    expect(post.action).toBe('respond');
    if (post.action === 'respond') expect(post.response.body).not.toContain('remote/login');
  });

  test('局域网 + 密码开 + 有效 lan cookie → pass-authenticated', () => {
    const cookie = `${REMOTE_COOKIE}=${auth.cookieValue('lan')}`;
    const verdict = guard.precheck(ctx({
      clientIp: '192.168.1.5',
      host: '192.168.1.100:7766',
      headers: { host: '192.168.1.100:7766', cookie },
    }));
    expect(verdict.action).toBe('pass-authenticated');
  });

  test('POST /remote/login → login action（不进 router）', () => {
    const verdict = guard.precheck(ctx({
      method: 'POST',
      clientIp: '192.168.1.5',
      host: '192.168.1.100:7766',
      url: '/remote/login',
      headers: { host: '192.168.1.100:7766' },
    }));
    expect(verdict.action).toBe('login');
  });

  test('checkWS 与 precheck 一致（未认证拒绝 / 已认证放行）', () => {
    expect(guard.checkWS(ctx({ clientIp: '192.168.1.5', host: '192.168.1.100:7766' }))).toBe(false);
    const cookie = `${REMOTE_COOKIE}=${auth.cookieValue('lan')}`;
    expect(guard.checkWS(ctx({
      clientIp: '192.168.1.5',
      host: '192.168.1.100:7766',
      headers: { host: '192.168.1.100:7766', cookie },
    }))).toBe(true);
    // 本机直连
    expect(guard.checkWS(ctx({ clientIp: '::ffff:127.0.0.1', host: '127.0.0.1:7766' }))).toBe(true);
  });
});

describe('RemoteGuard 登录端点', () => {
  let dir: string;
  let auth: RemoteAuth;
  let guard: RemoteGuard;

  beforeEach(async () => {
    dir = tempDir();
    auth = new RemoteAuth(dir);
    await auth.loadOrInit();
    guard = new RemoteGuard({
      config: mockConfig({
        remote: { enabled: true, lanEnabled: true, lanPasswordEnabled: true, lanIpOverride: '' },
        security: { authToken: '', bindLocalhostOnly: true },
      }),
      auth,
      isTunnelRunning: () => true,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function loginCtx(host: string): GuardRequestContext {
    return {
      method: 'POST',
      url: '/remote/login',
      headers: { host },
      clientIp: '192.168.1.5',
    };
  }

  test('正确密码 → 302 + Set-Cookie', () => {
    const resp = guard.handleLogin(loginCtx('192.168.1.100:7766'), `token=${auth.getPin('lan')}`);
    expect(resp.status).toBe(302);
    expect(resp.headers['set-cookie']).toContain(REMOTE_COOKIE);
    expect(resp.headers['set-cookie']).toContain('HttpOnly');
  });

  test('错误密码 → 200 登录页（错误提示）+ 计失败', () => {
    const resp = guard.handleLogin(loginCtx('192.168.1.100:7766'), 'token=00000000');
    expect(resp.status).toBe(200);
    expect(resp.body).toContain('密码错误');
  });

  test('公网 Host 的登录按 public 密码校验', () => {
    const lanPin = auth.getPin('lan');
    const resp = guard.handleLogin(loginCtx('abc.trycloudflare.com'), `token=${lanPin}`);
    // lan 密码不能过公网域
    expect(resp.status).toBe(200);
    const resp2 = guard.handleLogin(loginCtx('abc.trycloudflare.com'), `token=${auth.getPin('public')}`);
    expect(resp2.status).toBe(302);
  });

  test('锁定期间 → 429 登录页（带剩余秒数）', async () => {
    // 快速失败 5 次（注入短窗口 limiter）
    const fastAuth = new RemoteAuth(dir, { windowMs: 60_000, maxFailures: 5, lockMs: 60_000, globalMaxFailures: 1000, globalLockMs: 30_000 });
    await fastAuth.loadOrInit();
    const fastGuard = new RemoteGuard({
      config: mockConfig({
        remote: { enabled: true, lanEnabled: true, lanPasswordEnabled: true, lanIpOverride: '' },
        security: { authToken: '', bindLocalhostOnly: true },
      }),
      auth: fastAuth,
      isTunnelRunning: () => true,
    });
    for (let i = 0; i < 5; i++) {
      fastGuard.handleLogin(loginCtx('192.168.1.100:7766'), 'token=00000000');
    }
    // 第 6 次（即使密码正确）也被锁
    const resp = fastGuard.handleLogin(loginCtx('192.168.1.100:7766'), `token=${fastAuth.getPin('lan')}`);
    expect(resp.status).toBe(429);
    expect(resp.body).toContain('尝试次数过多');
  });

  test('成功登录清零该 IP 失败计数', () => {
    for (let i = 0; i < 4; i++) {
      guard.handleLogin(loginCtx('192.168.1.100:7766'), 'token=00000000');
    }
    const ok = guard.handleLogin(loginCtx('192.168.1.100:7766'), `token=${auth.getPin('lan')}`);
    expect(ok.status).toBe(302);
    // 清零后再错 4 次不触发锁
    for (let i = 0; i < 4; i++) {
      const r = guard.handleLogin(loginCtx('192.168.1.100:7766'), 'token=00000000');
      expect(r.status).toBe(200);
    }
  });
});
