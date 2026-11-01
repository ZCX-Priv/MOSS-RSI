// src/modules/tools/wait/logic.ts
// wait 工具的纯逻辑：时间解析、等待窗口换算、条件归一化与组合判定。
// 与执行入口分离，不依赖任何服务实例，便于单测。

export const WAIT_LIMITS = {
  /** 最短等待（ms）：防止忙等 */
  minDurationMs: 100,
  /** 单次等待硬上限（ms）：30 分钟 */
  maxDurationMs: 1_800_000,
} as const;

export type WaitMatch = 'all' | 'any';

export type NormalizedCondition =
  | { kind: 'session'; sessionId: string }
  | { kind: 'terminal'; sessionId: string; terminalId?: string }
  | { kind: 'tool'; sessionId: string; toolCallId: string };

export interface WaitTimeInput {
  duration?: string;
  until?: string;
}

export type WindowKind = 'duration' | 'until' | 'default';

export interface ResolvedWindow {
  kind: WindowKind;
  /** 窗口截止时间戳（ms）；until 早于当前时间时允许是过去值 */
  endAt: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/**
 * 解析时长：`1500ms` / `30s` / `5min`（大小写不敏感，允许小数）。
 * 仅接受 ms / s / min 三种单位；结果小于最小值时报错。
 */
export function parseDuration(text: string): Result<number> {
  const raw = text.trim();
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|min)$/i.exec(raw);
  if (!m) return fail(`无法解析时长「${text}」：仅支持 ms / s / min，例如 1500ms、30s、5min`);
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return fail(`时长必须为正数：${text}`);
  const unit = m[2].toLowerCase();
  const ms = Math.round(value * (unit === 'ms' ? 1 : unit === 's' ? 1_000 : 60_000));
  if (ms < WAIT_LIMITS.minDurationMs) {
    return fail(`时长不能小于 ${WAIT_LIMITS.minDurationMs}ms：${text}`);
  }
  return { ok: true, value: ms };
}

/**
 * 解析目标时刻：ISO 8601 或本地 HH:mm / HH:mm:ss。
 * - 纯时刻取「下一次」该时刻（今天已过则明天）；
 * - ISO 时间允许早于当前时间（表示该时间条件已满足）。
 */
export function parseUntil(text: string, nowMs: number): Result<number> {
  const raw = text.trim();
  if (!raw) return fail('until 不能为空');

  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (hm) {
    const h = Number(hm[1]);
    const mi = Number(hm[2]);
    const s = Number(hm[3] ?? 0);
    if (h > 23 || mi > 59 || s > 59) return fail(`时刻不合法：${text}`);
    const d = new Date(nowMs);
    d.setHours(h, mi, s, 0);
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
    return { ok: true, value: d.getTime() };
  }

  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return fail(`无法解析时间「${text}」：请用 ISO 8601 或 HH:mm / HH:mm:ss`);
  return { ok: true, value: ts };
}

/**
 * 计算等待窗口：
 * - duration 与 until 互斥；
 * - 都未提供时返回 kind=default（条件等待的默认上限）；
 * - 窗口长度超过 maxMs 直接报错。
 */
export function resolveWindow(
  time: WaitTimeInput | undefined,
  nowMs: number,
  defaultMs: number,
  maxMs: number,
): Result<ResolvedWindow> {
  const duration = typeof time?.duration === 'string' ? time.duration.trim() : '';
  const until = typeof time?.until === 'string' ? time.until.trim() : '';
  if (duration && until) return fail('duration 与 until 不能同时提供');

  if (duration) {
    const parsed = parseDuration(duration);
    if (!parsed.ok) return parsed;
    if (parsed.value > maxMs) {
      return fail(`单次等待不能超过 ${Math.round(maxMs / 60_000)} 分钟；请拆分多次等待`);
    }
    return { ok: true, value: { kind: 'duration', endAt: nowMs + parsed.value } };
  }

  if (until) {
    const parsed = parseUntil(until, nowMs);
    if (!parsed.ok) return parsed;
    const delta = parsed.value - nowMs;
    if (delta > maxMs) {
      return fail(`单次等待不能超过 ${Math.round(maxMs / 60_000)} 分钟；请拆分多次等待`);
    }
    return { ok: true, value: { kind: 'until', endAt: parsed.value } };
  }

  return { ok: true, value: { kind: 'default', endAt: nowMs + defaultMs } };
}

/** 条件组合判定：all=全部满足，any=任一满足；空条件视为已满足 */
export function judgeConditions(satisfied: boolean[], match: WaitMatch): boolean {
  if (satisfied.length === 0) return true;
  return match === 'all' ? satisfied.every(Boolean) : satisfied.some(Boolean);
}

/** 归一化并校验条件数组（结构层；目标存在性由执行入口校验） */
export function normalizeConditions(
  raw: unknown,
  defaults: { sessionId: string; maxConditions: number },
): Result<NormalizedCondition[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail('conditions 必须是数组');
  if (raw.length === 0) return { ok: true, value: [] };
  if (raw.length > defaults.maxConditions) return fail(`conditions 最多 ${defaults.maxConditions} 个`);

  const out: NormalizedCondition[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return fail(`conditions[${i}] 必须是对象`);
    }
    const c = item as Record<string, unknown>;
    const kind = typeof c.kind === 'string' ? c.kind.trim() : '';

    if (kind === 'session') {
      const sessionId = typeof c.sessionId === 'string' ? c.sessionId.trim() : '';
      if (!sessionId) return fail(`conditions[${i}]（session）缺少 sessionId`);
      out.push({ kind: 'session', sessionId });
      continue;
    }

    if (kind === 'terminal') {
      const sessionId =
        typeof c.sessionId === 'string' && c.sessionId.trim() ? c.sessionId.trim() : defaults.sessionId;
      const terminalId =
        typeof c.terminalId === 'string' && c.terminalId.trim() ? c.terminalId.trim() : undefined;
      out.push({ kind: 'terminal', sessionId, ...(terminalId ? { terminalId } : {}) });
      continue;
    }

    if (kind === 'tool') {
      const toolCallId = typeof c.toolCallId === 'string' ? c.toolCallId.trim() : '';
      if (!toolCallId) return fail(`conditions[${i}]（tool）缺少 toolCallId`);
      const sessionId =
        typeof c.sessionId === 'string' && c.sessionId.trim() ? c.sessionId.trim() : defaults.sessionId;
      out.push({ kind: 'tool', sessionId, toolCallId });
      continue;
    }

    return fail(`conditions[${i}] 的 kind 必须是 session / terminal / tool`);
  }

  return { ok: true, value: out };
}
