// src/modules/remote/auth.test.ts
// 认证核心单元测试：密码生成/轮换/自定义、cookie 签发与校验（sessionKey 轮换作废）、
// 三层登录速率限制矩阵。

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteAuth, RateLimiter, isValidPin, generatePin, parseCookies, REMOTE_COOKIE } from './auth';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'moss-remote-test-'));
}

describe('PIN 工具', () => {
  test('isValidPin：仅 8 位数字有效', () => {
    expect(isValidPin('00000000')).toBe(true);
    expect(isValidPin('12345678')).toBe(true);
    expect(isValidPin('1234567')).toBe(false);
    expect(isValidPin('123456789')).toBe(false);
    expect(isValidPin('1234567a')).toBe(false);
    expect(isValidPin('')).toBe(false);
  });

  test('generatePin：恒为 8 位数字', () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePin()).toMatch(/^\d{8}$/);
    }
  });

  test('parseCookies：基础解析', () => {
    const out = parseCookies('a=1; moss_remote_session=abc; b=2');
    expect(out['a']).toBe('1');
    expect(out[REMOTE_COOKIE]).toBe('abc');
    expect(out['b']).toBe('2');
  });
});

describe('RateLimiter（三层防护）', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ windowMs: 60_000, maxFailures: 5, lockMs: 60_000, globalMaxFailures: 50, globalLockMs: 30_000 });
  });

  test('未失败时不锁定', () => {
    expect(limiter.status('1.1.1.1').locked).toBe(false);
  });

  test('单 IP 5 次失败 → 锁定 60s', () => {
    for (let i = 0; i < 4; i++) limiter.record('1.1.1.1');
    expect(limiter.status('1.1.1.1').locked).toBe(false);
    limiter.record('1.1.1.1');
    const st = limiter.status('1.1.1.1');
    expect(st.locked).toBe(true);
    expect(st.retryAfter).toBeGreaterThan(0);
    expect(st.retryAfter).toBeLessThanOrEqual(60);
  });

  test('成功登录清零计数与锁', () => {
    for (let i = 0; i < 5; i++) limiter.record('1.1.1.1');
    expect(limiter.status('1.1.1.1').locked).toBe(true);
    limiter.clear('1.1.1.1');
    expect(limiter.status('1.1.1.1').locked).toBe(false);
  });

  test('窗口过期后计数重置（短窗口）', async () => {
    const fast = new RateLimiter({ windowMs: 30, maxFailures: 3, lockMs: 10, globalMaxFailures: 1000, globalLockMs: 10 });
    fast.record('2.2.2.2');
    fast.record('2.2.2.2');
    fast.record('2.2.2.2');
    expect(fast.status('2.2.2.2').locked).toBe(true);
    await new Promise(r => setTimeout(r, 60));
    expect(fast.status('2.2.2.2').locked).toBe(false);
  });

  test('全局失败超阈值 → 全局锁（防换 IP 分布式扫描）', () => {
    const g = new RateLimiter({ windowMs: 60_000, maxFailures: 1000, lockMs: 60_000, globalMaxFailures: 3, globalLockMs: 30_000 });
    g.record('1.1.1.1');
    g.record('2.2.2.2');
    g.record('3.3.3.3');
    // 任何 IP（包括从未失败的）都被全局锁
    expect(g.status('9.9.9.9').locked).toBe(true);
  });
});

describe('RemoteAuth（密码 + cookie 会话）', () => {
  let dir: string;
  let auth: RemoteAuth;

  beforeEach(async () => {
    dir = tempDir();
    auth = new RemoteAuth(dir);
    await auth.loadOrInit();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('loadOrInit：生成两份 8 位密码', () => {
    expect(auth.getPin('lan')).toMatch(/^\d{8}$/);
    expect(auth.getPin('public')).toMatch(/^\d{8}$/);
  });

  test('密码持久化：新实例读回相同值', async () => {
    const lanPin = auth.getPin('lan');
    const auth2 = new RemoteAuth(dir);
    await auth2.loadOrInit();
    expect(auth2.getPin('lan')).toBe(lanPin);
  });

  test('refreshPin：轮换并清自定义标记', async () => {
    await auth.setCustomPin('public', '87654321');
    expect(auth.isCustomized('public')).toBe(true);
    const next = await auth.refreshPin('public');
    expect(next).toMatch(/^\d{8}$/);
    expect(auth.isCustomized('public')).toBe(false);
  });

  test('setCustomPin：拒绝非法格式', async () => {
    await expect(auth.setCustomPin('lan', '12345')).rejects.toThrow();
    await expect(auth.setCustomPin('lan', 'abcdefgh')).rejects.toThrow();
  });

  test('verifyPin：精确匹配', () => {
    const pin = auth.getPin('lan');
    expect(auth.verifyPin('lan', pin)).toBe(true);
    // 任意与真值不同的字符串都应失败（构造一个必然不同的候选）
    const wrong = pin === '99999999' ? '11111111' : '99999999';
    expect(auth.verifyPin('lan', wrong)).toBe(false);
    expect(auth.verifyPin('lan', 'short')).toBe(false);
    expect(auth.verifyPin('lan', '')).toBe(false);
  });

  test('cookie：签发与校验（分域隔离）', () => {
    const cookie = `${REMOTE_COOKIE}=${auth.cookieValue('lan')}`;
    expect(auth.checkCookie(cookie, 'lan')).toBe(true);
    // lan cookie 不能过 public 域（严格分域）
    expect(auth.checkCookie(cookie, 'public')).toBe(false);
  });

  test('rotateSessions：旧 cookie 全部作废', () => {
    const cookie = `${REMOTE_COOKIE}=${auth.cookieValue('lan')}`;
    expect(auth.checkCookie(cookie, 'lan')).toBe(true);
    auth.rotateSessions();
    expect(auth.checkCookie(cookie, 'lan')).toBe(false);
  });

  test('refreshPin 后旧 cookie 失效（密码轮换即作废旧会话）', async () => {
    const cookie = `${REMOTE_COOKIE}=${auth.cookieValue('lan')}`;
    expect(auth.checkCookie(cookie, 'lan')).toBe(true);
    await auth.refreshPin('lan');
    expect(auth.checkCookie(cookie, 'lan')).toBe(false);
  });

  test('buildSetCookie：HttpOnly + SameSite=Lax + 30 天', () => {
    const sc = auth.buildSetCookie('lan');
    expect(sc).toContain(`${REMOTE_COOKIE}=`);
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Lax');
    expect(sc).toContain('Max-Age=2592000');
  });
});
