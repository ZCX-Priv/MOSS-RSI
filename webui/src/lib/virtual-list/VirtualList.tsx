// webui/src/lib/virtual-list/VirtualList.tsx
// 自建虚拟列表（替换 react-virtuoso）：只挂载视口附近的消息。
//
// 设计（与业务用法一一对应，无多余能力）：
// - 高度模型：Map<key, 实测高度>（ResizeObserver）+ 未测条目用「已测平均值」估算；
//   前缀和数组描述滚动内容，spacer 撑起未渲染区间。
// - prepend 锚定：anchorPrepend() 在数据合入前捕获 scrollHeight，返回 apply()；
//   提交后按「新增内容高度 = scrollHeight 增量」修正 scrollTop，视口纹丝不动。
// - 贴底跟随（sticky 状态机，取代「atBottom 阈值 + 无条件拉回」）：
//   sticky=true 时每次布局后贴底（测量估算→实测的收敛期间持续重贴，视觉不跳）；
//   退出通道三重覆盖输入方式与竞态窗口——wheel 向上（滚轮一档未超阈值也立即退出）、
//   touchmove（触摸位移；纯点击不误伤）、scroll 时远离底部（滚动条拖动/键盘/任何来源）；
//   恢复通道仅一条：滚动后距底 <= STICKY_RESUME_PX（真贴底才恢复跟随）。
//   atBottomRef 保留用于对外 onAtBottomChange（按钮显隐，宽阈值）。
// - startReached：滚动到顶部（scrollTop <= 120）时回调；prepend 后抑制一次，
//   防止顶部停留时级联加载整段历史。
// - initialBottom：首次出现非空数据后置 sticky + 立即贴底一次；后续收敛由 sticky 接管。
// - sessionKey：切换会话（组件不重挂）时重置 sticky/高度缓存/底部标记，并结束程序滚动窗口期。
// - scrollToBottom（「返回底部」）：内部状态翻转**必须显式回调 onAtBottomChange**——
//   只改 atBottomRef 而不通知，宿主 atBottom 会恒为 false → 按钮永不消失；
//   平滑滚动开「程序滚动窗口期」（scrollend 优先 / 700ms 兜底 / 用户手势立即结束），
//   窗口期内屏蔽 scroll 驱动的 atBottom/sticky 改写，防按钮中途闪现；距离 > 3000px 降级为瞬时。
// - Header/Footer：常驻 DOM（体量小不虚拟化），分别位于内容最顶/最底。
//
// 性能：布局计算 rAF 合并且带版本号去重；滚动处理 rAF 节流；
// items 变化走 useLayoutEffect 同步重排（首帧即正确，不闪空白）。

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { buildPrefixSum, computeRange, findItemAt } from './prefix';

/** 未测量条目的默认估算高度（px） */
const DEFAULT_ITEM_HEIGHT = 96;
/** 估算高度的采样上限（超过后仍用中位数，避免全量排序开销） */
const ESTIMATE_SAMPLE_LIMIT = 64;
/** 估算高度的夹取区间（px）：防止单条超长消息（展开思考/大工具卡）把估算值拉爆，
 *  导致可视区间只剩 1 条、其余视口变成巨大 spacer（上滑黑屏的直接来源） */
const ESTIMATE_MIN_HEIGHT = 40;
const ESTIMATE_MAX_HEIGHT = 4000;
/** 单次渲染的条目上限（安全阀）：极快滚动 + 估算偏低时避免一帧挂载上百条 */
const MAX_RENDER_ITEMS = 48;
/**
 * 动态 overscan 上限（px）：速度预测 / 单帧跳变只用于填满视口前方，不无限扩大挂载范围。
 * 6000px 覆盖「拖动滚动条一步到位」的极端跳变（真实拖拽连续像素远小于此值），
 * 实际挂载量仍由 MAX_RENDER_ITEMS=48 兜底。
 */
const MAX_DYNAMIC_OVERSCAN_PX = 6000;
/** 速度 → overscan 系数（px per px/ms）。滚动事件到提交约 2~3 帧，系数留 3~4 倍余量 */
const VELOCITY_OVERSCAN_FACTOR = 250;
/** onScrollMetrics 节流间隔（ms）：滚动中最多 10 次/秒通知宿主 */
const SCROLL_METRICS_THROTTLE_MS = 100;
/** scrollTop 低于该值视为「接近顶部」（触发加载更早一页；可由 startReachedThreshold 覆盖） */
const DEFAULT_START_REACH_THRESHOLD = 600;
/** anchorPrepend.apply 等待数据提交的重试帧数上限 */
const PREPEND_APPLY_RETRIES = 10;
/** 滚动后距底小于该值才恢复贴底跟随（比对外 atBottom 宽阈值严——真贴底才恢复） */
const STICKY_RESUME_PX = 32;
/** 「返回底部」超远距离阈值（px）：超过则平滑降级为瞬时定位（超长平滑耗时过久） */
const INSTANT_SCROLL_DISTANCE_PX = 3000;
/** 程序滚动窗口期兜底时长（ms）：scrollend 不可用时据此关闭窗口 */
const PROGRAMMATIC_FALLBACK_MS = 700;

/**
 * 未测条目高度估算：取已测高度的中位数并夹取到安全区间。
 * 用中位数而非平均值——单条超长消息（展开思考/大工具卡）不应把其余未测条目
 * 全部估算成几万 px，否则可视区间会塌缩成 1 条、其余视口变成巨大 spacer（黑屏）。
 */
function estimateItemHeight(heights: ReadonlyMap<string, number>): number {
  const samples: number[] = [];
  for (const h of heights.values()) {
    if (samples.length >= ESTIMATE_SAMPLE_LIMIT) break;
    if (!Number.isFinite(h) || h <= 0) continue;
    samples.push(h);
  }
  if (samples.length < 4) return DEFAULT_ITEM_HEIGHT;
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  return Math.min(ESTIMATE_MAX_HEIGHT, Math.max(ESTIMATE_MIN_HEIGHT, median));
}

/**
 * 精确视口区间 [start, end)（不含 overscan）：
 * 宿主用它判断「哪些条目落在首屏可见区」——可见项首帧直接渲染终态（不再走占位→水合），
 * overscan 区的条目升级发生在视口外，因此不可见。
 */
function computeVisibleRange(
  prefix: readonly number[],
  scrollTop: number,
  viewport: number,
): { start: number; end: number } {
  const n = prefix.length - 1;
  if (n <= 0) return { start: 0, end: 0 };
  const start = findItemAt(prefix, scrollTop);
  const end = Math.min(n, findItemAt(prefix, scrollTop + viewport) + 1);
  return { start, end };
}

/**
 * 渲染区间兜底与安全阀：
 * - 必须覆盖精确可见区间（避免估算偏差导致视口内没有已挂载条目）；
 * - 已挂载高度不足以覆盖「视口 + overscan」时向后扩展（防黑屏）；
 * - 单次最多 MAX_RENDER_ITEMS 条（快速滚动时不至于一帧挂载上百条）；
 * - 上限裁剪时优先保留可见区间，并尽量对称保留上下缓冲。
 */
function clampRenderRange(
  r: { start: number; end: number },
  prefix: readonly number[],
  scrollTop: number,
  viewport: number,
): { start: number; end: number } {
  const n = prefix.length - 1;
  if (n <= 0) return { start: 0, end: 0 };
  const visibleStart = findItemAt(prefix, scrollTop);
  const visibleEnd = Math.min(n, findItemAt(prefix, scrollTop + viewport) + 1);
  let start = Math.min(r.start, visibleStart);
  let end = Math.max(r.end, visibleEnd);
  // 填充兜底：已挂载条目的估算高度不足以覆盖视口时向后扩展（最多到安全阀）
  while (
    end < n &&
    prefix[end] - prefix[start] < viewport &&
    end - start < MAX_RENDER_ITEMS
  ) {
    end++;
  }
  // 安全阀：可见区本身不超过上限时，围绕可见区保留上下缓冲后裁剪
  if (end - start > MAX_RENDER_ITEMS && visibleEnd - visibleStart < MAX_RENDER_ITEMS) {
    const visibleCount = visibleEnd - visibleStart;
    const budget = MAX_RENDER_ITEMS - visibleCount;
    const before = Math.min(visibleStart - start, Math.ceil(budget / 2));
    start = Math.max(start, visibleStart - before);
    end = Math.min(end, start + MAX_RENDER_ITEMS);
    if (end < visibleEnd) {
      end = visibleEnd;
      start = Math.max(0, end - MAX_RENDER_ITEMS);
    }
  }
  return { start, end };
}

export interface PrependAnchor {
  /** 在 prepend 数据提交后调用：按 scrollHeight 增量修正 scrollTop（自动等待提交） */
  apply: () => void;
}

export interface VirtualListApi {
  /** 数据合入前调用捕获锚点，合入后调用返回值的 apply() */
  anchorPrepend: () => PrependAnchor;
  /** 滚动到底部 */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /**
   * 条目顶部相对「滚动内容顶部」的偏移（未实测条目用估算值）。
   * 供宿主导航（对话节点：当前节点判定）；key 不存在返回 null。
   */
  getItemOffset: (key: string) => number | null;
  /**
   * 滚动到指定条目顶部（对话节点跳转）。
   * 主动跳转会退出贴底跟随（流式增长不把视口拽回底部）；平滑滚动超远距离降级为瞬时。
   */
  scrollToKey: (key: string, behavior?: ScrollBehavior) => void;
}

export interface VirtualListProps<T> {
  items: readonly T[];
  itemKey: (item: T) => string;
  /**
   * 渲染单条。第三个参数 inViewport = 该条目是否落在当前精确视口内（不含 overscan）：
   * 宿主据此决定是否走「纯文本占位 → 水合」，或首帧直接渲染终态。
   * 传「当前视口」而非「上一帧也可见」：新滚入视口的条目若先占位再升级，
   * 长块高度变化会造成上滑时闪屏与位置抖动。
   */
  renderItem: (item: T, index: number, inViewport: boolean) => ReactNode;
  /** 附加到滚动容器的 className（默认已含 h-full overflow-y-auto） */
  className?: string;
  /** 内容最顶部的常驻节点（如「上滑加载更早」提示） */
  header?: ReactNode;
  /** 内容最底部的常驻节点（如「响应中」占位） */
  footer?: ReactNode;
  /** 上下各多少 px 的预渲染缓冲 */
  overscan?: number;
  /** 距底部多少 px 内视为「在底部」（对外 atBottom 回调判定，宽阈值） */
  atBottomThreshold?: number;
  /** scrollTop 低于该值即触发 onStartReached（默认 600；接近顶部就静默预取） */
  startReachedThreshold?: number;
  /**
   * 内容不足 1.5 屏时自动补页（最多连续 2 次/会话），用于打开会话即填满视口。
   * 是否真的还有更早历史由宿主 onStartReached 内部 guard 决定。
   */
  autoFill?: boolean;
  /** 首次出现非空数据后定位到底部（一次） */
  initialBottom?: boolean;
  /** 贴底期间自动跟随内容追加/增高（sticky 状态机，用户主动上滑即脱离） */
  followOutput?: boolean;
  /** 会话标识：变化时重置贴底跟随/高度缓存（组件不重挂的会话切换场景） */
  sessionKey?: string;
  /** 滚动到顶部时回调（内部已做 scrollTop <= 120 判定与 prepend 抑制） */
  onStartReached?: () => void;
  /** 「在底部」状态变化时回调 */
  onAtBottomChange?: (atBottom: boolean) => void;
  /** 暴露滚动容器句柄（宿主可读 scrollTop 等） */
  registerScroller?: (el: HTMLDivElement | null) => void;
  /** 宿主持有的 api ref（挂载后写入，卸载清空） */
  apiRef?: RefObject<VirtualListApi | null>;
  /** 滚动速度回调（px/ms）：宿主持此做速度感知的预取 */
  onScrollMetrics?: (metrics: { velocity: number; direction: 1 | -1; scrollTop: number }) => void;
  /** 滚动状态回调：true=正在滚动，false=停止 120ms；宿主可据此暂停重内容水合 */
  onScrollingChange?: (scrolling: boolean) => void;
}

export function VirtualList<T>({
  items,
  itemKey,
  renderItem,
  className,
  header,
  footer,
  overscan = 400,
  atBottomThreshold = 100,
  startReachedThreshold = DEFAULT_START_REACH_THRESHOLD,
  autoFill = false,
  initialBottom = false,
  followOutput = false,
  sessionKey,
  onStartReached,
  onAtBottomChange,
  registerScroller,
  apiRef,
  onScrollMetrics,
  onScrollingChange,
}: VirtualListProps<T>) {
  // ===== 状态与引用 =====
  const [range, setRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  /** 精确视口区间（不含 overscan）：宿主据此判定「首屏可见项」→ 可见项首帧渲染终态 */
  const [visibleRange, setVisibleRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  /** 布局版本号：前缀和变化时递增以触发重渲染（应用新 spacer 高度）；
   *  同时作为「实测+重排+贴底」effect 的触发依赖（布局窗口变化后才需要重新校准） */
  const [layoutSeq, setLayoutSeq] = useState(0);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const heightsRef = useRef<Map<string, number>>(new Map());
  const prefixRef = useRef<number[]>([0]);
  /** 高度/条目版本号：布局无变化时完全跳过（去重空闲工作） */
  const dirtyRef = useRef(true);
  /** 在底部状态（仅用于对外 onAtBottomChange——按钮显隐等宽判定；跟随由 stickyRef 决定） */
  const atBottomRef = useRef(true);
  /** 贴底跟随状态机：true = 内容增长/布局变化后自动贴底；用户主动上滑即置 false */
  const stickyRef = useRef(true);
  /** 上一帧 scrollTop：仅「scrollTop 相对上一帧变小」（用户主动上滑/拖条/键盘上翻）才脱离跟随 */
  const lastScrollTopRef = useRef(0);
  /**
   * 我方程序化设置的预期 scrollTop（贴底 / scrollToBottom('auto')）。
   * 这类滚动会触发 scroll 事件；用它与实际 scrollTop 对齐来识别「自身滚动」，
   * 避免内容在滚动后继续增长时把跟随态误判为脱离（「返回底部」按钮误显的根因）。
   */
  const selfScrollTopRef = useRef<number | null>(null);
  /** prepend 后抑制 startReached，直到用户实际滚离顶部 */
  const suppressStartRef = useRef(false);
  /** initialBottom 是否已执行（会话内一次） */
  const bottomDoneRef = useRef(false);
  /** 程序滚动窗口期：平滑滚到底期间屏蔽 scroll 驱动的 atBottom/sticky 改写（防按钮闪现/误脱跟） */
  const programmaticRef = useRef(false);
  /** 程序滚动窗口期兜底定时器（scrollend 不可用时的关闭通道） */
  const programmaticTimerRef = useRef<number | null>(null);

  // 最新 props/回调 的稳定引用（滚动/观察回调内使用，避免重建 observer）
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const itemKeyRef = useRef(itemKey);
  itemKeyRef.current = itemKey;
  const followRef = useRef(followOutput);
  followRef.current = followOutput;
  const overscanRef = useRef(overscan);
  overscanRef.current = overscan;
  const thresholdRef = useRef(atBottomThreshold);
  thresholdRef.current = atBottomThreshold;
  const startCbRef = useRef(onStartReached);
  startCbRef.current = onStartReached;
  const bottomCbRef = useRef(onAtBottomChange);
  bottomCbRef.current = onAtBottomChange;
  const startThresholdRef = useRef(startReachedThreshold);
  startThresholdRef.current = startReachedThreshold;
  const autoFillRef = useRef(autoFill);
  autoFillRef.current = autoFill;
  /** 已同步实测过的 key：避免每轮布局全量读 offsetHeight 强制回流 */
  const measuredKeysRef = useRef<Set<string>>(new Set());
  /** 连续自动补页计数：内容仍不足 1.5 屏时最多连续补 2 次 */
  const autoFillDepthRef = useRef(0);
  /** range/visibleRange 的镜像：layout 内同步比较，避免无意义的重渲染 */
  const rangeStateRef = useRef({ start: 0, end: 0 });
  const visibleStateRef = useRef({ start: 0, end: 0 });
  // registerScroller 同样入 ref：宿主常传内联箭头，若作为 useCallback 依赖会让
  // scroller ref 回调每次渲染重建（React 会先 cleanup 再重挂 → observe/unobserve 抖动）
  const registerScrollerRef = useRef(registerScroller);
  registerScrollerRef.current = registerScroller;

  const rafLayoutRef = useRef<number | null>(null);
  const rafScrollRef = useRef<number | null>(null);
  /** 滚动速度（px/ms）：用于方向感知的动态 overscan（快速滚动时多挂载内容，避免空窗） */
  const velocityRef = useRef(0);
  /** 上一次滚动事件处理时刻（速度计算用） */
  const lastScrollAtRef = useRef(0);
  /** 上一次布局使用的 items 快照：prefix 实测修正时按「视口顶部消息 key」锚定 scrollTop */
  const layoutItemsRef = useRef(items);
  /** prepend 锚定合并：同一帧多次 anchorPrepend 复用同一个 apply（只修正一次 scrollTop） */
  const pendingAnchorRef = useRef<{ apply: () => void } | null>(null);
  /** onScrollMetrics 上次回调时刻（节流：滚动中最多 10 次/秒通知宿主） */
  const lastMetricsAtRef = useRef(0);
  /** 上一帧滚动位移（px）：用于把「单帧跳变」计入 overscan，避免拖动滚动条一步到位时空窗 */
  const lastScrollDeltaRef = useRef(0);
  /**
   * startReached 武装时刻：首屏挂载 / 切换会话后 400ms 内不触发加载更早历史。
   * 初始化阶段的「贴底 + 估算→实测收敛」会让 scrollTop 被浏览器被动钳制（表现为负 delta），
   * 若不加窗口会被误判为用户上滑，与预取并发拉取同一区间（实测重复请求 0.6+0.8MB）。
   */
  const startArmedAtRef = useRef(Date.now() + 400);
  /** 滚动停止去抖定时器（通知宿主恢复水合） */
  const scrollIdleTimerRef = useRef<number | null>(null);
  const metricsCbRef = useRef(onScrollMetrics);
  metricsCbRef.current = onScrollMetrics;
  const scrollingCbRef = useRef(onScrollingChange);
  scrollingCbRef.current = onScrollingChange;

  /**
   * 以几何为准校准「在底部」与贴底意图，并在变化时回调宿主。
   * 为什么需要：atBottom 原先只在 scroll 事件里派生，而程序化贴底（selfScrollTopRef 记录的
   * 自身滚动）会被 handleScroll 判为 self-initiated 并跳过改写 —— 残留的 false 在回复完成后
   * （操作栏出现 / 「响应中」页脚收起等高度变化）没有任何时机被纠正，表现为「明明已在底部，
   * 返回底部按钮仍显示」。任何布局落定时机调用本函数即可让几何重新成为权威。
   */
  const syncAtBottom = useCallback(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const dist = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    // 这里只按几何派生对外 atBottom，**不再据此恢复贴底跟随**：
    // 布局落定/内容缩短时浏览器会把 scrollTop 钳制回来，dist 会短暂变小；
    // 若在此恢复跟随，用户上滑后被下一次内容增长拉回底部（「第一遍上滑失效」的根因）。
    // 恢复跟随只允许两条通道：用户向下滚回底部（handleScroll）与显式 scrollToBottom。
    const ab = stickyRef.current ? true : dist <= thresholdRef.current;
    if (ab !== atBottomRef.current) {
      atBottomRef.current = ab;
      bottomCbRef.current?.(ab);
    }
  }, []);

  // ===== 核心：布局计算（前缀和 + 可视区间 + 跟随） =====
  const runLayout = useCallback(() => {
    if (rafLayoutRef.current !== null) {
      cancelAnimationFrame(rafLayoutRef.current);
      rafLayoutRef.current = null;
    }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;

    const cur = itemsRef.current;
    const heights = heightsRef.current;
    // 估算基准：已测高度的中位数（夹取安全区间；样本不足 4 条时用默认值）
    const estimate = estimateItemHeight(heights);
    const keyFn = itemKeyRef.current;
    const hs = new Array<number>(cur.length);
    for (let i = 0; i < cur.length; i++) {
      hs[i] = heights.get(keyFn(cur[i])) ?? estimate;
    }
    const prevPrefix = prefixRef.current;
    const nextPrefix = buildPrefixSum(hs);
    let prefixChanged = prevPrefix.length !== nextPrefix.length;
    if (!prefixChanged) {
      for (let i = 0; i < nextPrefix.length; i++) {
        if (prevPrefix[i] !== nextPrefix[i]) {
          prefixChanged = true;
          break;
        }
      }
    }

    // 估算 → 实测收敛时的位置锚定：prefix 大幅变化（实测修正 / prepend）后，
    // 用「变化前视口顶部所在消息 key + 该条内偏移」恢复 scrollTop，
    // 避免新 prefix 与旧 scrollTop 对不上导致视口落入 spacer（黑屏的另一来源）。
    // 贴底跟随期间不做（由 sticky 贴底逻辑接管）；程序滚动期间也不做（避免打断平滑滚动）。
    const sc = scrollerRef.current;
    const prevItems = layoutItemsRef.current;
    if (
      prefixChanged &&
      !stickyRef.current &&
      !programmaticRef.current &&
      sc &&
      prevItems.length > 0 &&
      prevPrefix.length > 1
    ) {
      const prevTopIdx = findItemAt(prevPrefix, sc.scrollTop);
      if (prevTopIdx >= 0 && prevTopIdx < prevItems.length) {
        const anchorKey = keyFn(prevItems[prevTopIdx]);
        const offsetInItem = sc.scrollTop - prevPrefix[prevTopIdx];
        let newIdx = -1;
        for (let i = 0; i < cur.length; i++) {
          if (keyFn(cur[i]) === anchorKey) {
            newIdx = i;
            break;
          }
        }
        if (newIdx >= 0) {
          const itemBottom = nextPrefix[Math.min(newIdx + 1, cur.length)];
          const newTop = Math.min(
            nextPrefix[newIdx] + offsetInItem,
            Math.max(nextPrefix[newIdx], itemBottom - 1),
          );
          if (Math.abs(newTop - sc.scrollTop) > 4) {
            // 记录自身程序滚动的预期值，避免 handleScroll 把这次修正误判为「用户上滑」而脱离跟随
            selfScrollTopRef.current = newTop;
            lastScrollTopRef.current = newTop;
            sc.scrollTop = newTop;
          }
        }
      }
    }

    prefixRef.current = nextPrefix;
    layoutItemsRef.current = cur;

    if (sc) {
      // 容器高度尚未就绪（布局塌陷 / 首帧）：不更新区间，等 ResizeObserver 报告后重排，
      // 避免用 clientHeight=0 算出「空区间」导致整屏无内容。
      if (sc.clientHeight <= 0) {
        dirtyRef.current = true;
        return;
      }
      // 贴底意图下 `sc.scrollTop` 不可信：DOM 尚未反映本次 prefix（首帧 prefix 仍是 [0]、
      // 无任何 cell，scrollHeight 只等于 header+footer，scrollTop 近似 0）。若照它算区间，
      // 会渲染「顶部条目 + 巨大底部 spacer」而视口又在底部 → 可见区只剩空 spacer（错位），
      // 下一帧 scroll 事件才重算归位（用户看到的「先错位、再排好」）。
      // 贴底的真实落点就是内容底部，可直接由前缀和给出（total - viewport），不依赖 DOM 高度。
      // 程序滚动窗口期（平滑「返回底部」）例外：期间由 handleScroll 驱动区间，沿动画路径挂载。
      const total = prefixRef.current[prefixRef.current.length - 1] ?? 0;
      const bottomIntent = followRef.current && stickyRef.current && !programmaticRef.current;
      const effectiveTop = bottomIntent ? Math.max(0, total - sc.clientHeight) : sc.scrollTop;
      // 速度预测 + 单帧跳变：跳变幅度直接计入 overscan（覆盖拖动滚动条一步到位），
      // 由 MAX_DYNAMIC_OVERSCAN_PX 与 MAX_RENDER_ITEMS 双重兜底，不会无限挂载。
      const jumpPx = Math.max(
        velocityRef.current * VELOCITY_OVERSCAN_FACTOR,
        Math.abs(lastScrollDeltaRef.current),
      );
      const dynamicOverscan = Math.max(
        overscanRef.current,
        Math.min(MAX_DYNAMIC_OVERSCAN_PX, overscanRef.current + jumpPx),
      );
      // computeRange 给出带缓冲的区间，再由 clampRenderRange 做「覆盖可见区 + 填充兜底 + 条数安全阀」
      const r = clampRenderRange(
        computeRange(prefixRef.current, effectiveTop, sc.clientHeight, dynamicOverscan),
        prefixRef.current,
        effectiveTop,
        sc.clientHeight,
      );
      const prevRange = rangeStateRef.current;
      const rangeChanged = prevRange.start !== r.start || prevRange.end !== r.end;
      if (rangeChanged) {
        rangeStateRef.current = r;
        setRange(r);
      }
      // range 与 visibleRange 必须同源（同一个 effectiveTop），否则「可见项首帧终态」会错位判定
      const vr = computeVisibleRange(prefixRef.current, effectiveTop, sc.clientHeight);
      const prevVisible = visibleStateRef.current;
      const visibleChanged = prevVisible.start !== vr.start || prevVisible.end !== vr.end;
      if (visibleChanged) {
        visibleStateRef.current = vr;
        setVisibleRange(vr);
      }
      // 只有前缀和/窗口真的变化才 bump：避免滚动、展开卡片等引发全列表无意义重渲
      if (prefixChanged || rangeChanged || visibleChanged) {
        setLayoutSeq((v) => v + 1);
      }
      // 贴底跟随：sticky 期间每次布局后贴底（用实时 scrollHeight——估算→实测的
      // 收敛过程中每轮 RO→layout 都重贴，视觉上持续贴住最新消息不跳动）。
      // 双 rAF 等待本次渲染提交（新 spacer DOM）后再滚，避免互相打架。
      if (followRef.current && stickyRef.current) {
        requestAnimationFrame(() => {
          const s = scrollerRef.current;
          if (s && followRef.current && stickyRef.current) {
            // scrollTop 会被浏览器钳制到 scrollHeight - clientHeight，预期值必须同口径
            selfScrollTopRef.current = Math.max(0, s.scrollHeight - s.clientHeight);
            s.scrollTop = s.scrollHeight;
            // 贴底后的 scroll 事件会被识别为「自身滚动」而跳过 atBottom 改写：
            // 这里直接以几何校准，避免残留 false 让「返回底部」按钮一直显示
            syncAtBottom();
          }
        });
      }
    } else {
      setLayoutSeq((v) => v + 1);
    }
  }, [syncAtBottom]);

  const scheduleLayout = useCallback(() => {
    if (rafLayoutRef.current !== null) return;
    rafLayoutRef.current = requestAnimationFrame(() => {
      rafLayoutRef.current = null;
      runLayout();
    });
  }, [runLayout]);

  /**
   * 关闭程序滚动窗口期并做一次收尾校准：
   * 平滑滚动期间的中间态 scroll 事件被屏蔽，窗口结束（scrollend / 兜底超时 / 用户接管）
   * 时按当前实际位置补齐 atBottom 与 sticky 判定。
   */
  const closeProgrammatic = useCallback(() => {
    if (!programmaticRef.current) return;
    programmaticRef.current = false;
    if (programmaticTimerRef.current !== null) {
      window.clearTimeout(programmaticTimerRef.current);
      programmaticTimerRef.current = null;
    }
    const sc = scrollerRef.current;
    if (!sc) return;
    // 收尾校准：把「上一帧 scrollTop」与「自身滚动预期」同步到当前位置，
    // 避免下一帧用户滚动时用陈旧基准误判方向。
    selfScrollTopRef.current = null;
    lastScrollTopRef.current = sc.scrollTop;
    const dist = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    // 远端不平滑落点 = 用户已离开底部：显式脱跟；随后统一交给 syncAtBottom 派生 atBottom
    if (dist > thresholdRef.current) stickyRef.current = false;
    syncAtBottom();
  }, [syncAtBottom]);

  /** 开启程序滚动窗口期（仅平滑滚动需要）：scrollend 优先关闭，兜底超时保证一定关闭 */
  const openProgrammatic = useCallback(() => {
    programmaticRef.current = true;
    if (programmaticTimerRef.current !== null) {
      window.clearTimeout(programmaticTimerRef.current);
    }
    programmaticTimerRef.current = window.setTimeout(() => {
      programmaticTimerRef.current = null;
      closeProgrammatic();
    }, PROGRAMMATIC_FALLBACK_MS);
  }, [closeProgrammatic]);

  /** 卸载时清掉兜底定时器（防闭包持有已卸载组件） */
  useEffect(
    () => () => {
      if (programmaticTimerRef.current !== null) {
        window.clearTimeout(programmaticTimerRef.current);
        programmaticTimerRef.current = null;
      }
      if (scrollIdleTimerRef.current !== null) {
        window.clearTimeout(scrollIdleTimerRef.current);
        scrollIdleTimerRef.current = null;
      }
      // 卸载时若仍处于「滚动中」，必须恢复水合暂停（否则后续消息永远不再升级 Markdown）
      scrollingCbRef.current?.(false);
    },
    [],
  );

  // 卸载即列表消失：滚动位置不再有意义，显式告知宿主「在底部」，
  // 避免宿主 atBottom 残留 false → 空白页（列表未挂载）「返回底部」按钮幽灵出现。
  useEffect(() => {
    return () => {
      atBottomRef.current = true;
      bottomCbRef.current?.(true);
    };
  }, []);

  // ===== ResizeObserver：条目实测 + 容器尺寸 =====
  const cellObserverRef = useRef<ResizeObserver | null>(null);
  const scrollerObserverRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    cellObserverRef.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const key = el.dataset.vlKey;
        const h = entry.contentRect.height;
        if (!key || h <= 0) continue;
        if (heightsRef.current.get(key) !== h) {
          heightsRef.current.set(key, h);
          changed = true;
        }
      }
      if (changed) {
        // 异步高度变化（RunCode 流式输出 / 卡片展开）发生在两次布局之间：
        // 若仍在贴底跟随，立即按真实 scrollHeight 贴住，避免只靠下一帧 rAF 导致露缝。
        const sc = scrollerRef.current;
        if (sc && followRef.current && stickyRef.current && !programmaticRef.current) {
          selfScrollTopRef.current = Math.max(0, sc.scrollHeight - sc.clientHeight);
          sc.scrollTop = sc.scrollHeight;
          syncAtBottom();
        }
        dirtyRef.current = true;
        scheduleLayout();
      }
    });
    scrollerObserverRef.current = new ResizeObserver(() => {
      dirtyRef.current = true;
      scheduleLayout();
    });
    return () => {
      cellObserverRef.current?.disconnect();
      scrollerObserverRef.current?.disconnect();
      cellObserverRef.current = null;
      scrollerObserverRef.current = null;
    };
  }, [scheduleLayout, syncAtBottom]);

  /** 条目包裹层 ref（稳定回调 + React19 cleanup 卸载时反注册） */
  const cellRef = useCallback((el: HTMLElement | null) => {
    if (el) {
      cellObserverRef.current?.observe(el);
      return () => cellObserverRef.current?.unobserve(el);
    }
    return undefined;
  }, []);

  /** 滚动容器 ref：暴露给宿主 + 容器尺寸观察（稳定回调：不随宿主内联箭头重建）。
   *  scrollend：程序滚动窗口期的首选关闭通道（优于 700ms 兜底超时）。 */
  const scrollerRefCb = useCallback(
    (el: HTMLDivElement | null) => {
      scrollerRef.current = el;
      registerScrollerRef.current?.(el);
      if (el) {
        scrollerObserverRef.current?.observe(el);
        el.addEventListener('scrollend', closeProgrammatic);
        return () => {
          el.removeEventListener('scrollend', closeProgrammatic);
          scrollerObserverRef.current?.unobserve(el);
          if (scrollerRef.current === el) scrollerRef.current = null;
        };
      }
      return undefined;
    },
    [closeProgrammatic],
  );

  /**
   * 同步实测已挂载条目（在 layout effect 内、paint 之前执行）：
   * 只测「本轮新挂载、尚未实测」的条目（旧条目高度由 ResizeObserver 维护）。
   * 改为增量实测后，滚动/展开卡片不再每轮对所有 cell 读 offsetHeight（强制回流）。
   */
  const syncMeasure = useCallback(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const cells = sc.querySelectorAll<HTMLElement>('[data-vl-key]');
    let changed = false;
    for (const el of cells) {
      const key = el.dataset.vlKey;
      if (!key) continue;
      // 已实测过：高度变化由 ResizeObserver 负责，避免重复强制回流
      if (measuredKeysRef.current.has(key)) continue;
      const h = el.offsetHeight;
      if (h <= 0) continue;
      measuredKeysRef.current.add(key);
      const prev = heightsRef.current.get(key);
      // 容差 1px：RO 写入的是 contentRect.height（小数），此处是 offsetHeight（整数取整）。
      // 不做容差会让两者来回覆盖 → dirty 反复置位 → 持续重排（自激循环）。
      if (prev === undefined || Math.abs(prev - h) > 1) {
        heightsRef.current.set(key, h);
        changed = true;
      }
    }
    if (changed) dirtyRef.current = true;
  }, []);

  // ===== 条目变化：置贴底意图 + 重排（用贴底锚定算出尾部区间） =====
  // 注意：这里**不**做 `scrollTop = scrollHeight`。该写法的落点依赖 DOM 的 scrollHeight，
  // 而首帧 DOM 还没反映本次 prefix（无 cell）→ scrollHeight 极小 → 区间算到顶部，
  // 随后贴底把视口移到底部却只挂了顶部条目 → 可见区空 spacer（「先错位、再排好」）。
  // 真实落位统一交给下方「无依赖」layout effect（用真实 scrollHeight，且此时 range 已是尾部）。
  useLayoutEffect(() => {
    dirtyRef.current = true;
    if (items.length > 0) {
      if (initialBottom && !bottomDoneRef.current) {
        bottomDoneRef.current = true;
        // 只置「贴底意图」：sticky 让后续每轮布局都贴底，实测收敛期间持续贴住不跳动
        stickyRef.current = true;
        // 首屏数据刚到达：接下来 600ms 是「估算→实测」收敛窗口，期间的负 delta
        // 是浏览器被动钳制 scrollTop 造成的，不能当作「用户上滑」去加载更早历史。
        startArmedAtRef.current = Date.now() + 600;
      }
    } else {
      bottomDoneRef.current = false;
    }
    // 以「贴底锚定」的 effectiveTop 计算 range/visibleRange → 首帧挂的就是尾部条目
    runLayout();
  }, [items, initialBottom, runLayout]);

  // ===== 布局窗口变化后、paint 前的实测 + 重排 + 贴底 =====
  // 依赖 [range, visibleRange, layoutSeq]：只在「渲染窗口 / 前缀和」真正变化的那一轮执行
  // （即首次挂出 cell、内容增长、容器尺寸变化等），不对无关 commit 做强制布局。
  // ① 同步实测：修正估算高度（容差 1px，不会与 RO 的小数高度来回覆盖 → 不自激）；
  // ② 有修正才重排（无变化时 runLayout 内部 early-return）；
  // ③ 用真实 scrollHeight 落到底：此时 range 已是尾部区间，落位后尾部条目正落在视口内。
  // 程序滚动窗口期（平滑「返回底部」）跳过：不把平滑动画打断成瞬移。
  useLayoutEffect(() => {
    if (programmaticRef.current) return;
    const sc = scrollerRef.current;
    if (!sc) return;
    syncMeasure();
    runLayout();
    if (followRef.current && stickyRef.current) {
      // 同上：预期值按钳制后的 scrollTop 记录
      selfScrollTopRef.current = Math.max(0, sc.scrollHeight - sc.clientHeight);
      sc.scrollTop = sc.scrollHeight;
    }
    // ④ 贴底态校准：布局/高度变化（流式增长、回复结束的操作栏出现、页脚收起）后以几何为准，
    // 纠正被 self-initiated 跳过而残留的 atBottom=false（「已在底部仍显示返回底部」的根因）
    syncAtBottom();
  }, [range, visibleRange, layoutSeq, syncAtBottom]);

  // ===== 会话切换重置（组件不重挂的参数变化场景） =====
  useEffect(() => {
    if (sessionKey === undefined) return;
    // 切会话前若仍在平滑滚动的程序窗口期：立即结束（防串会话残留窗口屏蔽新会话判定）
    closeProgrammatic();
    // 上一个会话可能被用户上滑过（sticky=false）——新会话必须恢复贴底语义
    stickyRef.current = true;
    bottomDoneRef.current = false;
    // 清掉跨会话的滚动基准，避免新会话首帧被误判为「用户上滑」
    lastScrollTopRef.current = 0;
    selfScrollTopRef.current = null;
    // 新会话 / 首次挂载一律从底部开始：无条件告知宿主「在底部」。
    // 不能只在内部 atBottomRef 为 false 时才通知——首次挂载时内部 ref 本就为 true，
    // 而宿主可能残留上一处列表 / 上一会话的 false → 按钮在已贴底的新列表中幽灵出现。
    atBottomRef.current = true;
    bottomCbRef.current?.(true);
    // 高度缓存按消息 key 索引，跨会话残留无引用且无限膨胀 → 清空重测
    heightsRef.current.clear();
    measuredKeysRef.current.clear();
    rangeStateRef.current = { start: 0, end: 0 };
    visibleStateRef.current = { start: 0, end: 0 };
    autoFillDepthRef.current = 0;
    // 新会话初始化窗口：贴底与实测收敛期间不触发 startReached
    startArmedAtRef.current = Date.now() + 400;
    dirtyRef.current = true;
    runLayout();
  }, [sessionKey, runLayout, closeProgrammatic]);

  // ===== 自动补页：内容不足 1.5 屏时静默补页（最多连续 2 次/会话） =====
  useEffect(() => {
    if (!autoFillRef.current) return;
    const sc = scrollerRef.current;
    if (!sc || items.length === 0) return;
    const total = prefixRef.current[prefixRef.current.length - 1] ?? 0;
    if (total >= sc.clientHeight * 1.5) {
      autoFillDepthRef.current = 0;
      return;
    }
    if (autoFillDepthRef.current >= 2) return;
    autoFillDepthRef.current += 1;
    startCbRef.current?.();
  }, [layoutSeq, items.length]);

  // ===== 键盘滚动：向上键退出贴底跟随（window 级，排除可编辑目标） =====
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'PageUp' && e.key !== 'ArrowUp' && e.key !== 'Home') return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      ) {
        return;
      }
      stickyRef.current = false;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ===== 滚动处理（rAF 节流） =====
  const handleScroll = useCallback(() => {
    if (rafScrollRef.current !== null) return;
    rafScrollRef.current = requestAnimationFrame(() => {
      rafScrollRef.current = null;
      const sc = scrollerRef.current;
      if (!sc) return;
      const top = sc.scrollTop;
      const dist = sc.scrollHeight - top - sc.clientHeight;
      // 速度感知：px/ms。快速滚动时扩大 overscan，保证视口前方始终有已挂载内容
      const nowMs = performance.now();
      const dt = Math.max(1, nowMs - lastScrollAtRef.current);
      const delta = top - lastScrollTopRef.current;
      lastScrollAtRef.current = nowMs;
      velocityRef.current = Math.abs(delta) / dt;
      lastScrollDeltaRef.current = delta;
      // 速度预测只服务于「向上补历史」：向下滚动不通知宿主预取；
      // 100ms 节流把回调频率限制在 10 次/秒（避免每帧触发请求判定）。
      if (delta < 0 && nowMs - lastMetricsAtRef.current >= SCROLL_METRICS_THROTTLE_MS) {
        lastMetricsAtRef.current = nowMs;
        metricsCbRef.current?.({
          velocity: velocityRef.current,
          direction: -1,
          scrollTop: top,
        });
      }
      scrollingCbRef.current?.(true);
      if (scrollIdleTimerRef.current !== null) window.clearTimeout(scrollIdleTimerRef.current);
      scrollIdleTimerRef.current = window.setTimeout(() => {
        scrollIdleTimerRef.current = null;
        velocityRef.current = 0;
        // 停止滚动后清空跳变记忆：避免后续布局继续按极端 overscan 过度挂载
        lastScrollDeltaRef.current = 0;
        scrollingCbRef.current?.(false);
      }, 120);
      const dynamicOverscan = Math.max(
        overscanRef.current,
        Math.min(
          MAX_DYNAMIC_OVERSCAN_PX,
          overscanRef.current +
            Math.max(velocityRef.current * VELOCITY_OVERSCAN_FACTOR, Math.abs(delta)),
        ),
      );
      // 识别「自身程序滚动」（贴底 / scrollToBottom('auto')）触发的 scroll 事件：
      // 与预期 scrollTop 对齐则视为自身滚动，跳过 atBottom/sticky 改写。
      // 不做这层识别时，「滚动后内容继续增长」会让距离读成增长值 → 跟随态被误关、按钮误显。
      const expected = selfScrollTopRef.current;
      if (expected !== null && Math.abs(expected - top) > 2) selfScrollTopRef.current = null;
      const selfInitiated = expected !== null && Math.abs(expected - top) <= 2;
      // 程序滚动窗口期（平滑滚到底途中）：不让平滑过程中的中间态改写 atBottom/sticky，
      // 否则按钮会「先消失→中途闪现→再消失」，贴底也会被中间态误判为脱跟。
      if (!programmaticRef.current && !selfInitiated) {
        // 仅「用户主动上滑」（scrollTop 相对上一帧变小）才脱离贴底跟随。
        // 内容增长（工具卡片展开 / 流式输出涌入）不改变 scrollTop，绝不脱离跟随。
        // 仍在底部阈值内时，负 delta 来自内容缩短后浏览器钳制 scrollTop（页脚收起、
        // RunCode 卡片折叠等），不是用户上滑 —— 不能据此脱跟，否则后续内容不再贴底。
        if (top < lastScrollTopRef.current - 1 && dist > thresholdRef.current) {
          stickyRef.current = false;
        }
        // 恢复跟随必须同时满足「向下滚动」与「真的回到贴底」：
        // 内容增长本身不产生 scroll 事件，若不加方向条件，任何一次 dist 变小的
        // scroll（含布局钳制）都会把用户刚上滑出来的视口重新武装为跟随。
        if (delta > 0 && dist <= STICKY_RESUME_PX) stickyRef.current = true;
        // 对外 atBottom（按钮显隐）：跟随中恒为「在底部」（距离变大只是内容变多，
        // 不代表用户离开了底部）；仅在脱离跟随后按几何距离判定。
        const ab = stickyRef.current ? true : dist <= thresholdRef.current;
        if (ab !== atBottomRef.current) {
          atBottomRef.current = ab;
          bottomCbRef.current?.(ab);
        }
      }
      lastScrollTopRef.current = top;
      if (top > startThresholdRef.current) suppressStartRef.current = false;
      if (prefixRef.current.length > 1) {
        const r = clampRenderRange(
          computeRange(prefixRef.current, sc.scrollTop, sc.clientHeight, dynamicOverscan),
          prefixRef.current,
          sc.scrollTop,
          sc.clientHeight,
        );
        const prevRange = rangeStateRef.current;
        if (prevRange.start !== r.start || prevRange.end !== r.end) {
          rangeStateRef.current = r;
          setRange(r);
        }
        const vr = computeVisibleRange(prefixRef.current, sc.scrollTop, sc.clientHeight);
        const prevVisible = visibleStateRef.current;
        if (prevVisible.start !== vr.start || prevVisible.end !== vr.end) {
          visibleStateRef.current = vr;
          setVisibleRange(vr);
        }
      }
      // 仅在「向上滚动」且接近顶部时触发加载：初始贴底/首帧布局期间的 scroll 事件
      // （scrollTop 从 0 被程序化拉到底前后）不应被误判为「用户上滑」，
      // 否则首屏会额外拉一页历史，与后台预取重复请求同一区间。
      // 动态阈值：快速上滑时提前触发（速度 px/ms × 600，上限 3000px），
      // 避免滚到顶部 spacer 才加载造成空窗/顿挫。
      const dynamicStartThreshold = Math.max(
        startThresholdRef.current,
        Math.min(3000, Math.abs(velocityRef.current) * 600),
      );
      if (
        delta < 0 &&
        Date.now() >= startArmedAtRef.current &&
        sc.scrollTop <= dynamicStartThreshold &&
        !suppressStartRef.current
      ) {
        startCbRef.current?.();
      }
    });
  }, []);

  /** 滚轮：向上（deltaY < 0）立即退出贴底跟随。
   *  竞态根治点：滚轮一档 ≈100px 未超 atBottom 宽阈值时，scroll 判定仍「在底部」，
   *  若等 scroll 事件处理再退出，中间每轮内容增长的 sticky 拉回会把位移吃掉（无法上滑）。
   *  同时结束程序滚动窗口期：用户手势接管，后续 scroll 应正常改写 atBottom（按钮恢复显示）。 */
  const handleWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      if (e.deltaY < 0) {
        closeProgrammatic();
        stickyRef.current = false;
      }
    },
    [closeProgrammatic],
  );

  /** 触摸位移：退出贴底跟随（onTouchStart 不退出——纯点击消息内按钮不误伤跟随） */
  const handleTouchMove = useCallback(() => {
    closeProgrammatic();
    stickyRef.current = false;
  }, [closeProgrammatic]);

  // ===== 挂载即触发一次布局（scroller 就绪后） =====
  useEffect(() => {
    dirtyRef.current = true;
    scheduleLayout();
  }, [scheduleLayout]);

  // ===== API（锚定 / 滚底 / 按条目跳转） =====
  /** 按 key 查条目下标（items 通常几十到几百条，线性查找足够；找不到返回 -1） */
  const indexOfKey = useCallback((key: string): number => {
    const cur = itemsRef.current;
    const keyFn = itemKeyRef.current;
    for (let i = 0; i < cur.length; i++) {
      if (keyFn(cur[i]) === key) return i;
    }
    return -1;
  }, []);

  /** 读取条目顶部偏移；前缀和落后于数据时强制重排一次（跳转/判定要求几何最新） */
  const itemOffset = useCallback(
    (key: string): number | null => {
      const index = indexOfKey(key);
      if (index < 0) return null;
      if (prefixRef.current.length <= index) {
        dirtyRef.current = true;
        runLayout();
      }
      return prefixRef.current[index] ?? null;
    },
    [indexOfKey, runLayout],
  );

  const api = useMemo<VirtualListApi>(() => ({
    anchorPrepend: () => {
      // 同一帧内多次 prepend（缓存页连消费 / 多来源合并）复用同一个锚点：
      // 若每次重新捕获 h0 并各自加 delta，scrollTop 会被重复累加 → 位置错乱。
      const pending = pendingAnchorRef.current;
      if (pending) return { apply: pending.apply };
      const h0 = scrollerRef.current?.scrollHeight ?? 0;
      let applied = false;
      const apply = (): void => {
        if (applied) return;
        applied = true;
        pendingAnchorRef.current = null;
        const tryOnce = (retries: number): void => {
          const s = scrollerRef.current;
          if (!s) return;
          const delta = s.scrollHeight - h0;
          // 数据尚未提交（增量仍为 0）：等待下一帧再试
          if (delta === 0 && retries > 0) {
            requestAnimationFrame(() => tryOnce(retries - 1));
            return;
          }
          if (delta > 0) {
            s.scrollTop += delta;
            suppressStartRef.current = true;
            dirtyRef.current = true;
            scheduleLayout();
          }
        };
        requestAnimationFrame(() => tryOnce(PREPEND_APPLY_RETRIES));
      };
      pendingAnchorRef.current = { apply };
      return { apply };
    },
    scrollToBottom: (behavior: ScrollBehavior = 'auto') => {
      const sc = scrollerRef.current;
      if (!sc) return;
      const dist = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
      // 超远距离平滑滚动耗时过久（点了半天到不了底）→ 降级为瞬时定位
      const effective: ScrollBehavior =
        behavior === 'smooth' && dist > INSTANT_SCROLL_DISTANCE_PX ? 'auto' : behavior;
      // 主动滚底 = 恢复贴底跟随：到位后内容继续增长也持续贴住
      //（修复「点返回底部后仍差一截/被增长顶走」）。smooth 滚动的落点基于当前
      // scrollHeight，期间内容增长导致的偏差由 sticky 的后续重贴收敛。
      stickyRef.current = true;
      // 点击即隐藏按钮：内部状态翻转必须显式通知宿主——此前只改 ref 不回调，
      // 宿主 atBottom 恒为 false，按钮永不消失（一直贴在消息底部）。
      if (!atBottomRef.current) {
        atBottomRef.current = true;
        bottomCbRef.current?.(true);
      }
      // 平滑滚动期间开程序窗口期（屏蔽中间态改写）；瞬时定位无中间态，用自身滚动预期对齐
      if (effective === 'smooth') {
        selfScrollTopRef.current = null;
        openProgrammatic();
      } else {
        selfScrollTopRef.current = Math.max(0, sc.scrollHeight - sc.clientHeight);
      }
      sc.scrollTo({ top: sc.scrollHeight, behavior: effective });
    },
    getItemOffset: (key: string) => itemOffset(key),
    scrollToKey: (key: string, behavior: ScrollBehavior = 'auto') => {
      const sc = scrollerRef.current;
      if (!sc) return;
      const offset = itemOffset(key);
      if (offset === null) return;
      const dist = Math.abs(offset - sc.scrollTop);
      // 与「返回底部」同一降级策略：超远距离平滑耗时会拖很久，改为瞬时定位
      const effective: ScrollBehavior =
        behavior === 'smooth' && dist > INSTANT_SCROLL_DISTANCE_PX ? 'auto' : behavior;
      // 主动跳转 = 退出贴底跟随：流式输出继续增长时不再把视口拽回底部
      stickyRef.current = false;
      // 跳转后通常不在底部 → 立即告知宿主，让「返回底部」按钮出现
      if (atBottomRef.current) {
        atBottomRef.current = false;
        bottomCbRef.current?.(false);
      }
      if (effective === 'smooth') {
        selfScrollTopRef.current = null;
        openProgrammatic();
      } else {
        selfScrollTopRef.current = Math.min(offset, Math.max(0, sc.scrollHeight - sc.clientHeight));
      }
      sc.scrollTo({ top: offset, behavior: effective });
    },
  }), [scheduleLayout, openProgrammatic, itemOffset]);

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = api;
    return () => {
      if (apiRef.current === api) apiRef.current = null;
    };
  }, [apiRef, api]);

  // ===== 渲染 =====
  const prefix = prefixRef.current;
  // 钳制渲染区间：items 缩短（会话切换 / 数据回退）时 range 可能残留上一轮的旧值，
  // 直接 slice 会切到错误区间（错位/空白）。统一夹紧到 [0, items.length]，并保证 start ≤ end。
  let rangeStart = Math.max(0, Math.min(range.start, items.length));
  let rangeEnd = Math.max(rangeStart, Math.min(range.end, items.length));
  // 空区间保护：非空列表绝不渲染 0 条（容器高度/区间计算异常时至少保留 1 条，杜绝整屏黑）
  if (items.length > 0 && rangeEnd <= rangeStart) {
    rangeStart = Math.min(rangeStart, items.length - 1);
    rangeEnd = rangeStart + 1;
  }
  const topSpacer = prefix[rangeStart] ?? 0;
  const bottomSpacer = Math.max(0, (prefix[prefix.length - 1] ?? 0) - (prefix[rangeEnd] ?? 0));

  return (
    <div
      ref={scrollerRefCb}
      className={`h-full overflow-y-auto ${className ?? ''}`}
      onScroll={handleScroll}
      onWheel={handleWheel}
      onTouchMove={handleTouchMove}
    >
      {header}
      <div style={{ height: topSpacer }} aria-hidden="true" />
      {items.slice(rangeStart, rangeEnd).map((item, i) => {
        const index = rangeStart + i;
        const key = itemKey(item);
        const inViewport = index >= visibleRange.start && index < visibleRange.end;
        return (
          <div key={key} data-vl-key={key} ref={cellRef} style={{ contain: 'layout style' }}>
            {renderItem(item, index, inViewport)}
          </div>
        );
      })}
      <div style={{ height: bottomSpacer }} aria-hidden="true" />
      {footer}
    </div>
  );
}
