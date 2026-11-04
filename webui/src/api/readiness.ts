// webui/src/api/readiness.ts
// 后端就绪门控。
//
// 背景：内核模块按 MODULE_FACTORIES 顺序初始化，`server` 排第 2、`agent` 排第 14。
// 服务器开始监听后、agent.engine 尚未注册的窗口内，列表/历史类路由会返回 503
// （引擎未就绪），若不加门控，首批请求就会落在这个窗口里 → 首屏侧边栏/消息列表为空，
// 需手动刷新（此时后端已就绪）才恢复。
//
// 做法：在首批数据请求前等待「服务端 + 工具注册表 + 上下文引擎」就绪。
// 不再等待 agent.engine：该模块依赖工具/文件系统/上下文等，等待它会阻塞整页渲染；
// 任务列表/会话历史 hooks 已对 agent 引擎未就绪时的 503 做退避重试。
// 探测 /api/health 的 services 列表（auth:false，启动窗口内即可访问）。

import { api } from './http';

/** 就绪标志：这些服务同时出现即代表首屏数据所需基础设施可用（agent 数据由请求重试兜底） */
const READY_SERVICES = ['server.instance'];
const POLL_INTERVAL_MS = 250;
/** 等待上限：超过则放行（由调用方自身的重试兜底），避免后端始终不可用时空转 */
const MAX_WAIT_MS = 4_000;

let knownReady = false;
let pending: Promise<boolean> | null = null;

/** 是否已确认后端就绪（就绪后为 true，不再发出探测请求） */
export function isBackendReady(): boolean {
  return knownReady;
}

/**
 * 等待后端就绪。单例：并发调用共享同一次轮询。
 * 已就绪 → 立即 resolve(true)；等待超时 → resolve(false)，且**不缓存失败**，允许下次再试。
 */
export function waitForBackendReady(): Promise<boolean> {
  if (knownReady) return Promise.resolve(true);
  if (!pending) {
    pending = pollUntilReady().then((ok) => {
      if (ok) knownReady = true;
      pending = null;
      return ok;
    });
  }
  return pending;
}

/** 轮询 /api/health 直至 agent 引擎注册或超时 */
async function pollUntilReady(): Promise<boolean> {
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    try {
      const health = await api.health();
      const services = new Set(health.services ?? []);
      if (READY_SERVICES.every((name) => services.has(name))) return true;
    } catch {
      // 后端未监听 / 代理失败：视为未就绪，继续轮询
    }
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}