// webui/src/hooks/useTabBarScroll.ts
// 通用标签栏横向滚动：按「一个标签页」滚动 + 指定标签自动滚入视野。
// - 依赖容器内标签节点带 data-tab-id 属性；
// - 用 getBoundingClientRect 计算（不依赖 offsetParent，容器无定位也正确）。

import { useCallback, useEffect, useRef, useState } from 'react';

export function useTabBarScroll<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  /** 重算两侧箭头显隐（哪边还有未滚动到的内容才显示） */
  const syncArrows = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(max > 1 && el.scrollLeft < max - 1);
  }, []);

  /**
   * 一次点击滚动「一个标签页」：
   * - 右：把首个未完整可见标签的尾部对齐到右边缘（即滚动到该标签尾部）；
   * - 左：把左侧首个被遮挡标签的头部对齐到左边缘。
   */
  const scrollByTab = useCallback((dir: -1 | 1) => {
    const el = ref.current;
    if (!el || el.clientWidth <= 0) return;
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 0) return;
    const elRect = el.getBoundingClientRect();
    const toLocal = (r: DOMRect): number => r.left - elRect.left + el.scrollLeft;
    const tabs = Array.from(el.querySelectorAll<HTMLElement>('[data-tab-id]'));
    let target = el.scrollLeft;
    if (dir === 1) {
      const rightEdge = el.scrollLeft + el.clientWidth;
      const next = tabs.find((t) => toLocal(t.getBoundingClientRect()) + t.getBoundingClientRect().width > rightEdge + 1);
      target = next
        ? toLocal(next.getBoundingClientRect()) + next.getBoundingClientRect().width - el.clientWidth
        : max;
    } else {
      const leftEdge = el.scrollLeft;
      const prev = tabs
        .filter((t) => toLocal(t.getBoundingClientRect()) < leftEdge - 1)
        .pop();
      target = prev ? toLocal(prev.getBoundingClientRect()) : 0;
    }
    el.scrollTo({ left: Math.max(0, Math.min(max, target)), behavior: 'smooth' });
  }, []);

  /** 记录最近一次请求滚入视野的标签 id（容器由隐藏转可见时补滚） */
  const lastIdRef = useRef<string | null>(null);
  /**
   * 上一次观察到的容器宽度。
   * 仅用「由隐藏转可见」（0 → >0）这一种尺寸变化来触发「当前标签滚入视野」；
   * 其余尺寸变化（面板调宽、标签增删、**左右箭头挂载/卸载引起的 flex 宽度变化**）
   * 只重算箭头显隐，不再滚动——否则点箭头滚动 → 箭头翻转 → 容器宽度变化 →
   * ResizeObserver 触发 → 滚回当前标签（表现为「先滚动又弹回」）。
   */
  const prevWidthRef = useRef(0);

  /** 让某标签完整进入视野（新建/激活时调用；已完整可见则不滚动） */
  const scrollTabIntoView = useCallback((id: string | null | undefined) => {
    if (id) lastIdRef.current = id;
    const el = ref.current;
    const targetId = id ?? lastIdRef.current;
    if (!el || !targetId || el.clientWidth <= 0) return;
    const tab = el.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(targetId)}"]`);
    if (!tab) return;
    const elRect = el.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const left = tabRect.left - elRect.left + el.scrollLeft;
    const right = left + tabRect.width;
    const max = el.scrollWidth - el.clientWidth;
    if (right > el.scrollLeft + el.clientWidth) {
      el.scrollTo({ left: Math.min(right - el.clientWidth, max), behavior: 'smooth' });
    } else if (left < el.scrollLeft) {
      el.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
    }
  }, []);

  // 容器尺寸变化（面板展开/调宽/标签增删）时：重算箭头；
  // 仅当「由隐藏转可见」（上次宽度 <= 0 且本次 > 0）时补一次「当前标签滚入视野」
  //（此前在隐藏态调用滚动是空操作，转为可见后需要补滚一次）。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    syncArrows();
    prevWidthRef.current = el.clientWidth;
    const ro = new ResizeObserver(() => {
      syncArrows();
      const node = ref.current;
      if (!node) return;
      const width = node.clientWidth;
      const wasHidden = prevWidthRef.current <= 0;
      prevWidthRef.current = width;
      if (wasHidden && width > 0 && lastIdRef.current) {
        scrollTabIntoView(lastIdRef.current);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncArrows, scrollTabIntoView]);

  return { ref, canScrollLeft, canScrollRight, onScroll: syncArrows, scrollByTab, scrollTabIntoView };
}