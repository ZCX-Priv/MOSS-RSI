// src/utils/semaphore.ts
// 轻量并发闸门：限制同时运行的 run/工具数量，避免低内存机器被并发任务拖垮（OOM/长任务互相饿死）。
// 纯内存实现，无第三方依赖；release 必须且只需调用一次（由调用方用 finally 保证）。

export class Semaphore {
  /** 当前已占用名额 */
  private active = 0;
  /** 等待队列（FIFO；resolve 后由被唤醒者重新占用名额） */
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error(`Semaphore limit must be >= 1 (got ${limit})`);
    }
  }

  /** 获取名额；返回释放函数（幂等保护由调用方 finally 保证一次调用） */
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    return () => this.release();
  }

  /** 当前占用数（诊断用） */
  getActive(): number {
    return this.active;
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}
