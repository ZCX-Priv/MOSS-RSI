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
/** scrollTop 低于该值视为「到达顶部」（触发加载更早一页） */
const START_REACH_THRESHOLD = 120;
/** anchorPrepend.apply 等待数据提交的重试帧数上限 */
const PREPEND_APPLY_RETRIES = 10;
/** 滚动后距底小于该值才恢复贴底跟随（比对外 atBottom 宽阈值严——真贴底才恢复） */
const STICKY_RESUME_PX = 32;
/** 「返回底部」超远距离阈值（px）：超过则平滑降级为瞬时定位（超长平滑耗时过久） */
const INSTANT_SCROLL_DISTANCE_PX = 3000;
/** 程序滚动窗口期兜底时长（ms）：scrollend 不可用时据此关闭窗口 */
const PROGRAMMATIC_FALLBACK_MS = 700;

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

export interface PrependAnchor {
  /** 在 prepend 数据提交后调用：按 scrollHeight 增量修正 scrollTop（自动等待提交） */
  apply: () => void;
}

export interface VirtualListApi {
  /** 数据合入前调用捕获锚点，合入后调用返回值的 apply() */
  anchorPrepend: () => PrependAnchor;
  /** 滚动到底部 */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

export interface VirtualListProps<T> {
  items: readonly T[];
  itemKey: (item: T) => string;
  /**
   * 渲染单条。第三个参数 inViewport = 该条目是否落在**精确视口**内（不含 overscan）：
   * 宿主据此让可见项首帧直接渲染终态，overscan 区条目才走占位→渐进水合（升级在视口外不可见）。
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
}

export function VirtualList<T>({
  items,
  itemKey,
  renderItem,
  className,
  header,
  footer,
  overscan = 600,
  atBottomThreshold = 100,
  initialBottom = false,
  followOutput = false,
  sessionKey,
  onStartReached,
  onAtBottomChange,
  registerScroller,
  apiRef,
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
  // registerScroller 同样入 ref：宿主常传内联箭头，若作为 useCallback 依赖会让
  // scroller ref 回调每次渲染重建（React 会先 cleanup 再重挂 → observe/unobserve 抖动）
  const registerScrollerRef = useRef(registerScroller);
  registerScrollerRef.current = registerScroller;

  const rafLayoutRef = useRef<number | null>(null);
  const rafScrollRef = useRef<number | null>(null);

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
    // 估算基准：已测高度的平均值（样本不足 4 条时用默认值）
    let sum = 0;
    let cnt = 0;
    for (const h of heights.values()) {
      sum += h;
      if (++cnt >= 16) break;
    }
    const estimate = cnt >= 4 ? sum / cnt : DEFAULT_ITEM_HEIGHT;
    const keyFn = itemKeyRef.current;
    const hs = new Array<number>(cur.length);
    for (let i = 0; i < cur.length; i++) {
      hs[i] = heights.get(keyFn(cur[i])) ?? estimate;
    }
    prefixRef.current = buildPrefixSum(hs);

    const sc = scrollerRef.current;
    if (sc) {
      // 贴底意图下 `sc.scrollTop` 不可信：DOM 尚未反映本次 prefix（首帧 prefix 仍是 [0]、
      // 无任何 cell，scrollHeight 只等于 header+footer，scrollTop 近似 0）。若照它算区间，
      // 会渲染「顶部条目 + 巨大底部 spacer」而视口又在底部 → 可见区只剩空 spacer（错位），
      // 下一帧 scroll 事件才重算归位（用户看到的「先错位、再排好」）。
      // 贴底的真实落点就是内容底部，可直接由前缀和给出（total - viewport），不依赖 DOM 高度。
      // 程序滚动窗口期（平滑「返回底部」）例外：期间由 handleScroll 驱动区间，沿动画路径挂载。
      const total = prefixRef.current[prefixRef.current.length - 1] ?? 0;
      const bottomIntent = followRef.current && stickyRef.current && !programmaticRef.current;
      const effectiveTop = bottomIntent ? Math.max(0, total - sc.clientHeight) : sc.scrollTop;
      const r = computeRange(prefixRef.current, effectiveTop, sc.clientHeight, overscanRef.current);
      setRange((prev) => (prev.start === r.start && prev.end === r.end ? prev : r));
      // range 与 visibleRange 必须同源（同一个 effectiveTop），否则「可见项首帧终态」会错位判定
      const vr = computeVisibleRange(prefixRef.current, effectiveTop, sc.clientHeight);
      setVisibleRange((prev) => (prev.start === vr.start && prev.end === vr.end ? prev : vr));
      setLayoutSeq((v) => v + 1);
      // 贴底跟随：sticky 期间每次布局后贴底（用实时 scrollHeight——估算→实测的
      // 收敛过程中每轮 RO→layout 都重贴，视觉上持续贴住最新消息不跳动）。
      // 双 rAF 等待本次渲染提交（新 spacer DOM）后再滚，避免互相打架。
      if (followRef.current && stickyRef.current) {
        requestAnimationFrame(() => {
          const s = scrollerRef.current;
          if (s && followRef.current && stickyRef.current) {
            s.scrollTop = s.scrollHeight;
          }
        });
      }
    } else {
      setLayoutSeq((v) => v + 1);
    }
  }, []);

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
    const dist = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    const ab = dist <= thresholdRef.current;
    if (ab !== atBottomRef.current) {
      atBottomRef.current = ab;
      bottomCbRef.current?.(ab);
    }
    if (dist > thresholdRef.current) stickyRef.current = false;
    if (dist <= STICKY_RESUME_PX) stickyRef.current = true;
  }, []);

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
    },
    [],
  );

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
  }, [scheduleLayout]);

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
   * 把 ResizeObserver 才会拿到的真实高度提前到首帧前写入 → 首帧几何即实测值，
   * 消除「估算 96px → 实测」造成的可见位置偏移（「位置先偏后正」）。
   */
  const syncMeasure = useCallback(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const cells = sc.querySelectorAll<HTMLElement>('[data-vl-key]');
    let changed = false;
    for (const el of cells) {
      const key = el.dataset.vlKey;
      if (!key) continue;
      const h = el.offsetHeight;
      const prev = heightsRef.current.get(key);
      // 容差 1px：RO 写入的是 contentRect.height（小数），此处是 offsetHeight（整数取整）。
      // 不做容差会让两者来回覆盖 → dirty 反复置位 → 持续重排（自激循环）。
      if (h > 0 && (prev === undefined || Math.abs(prev - h) > 1)) {
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
      sc.scrollTop = sc.scrollHeight;
    }
  }, [range, visibleRange, layoutSeq]);

  // ===== 会话切换重置（组件不重挂的参数变化场景） =====
  useEffect(() => {
    if (sessionKey === undefined) return;
    // 切会话前若仍在平滑滚动的程序窗口期：立即结束（防串会话残留窗口屏蔽新会话判定）
    closeProgrammatic();
    // 上一个会话可能被用户上滑过（sticky=false）——新会话必须恢复贴底语义
    stickyRef.current = true;
    bottomDoneRef.current = false;
    // 新会话必然贴底：显式通知宿主（组件不重挂，宿主 atBottom 会残留上一会话的 false）
    if (!atBottomRef.current) {
      atBottomRef.current = true;
      bottomCbRef.current?.(true);
    }
    // 高度缓存按消息 key 索引，跨会话残留无引用且无限膨胀 → 清空重测
    heightsRef.current.clear();
    dirtyRef.current = true;
    runLayout();
  }, [sessionKey, runLayout, closeProgrammatic]);

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
      const dist = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
      // 程序滚动窗口期（平滑滚到底途中）：不让平滑过程中的中间态改写 atBottom/sticky，
      // 否则按钮会「先消失→中途闪现→再消失」，贴底也会被中间态误判为脱跟。
      if (!programmaticRef.current) {
        // 对外 atBottom（宽阈值：按钮显隐）
        const ab = dist <= thresholdRef.current;
        if (ab !== atBottomRef.current) {
          atBottomRef.current = ab;
          bottomCbRef.current?.(ab);
        }
        // sticky 状态机：远离底部（覆盖滚动条拖动/键盘/任何来源的滚动）→ 退出跟随；
        // 真贴底（严阈值）→ 恢复跟随。程序贴底（sticky 拉回）也会走这里，dist≈0 不受影响。
        if (dist > thresholdRef.current) stickyRef.current = false;
        if (dist <= STICKY_RESUME_PX) stickyRef.current = true;
      }
      if (sc.scrollTop > START_REACH_THRESHOLD) suppressStartRef.current = false;
      if (prefixRef.current.length > 1) {
        const r = computeRange(prefixRef.current, sc.scrollTop, sc.clientHeight, overscanRef.current);
        setRange((prev) => (prev.start === r.start && prev.end === r.end ? prev : r));
        const vr = computeVisibleRange(prefixRef.current, sc.scrollTop, sc.clientHeight);
        setVisibleRange((prev) => (prev.start === vr.start && prev.end === vr.end ? prev : vr));
      }
      if (sc.scrollTop <= START_REACH_THRESHOLD && !suppressStartRef.current) {
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

  // ===== API（锚定 / 滚底） =====
  const api = useMemo<VirtualListApi>(() => ({
    anchorPrepend: () => {
      const h0 = scrollerRef.current?.scrollHeight ?? 0;
      return {
        apply: () => {
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
        },
      };
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
      // 平滑滚动期间开程序窗口期（屏蔽中间态改写）；瞬时定位无中间态，无需窗口
      if (effective === 'smooth') openProgrammatic();
      sc.scrollTo({ top: sc.scrollHeight, behavior: effective });
    },
  }), [scheduleLayout, openProgrammatic]);

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
  const rangeStart = Math.max(0, Math.min(range.start, items.length));
  const rangeEnd = Math.max(rangeStart, Math.min(range.end, items.length));
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
          <div key={key} data-vl-key={key} ref={cellRef}>
            {renderItem(item, index, inViewport)}
          </div>
        );
      })}
      <div style={{ height: bottomSpacer }} aria-hidden="true" />
      {footer}
    </div>
  );
}
