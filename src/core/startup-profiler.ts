// src/core/startup-profiler.ts
// 启动性能仪表：记录进程启动到关键阶段的耗时、每个模块的同步阻塞段与事件循环延迟。
//
// 用法：
// - 入口注入 MOSS_BOOT_AT=<epoch ms>（bin/moss.js spawn 时写入），缺失则回退 performance.timeOrigin；
// - kernel 在阶段边界调用 mark()，模块波次调用 recordModule()；
// - kernel.ready 时输出一条 "startup budget" 日志，/api/health 也返回精简摘要。
//
// 设计约束：mark/recordModule 只做数组 push 与 performance.now()，不得引入任何 IO。

export interface StartupModuleTiming {
  name: string;
  /** 相对启动时刻的开始毫秒 */
  startMs: number;
  /** 相对启动时刻的结束毫秒（initialize 的 Promise 结算） */
  endMs: number;
  /** 同步阻塞段毫秒（调用 initialize 到其返回 Promise 之间） */
  syncMs: number;
}

export interface StartupSummary {
  /** 允许直接作为 Logger context 传给日志器 */
  [key: string]: unknown;
  /** 进程启动的 epoch 毫秒（MOSS_BOOT_AT 或 performance.timeOrigin） */
  bootAt: number;
  /** 从进程启动到当前时刻的毫秒 */
  fromSpawnMs: number;
  /** 从 profiler 初始化到当前时刻的毫秒 */
  elapsedMs: number;
  /** 命名阶段：相对 profiler 初始化的毫秒 */
  marks: Record<string, number>;
  modules: StartupModuleTiming[];
  /** 启动期间采样的最大事件循环延迟（毫秒） */
  maxEventLoopLagMs: number;
}

/** 事件循环延迟采样间隔：足够捕捉同步阻塞，又不会明显增加启动开销 */
const LAG_SAMPLE_INTERVAL_MS = 25;

class StartupProfiler {
  private readonly bootAt: number;
  private readonly startedAt: number;
  private readonly marks = new Map<string, number>();
  private readonly modules: StartupModuleTiming[] = [];
  private lagTimer: ReturnType<typeof setInterval> | null = null;
  private lagExpectedAt = 0;
  private maxLagMs = 0;

  constructor() {
    const raw = Number(process.env.MOSS_BOOT_AT);
    // 合法 epoch 毫秒才采信：避免测试/脚本传入非数字导致 fromSpawnMs 为 NaN
    this.bootAt = Number.isFinite(raw) && raw > 0 ? raw : Math.round(performance.timeOrigin);
    this.startedAt = performance.now();
  }

  /** 记录命名阶段（相对 profiler 初始化） */
  mark(name: string): void {
    this.marks.set(name, performance.now() - this.startedAt);
  }

  /** 开始事件循环延迟采样（kernel.start 最早调用） */
  startLagSampling(): void {
    if (this.lagTimer !== null) return;
    this.lagExpectedAt = performance.now() + LAG_SAMPLE_INTERVAL_MS;
    this.lagTimer = setInterval(() => {
      const now = performance.now();
      const lag = now - this.lagExpectedAt;
      if (lag > this.maxLagMs) this.maxLagMs = lag;
      this.lagExpectedAt = now + LAG_SAMPLE_INTERVAL_MS;
    }, LAG_SAMPLE_INTERVAL_MS);
  }

  /** 停止采样（kernel.ready / deferred 完成后调用） */
  stopLagSampling(): void {
    if (this.lagTimer === null) return;
    clearInterval(this.lagTimer);
    this.lagTimer = null;
  }

  /**
   * 记录一个模块的初始化耗时。
   * syncEndAt 必须是「initialize() 已执行完同步段、返回 Promise」的时刻，
   * 它与 startAt 的差即真正阻塞事件循环的时间。
   */
  recordModule(name: string, startAt: number, syncEndAt: number, endAt: number): void {
    this.modules.push({
      name,
      startMs: round1(startAt - this.startedAt),
      endMs: round1(endAt - this.startedAt),
      syncMs: round1(Math.max(0, syncEndAt - startAt)),
    });
  }

  summary(): StartupSummary {
    const marks: Record<string, number> = {};
    for (const [k, v] of this.marks) marks[k] = round1(v);
    return {
      bootAt: this.bootAt,
      fromSpawnMs: Math.max(0, Date.now() - this.bootAt),
      elapsedMs: round1(performance.now() - this.startedAt),
      marks,
      modules: this.modules.map((m) => ({ ...m })),
      maxEventLoopLagMs: round1(this.maxLagMs),
    };
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 进程级单例（kernel 与 health 路由共用） */
export const startupProfiler = new StartupProfiler();

/** 供 /api/health 使用：只返回从进程启动到现在的耗时与关键阶段，避免输出过大 */
export function getStartupSummary(): StartupSummary {
  return startupProfiler.summary();
}
