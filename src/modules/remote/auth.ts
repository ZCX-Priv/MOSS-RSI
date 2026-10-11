// src/modules/remote/auth.ts
// 远程访问认证：8 位数字密码管理 + 进程级 sessionKey + HttpOnly cookie + 登录速率限制。
// 认证段，按 MOSS 模块规范 TS 化。
//
// 设计要点：
// - 密码与 API authToken 完全独立，分 lan/public 两个作用域（严格分域）；
// - cookie 值 = sha256(pin:sessionKey)：sessionKey 是进程级随机密钥，
//   MOSS 重启后旧 cookie 全部失效（手机需重新输入一次）；
// - 三层速率限制防暴力破解（内存态，随进程生命周期）。

import { createHash, randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RemoteScope } from './types';

/** cookie 名（登录成功后种下，SPA 的 API/WS 请求自动携带） */
export const REMOTE_COOKIE = 'moss_remote_session';
/** cookie 有效期（秒）：30 天 */
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

/** 密码文件名（~/.moss/remote/ 下） */
const PIN_FILES: Record<RemoteScope, string> = {
  lan: 'token-lan',
  public: 'token-public',
};

/** 自定义密码标记文件（~/.moss/remote/settings.json） */
const SETTINGS_FILE = 'settings.json';

/** 8 位数字密码校验 */
export function isValidPin(value: string): boolean {
  return /^\d{8}$/.test(value);
}

/** 生成 8 位数字密码 */
export function generatePin(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// 登录速率限制（三层）
// ---------------------------------------------------------------------------

export interface RateLimitStatus {
  locked: boolean;
  retryAfter: number;
}

export interface RateLimitOptions {
  /** 失败计数滑动窗口（ms） */
  windowMs: number;
  /** 窗口内失败阈值 → 触发单 IP 锁 */
  maxFailures: number;
  /** 单 IP 锁定时长（ms） */
  lockMs: number;
  /** 全局失败阈值（同窗口）→ 触发全局锁 */
  globalMaxFailures: number;
  /** 全局锁定时长（ms） */
  globalLockMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60_000,
  maxFailures: 5,
  lockMs: 60_000,
  globalMaxFailures: 50,
  globalLockMs: 30_000,
};

/** 内存态滑动窗口速率限制器（测试可注入短窗口参数） */
export class RateLimiter {
  private readonly cfg: RateLimitOptions;
  private readonly failCounts = new Map<string, { count: number; windowStart: number }>();
  private readonly ipLocks = new Map<string, number>();
  private readonly global = { count: 0, windowStart: 0, lockedUntil: 0 };

  constructor(cfg: Partial<RateLimitOptions> = {}) {
    this.cfg = { ...DEFAULT_RATE_LIMIT, ...cfg };
  }

  /** 该 IP 当前是否被锁；返回 { locked, retryAfter(秒) }。 */
  status(ip: string): RateLimitStatus {
    const now = Date.now();
    if (this.global.lockedUntil > now) {
      return { locked: true, retryAfter: Math.ceil((this.global.lockedUntil - now) / 1000) };
    }
    const until = this.ipLocks.get(ip) ?? 0;
    if (until > now) {
      return { locked: true, retryAfter: Math.ceil((until - now) / 1000) };
    }
    return { locked: false, retryAfter: 0 };
  }

  /** 记一次失败：维护滑动窗口计数，达阈值触发单 IP / 全局锁。 */
  record(ip: string): void {
    const now = Date.now();
    let rec = this.failCounts.get(ip);
    if (!rec || now - rec.windowStart > this.cfg.windowMs) {
      rec = { count: 0, windowStart: now };
    }
    rec.count++;
    this.failCounts.set(ip, rec);
    if (now - this.global.windowStart > this.cfg.windowMs) {
      this.global.count = 0;
      this.global.windowStart = now;
    }
    this.global.count++;
    if (rec.count >= this.cfg.maxFailures) {
      this.ipLocks.set(ip, now + this.cfg.lockMs);
    }
    if (this.global.count >= this.cfg.globalMaxFailures) {
      this.global.lockedUntil = now + this.cfg.globalLockMs;
    }
    // 防内存膨胀：超过 2000 条记录时清掉已过窗口期的条目
    if (this.failCounts.size > 2000) {
      for (const [k, v] of this.failCounts) {
        if (now - v.windowStart > this.cfg.windowMs) this.failCounts.delete(k);
      }
    }
  }

  /** 成功登录：清空该 IP 计数与锁。 */
  clear(ip: string): void {
    this.failCounts.delete(ip);
    this.ipLocks.delete(ip);
  }
}

// ---------------------------------------------------------------------------
// cookie 工具
// ---------------------------------------------------------------------------

/** 解析 Cookie 头为键值表 */
export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// RemoteAuth：密码 + sessionKey + cookie 校验
// ---------------------------------------------------------------------------

interface PersistedSettings {
  lanCustomized: boolean;
  publicCustomized: boolean;
}

/**
 * 远程访问认证器。
 * 密码持久化在 ~/.moss/remote/（独立于 config.json，避免经 /api/config 暴露）；
 * sessionKey 仅存在内存（进程重启即轮换全部会话）。
 */
export class RemoteAuth {
  private sessionKey: string;
  private pins: Record<RemoteScope, string> = { lan: '', public: '' };
  private settings: PersistedSettings = { lanCustomized: false, publicCustomized: false };
  readonly limiter: RateLimiter;

  constructor(
    private readonly remoteDir: string,
    limiterOptions: Partial<RateLimitOptions> = {},
  ) {
    this.sessionKey = crypto.randomUUID();
    this.limiter = new RateLimiter(limiterOptions);
  }

  /** 模块初始化：加载（缺失则生成）两个密码与自定义标记。 */
  async loadOrInit(): Promise<void> {
    await mkdir(this.remoteDir, { recursive: true });
    for (const scope of ['lan', 'public'] as const) {
      this.pins[scope] = await this.loadPin(scope);
    }
    await this.loadSettings();
  }

  /** 读取当前密码明文（设置页显示用；未初始化时为空串） */
  getPin(scope: RemoteScope): string {
    return this.pins[scope];
  }

  /** 公网密码是否已自定义（自定义后开启隧道不再自动轮换） */
  isCustomized(scope: RemoteScope): boolean {
    return scope === 'lan' ? this.settings.lanCustomized : this.settings.publicCustomized;
  }

  /** 轮换密码（8 位随机数字），并清除自定义标记。返回新密码。 */
  async refreshPin(scope: RemoteScope): Promise<string> {
    const pin = generatePin();
    this.pins[scope] = pin;
    if (scope === 'lan') this.settings.lanCustomized = false;
    else this.settings.publicCustomized = false;
    await this.persistPin(scope);
    await this.persistSettings();
    return pin;
  }

  /** 设置自定义固定密码（8 位数字）；自定义后 refreshPin 语义仍可手动触发。 */
  async setCustomPin(scope: RemoteScope, value: string): Promise<void> {
    if (!isValidPin(value)) {
      throw new Error('PIN must be 8 digits | 密码必须是 8 位数字');
    }
    this.pins[scope] = value;
    if (scope === 'lan') this.settings.lanCustomized = true;
    else this.settings.publicCustomized = true;
    await this.persistPin(scope);
    await this.persistSettings();
  }

  /** 校验登录提交的密码是否匹配指定作用域。 */
  verifyPin(scope: RemoteScope, submitted: string): boolean {
    return submitted === this.pins[scope] && this.pins[scope] !== '';
  }

  /** cookie 期望值：sha256(pin:sessionKey)。 */
  cookieValue(scope: RemoteScope): string {
    return createHash('sha256').update(`${this.pins[scope]}:${this.sessionKey}`).digest('hex');
  }

  /** 校验 Cookie 头是否携带指定作用域的有效会话。 */
  checkCookie(cookieHeader: string, scope: RemoteScope): boolean {
    const token = parseCookies(cookieHeader)[REMOTE_COOKIE];
    return token !== undefined && token === this.cookieValue(scope);
  }

  /** 登录成功后种 cookie 的 Set-Cookie 头值。 */
  buildSetCookie(scope: RemoteScope): string {
    return `${REMOTE_COOKIE}=${this.cookieValue(scope)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
  }

  /** 作废全部会话（轮换 sessionKey；密码不变，旧 cookie 全部失效）。 */
  rotateSessions(): void {
    this.sessionKey = crypto.randomUUID();
  }

  // -------------------------------------------------------------------------

  private pinPath(scope: RemoteScope): string {
    return join(this.remoteDir, PIN_FILES[scope]);
  }

  private settingsPath(): string {
    return join(this.remoteDir, SETTINGS_FILE);
  }

  private async loadPin(scope: RemoteScope): Promise<string> {
    try {
      const raw = (await readFile(this.pinPath(scope), 'utf8')).trim();
      if (isValidPin(raw)) return raw;
    } catch {
      // 文件不存在 → 生成
    }
    const pin = generatePin();
    this.pins[scope] = pin;
    await this.persistPin(scope);
    return pin;
  }

  private async persistPin(scope: RemoteScope): Promise<void> {
    await mkdir(this.remoteDir, { recursive: true });
    await writeFile(this.pinPath(scope), this.pins[scope], 'utf8');
  }

  private async loadSettings(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.settingsPath(), 'utf8')) as Partial<PersistedSettings>;
      this.settings = {
        lanCustomized: Boolean(raw.lanCustomized),
        publicCustomized: Boolean(raw.publicCustomized),
      };
    } catch {
      // 缺失/损坏 → 默认值（首次使用）
    }
  }

  private async persistSettings(): Promise<void> {
    await mkdir(this.remoteDir, { recursive: true });
    await writeFile(this.settingsPath(), JSON.stringify(this.settings, null, 2), 'utf8');
  }
}
