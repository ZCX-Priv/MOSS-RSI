// src/core/process-guards.ts
// 进程级异常兜底（常驻服务保活）。
//
// 背景：Bun 对未捕获异常 / 未处理拒绝默认终止进程。长程任务（小时级、数千轮工具调用）
// 期间任意一处逃逸异常（定时器回调 / 事件监听 / fire-and-forget Promise）都会让守护进程
// 直接死掉 —— 用户侧表现为「长任务跑一半自己停了 + 后端没了 + 前端永久停在响应中」。
// 这里改为「记录完整堆栈 + 计数 + 不退出」：单点异常不应让整机长任务全部丢失。

import type { Logger } from './types';

let installed = false;
let crashCount = 0;

/**
 * 注册进程级异常兜底。必须在模块初始化/预热之前调用：
 * 启动阶段的未处理拒绝同样会杀死 Bun 进程，从而导致前端 ECONNREFUSED。
 */
export function installProcessGuards(logger: Logger): void {
  if (installed) return;
  installed = true;
  const report = (kind: string, err: unknown): void => {
    crashCount++;
    const detail =
      err instanceof Error
        ? { message: err.message, stack: err.stack }
        : { message: String(err) };
    logger.error(`process:${kind} (kept alive, total=${crashCount})`, detail);
    if (crashCount === 20 || crashCount === 100) {
      logger.error(
        `process:${kind} 频繁发生（累计 ${crashCount} 次）：守护进程仍在运行但稳定性已受影响，建议导出 ~/.moss/logs 排查`,
      );
    }
  };
  process.on('uncaughtException', (err) => report('uncaughtException', err));
  process.on('unhandledRejection', (reason) => report('unhandledRejection', reason));
}
