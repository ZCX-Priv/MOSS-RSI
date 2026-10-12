// webui/src/lib/diag.ts
// DEV 诊断打点：虚拟列表改造后 6 个回归症状都极隐蔽（竞态窗口 / id 冲突 / 分片丢弃），
// 静态分析难以穷尽所有触发路径。本模块提供统一出口，仅在开发模式输出，
// 用于回归验证时定位残余触发源（生产构建零开销、零输出）。

type DiagDetail = Record<string, unknown>;

/** 是否输出诊断（仅 dev；生产构建中被常量折叠剔除） */
const ENABLED = import.meta.env.DEV;

export function diag(name: string, detail?: DiagDetail): void {
  if (!ENABLED) return;
  // eslint-disable-next-line no-console -- 诊断通道
  console.debug(`[moss-diag] ${name}`, detail ?? {});
}

/**
 * 异常路径专用打点：生产构建也输出（console.warn）。
 * 仅在状态机异常时触发（分片丢弃 / 终态 runId 不一致 / 看门狗自愈），低频且不污染正常日志；
 * 目的是让用户在构建产物上也能现场取证（`diag` 在 production 被常量折叠剔除，导致此前无任何线索）。
 */
export function diagAlways(name: string, detail?: DiagDetail): void {
  // eslint-disable-next-line no-console -- 诊断通道
  console.warn(`[moss-diag] ${name}`, detail ?? {});
}

/** 计数器型打点：同名事件聚合计数（高频路径避免刷屏，单次输出计数） */
const counters = new Map<string, number>();
export function diagCount(name: string, detail?: DiagDetail): void {
  if (!ENABLED) return;
  counters.set(name, (counters.get(name) ?? 0) + 1);
  const n = counters.get(name) ?? 0;
  if (n === 1 || n % 50 === 0) {
    // eslint-disable-next-line no-console -- 诊断通道
    console.debug(`[moss-diag] ${name} ×${n}`, detail ?? {});
  }
}
