// webui/src/components/shared/ConversationNodeRail.tsx
// 对话节点导航：Task Area 最右缘的一列细刻度（与桌面端 header 的「展开/收起侧栏」按钮同列）。
// 一个用户提问 + 其后整段模型回复 = 一个节点（节点 id 即该用户消息 id）。
//
// 交互：
// - 当前节点 = 蓝色加宽短条；其余 = 灰色细条，悬停加宽。
// - 悬停某个刻度 → 左侧弹出详情卡片：展示全部节点（提问文本 + 行尾刻度标记），
//   当前节点行蓝色、其余灰色；点击卡片行或刻度本身都会平滑跳到对应提问。
// - 卡片限高滚动：最大高度取「整数行 + 半行」，底边正好切在下一行的水平中心线
//   （露出半行提示还能继续滚动）；滚动条隐藏（.no-scrollbar）。悬停靠后的刻度时，
//   卡片自动滚动到把该行置于视口中央。
// - 仅桌面端（md 以上）显示；容器 pointer-events-none，只有刻度/卡片接管事件，不挡消息区滚轮。
// - 节点少于 2 个时不渲染（单个提问无需导航）。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export interface ConversationNodeItem {
  /** 节点对应用户消息的 id（同时是 VirtualList 的 itemKey） */
  id: string;
  /** 服务端绝对消息下标（节点尚未加载时按它取分页再跳转） */
  index: number;
  /** 详情卡片中的提问文本（已截断） */
  label: string;
}

interface ConversationNodeRailProps {
  /** 消息区滚动容器（TaskPage 经 VirtualList.registerScroller 获取） */
  scroller: HTMLDivElement | null;
  nodes: ConversationNodeItem[];
  /** 节点消息顶部偏移（相对滚动内容顶部；由 VirtualList.getItemOffset 提供） */
  getOffset: (id: string) => number | null;
  /** 跳转（节点未加载时宿主负责按 index 拉取分页） */
  onJump: (node: ConversationNodeItem) => void;
}

/** 视口顶部下方多少 px 内的最后一个节点视为「当前节点」 */
const ACTIVE_OFFSET_PX = 48;
/** 距底多少 px 内视为「已贴底」：此时当前节点直接取最后一个（新提问刚出现时其顶部可能还在视口下方） */
const AT_BOTTOM_NODE_PX = 64;
/** 节点超过该数量后压缩刻度尺寸/间距（长会话时整列仍能放进视口） */
const DENSE_NODE_COUNT = 20;
/** 鼠标离开刻度/卡片后的收起延迟（ms）：跨过刻度与卡片之间的空隙不闪烁 */
const HIDE_DELAY_MS = 160;
/** 卡片距刻度列上下边缘的留白（px） */
const CARD_GUTTER_INSET = 8;

export function ConversationNodeRail({
  scroller,
  nodes,
  getOffset,
  onJump,
}: ConversationNodeRailProps) {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 当前被悬停的刻度下标（null = 未悬停，卡片收起） */
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  /** 卡片相对刻度列顶部的偏移 */
  const [cardTop, setCardTop] = useState(0);
  /** 卡片滚动区最大高度（整数行 + 半行；null = 尚未测量） */
  const [scrollMaxH, setScrollMaxH] = useState<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  // 回调/数据入 ref：滚动监听只在 scroll 容器或节点列表变化时重建，避免内联箭头每次渲染重挂监听
  const getOffsetRef = useRef(getOffset);
  getOffsetRef.current = getOffset;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  useEffect(() => {
    if (!scroller) return;
    /** 判定当前节点：贴底时取最后一个；否则 offset ≤ scrollTop + 容差 的最后一个节点 */
    const update = (): void => {
      const nodes = nodesRef.current;
      if (nodes.length === 0) return;
      const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (dist <= AT_BOTTOM_NODE_PX) {
        // 贴底 = 正在看最新提问：新节点顶部可能还在视口下方，继续用 offset 判定会停留在上一节点
        const lastId = nodes[nodes.length - 1]?.id ?? null;
        setActiveId((prev) => (prev === lastId ? prev : lastId));
        return;
      }
      const top = scroller.scrollTop + ACTIVE_OFFSET_PX;
      let current: string | null = null;
      for (const node of nodes) {
        const offset = getOffsetRef.current(node.id);
        if (offset !== null && offset <= top) current = node.id;
      }
      setActiveId((prev) => (prev === current ? prev : current));
    };
    const onScroll = (): void => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        update();
      });
    };
    update();
    // 首帧后再补一次：VirtualList 的前缀和/实测高度在挂载当帧才就绪，此刻偏移才可读
    const initialRaf = requestAnimationFrame(update);
    // 节点变化（发送消息 / 新回复到达）后布局与高度实测会晚几帧：补两次收尾判定，
    // 保证「发送后刻度栏回到最新节点」不依赖一次恰好的 scroll 事件
    const settleRaf = requestAnimationFrame(() => requestAnimationFrame(update));
    const settleTimer = window.setTimeout(update, 160);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(initialRaf);
      cancelAnimationFrame(settleRaf);
      window.clearTimeout(settleTimer);
      scroller.removeEventListener('scroll', onScroll);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [scroller, nodes]);

  // 卸载时清掉未触发的收起定时器（防闭包持有已卸载组件）
  useEffect(
    () => () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    },
    [],
  );

  /** 取消收起（进入刻度区或卡片时调用） */
  const cancelHide = (): void => {
    if (hideTimerRef.current === null) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  };

  /** 延迟收起：刻度 → 卡片之间存在空隙，立即收起会让卡片闪烁 */
  const scheduleHide = (): void => {
    cancelHide();
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setHoverIndex(null);
    }, HIDE_DELAY_MS);
  };

  const dense = nodes.length > DENSE_NODE_COUNT;

  // ===== 卡片尺寸：先测行高定 maxHeight（用满刻度列可用高度） =====
  useLayoutEffect(() => {
    if (hoverIndex === null) return;
    const nav = navRef.current;
    const scroll = scrollRef.current;
    if (!nav || !scroll) return;
    const rows = scroll.querySelectorAll<HTMLButtonElement>(':scope > button');
    // 行高用亚像素实测（offsetHeight 会取整，累计后会让「半行切割」偏差到接近一整行）
    const rowH = rows[0]?.getBoundingClientRect().height ?? 0;
    if (rowH <= 0) return;
    const gutterRect = nav.parentElement?.getBoundingClientRect();
    const gutterH = gutterRect?.height ?? nav.clientHeight;
    // 列表用满刻度列可用高度（不再按 0.7 视口比例裁切）：节点很多时内部完整滚动
    const available = Math.max(rowH, gutterH - CARD_GUTTER_INSET * 2);
    // 整数行 + 半行：滚动时底边正好切在下一行的水平中心线（半行露头提示可继续滚动）
    const maxRows = Math.max(1, Math.floor((available - rowH / 2) / rowH));
    const next = Math.round(maxRows * rowH + rowH / 2);
    setScrollMaxH((prev) => (prev === next ? prev : next));
  }, [hoverIndex, nodes, dense]);

  // ===== 卡片固定位置（垂直居中，不随悬停刻度上下移动）+ 悬停行滚到中央 =====
  useLayoutEffect(() => {
    if (hoverIndex === null) return;
    const nav = navRef.current;
    const card = cardRef.current;
    const scroll = scrollRef.current;
    if (!nav || !card || !scroll) return;
    const gutterRect = nav.parentElement?.getBoundingClientRect();
    const gutterH = gutterRect?.height ?? nav.clientHeight;
    const cardH = card.offsetHeight;
    // 固定居中：悬停不同刻度只滚动列表内部，卡片本身纹丝不动
    const nextTop = Math.round(Math.max(CARD_GUTTER_INSET, (gutterH - cardH) / 2));
    setCardTop((prev) => (prev === nextTop ? prev : nextTop));

    // 悬停行居中：长会话悬停靠后的刻度时，卡片直接定位到对应节点附近（否则永远从第 1 条开始）。
    // 滚动位置吸附到「行边界」：卡片高度是「整数行 + 半行」，行对齐时底边恰好切在下一行中心线。
    const rows = scroll.querySelectorAll<HTMLButtonElement>(':scope > button');
    const row = rows[hoverIndex];
    const rowH = rows[0]?.getBoundingClientRect().height ?? 0;
    if (row && rowH > 0) {
      const scrollRect = scroll.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const rowTopInContent = rowRect.top - scrollRect.top + scroll.scrollTop;
      const maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      const desired = rowTopInContent - (scroll.clientHeight - rowRect.height) / 2;
      const snapped = Math.round(desired / rowH) * rowH;
      scroll.scrollTop = Math.max(0, Math.min(maxScroll, Math.round(snapped)));
    }
  }, [hoverIndex, scrollMaxH, nodes, dense]);

  if (nodes.length < 2) return null;

  return (
    <nav
      ref={navRef}
      aria-label={t('task.nodesAria')}
      className={cn(
        // right-4 + 28px 刻度按钮 ⇒ 与 header 的 size-7 + px-4 侧栏按钮同列（中心对齐）
        // inset-y-0：刻度列占满任务区高度，节点很多时内部可滚动，不再被裁切
        'pointer-events-none absolute inset-y-0 right-4 z-10 hidden flex-col justify-center py-2 md:flex',
      )}
      onMouseEnter={cancelHide}
      onMouseLeave={scheduleHide}
    >
      <div className={cn('no-scrollbar flex max-h-full flex-col overflow-y-auto', dense ? 'gap-[2px]' : 'gap-1.5')}>
        {nodes.map((node, index) => {
          const active = node.id === activeId;
          return (
            <button
              key={node.id}
              type="button"
              aria-label={node.label}
              aria-current={active ? 'true' : undefined}
              onMouseEnter={() => setHoverIndex(index)}
              onClick={() => {
                setHoverIndex(null);
                onJump(node);
              }}
              className={cn(
                'group/node pointer-events-auto flex cursor-pointer items-center justify-center',
                dense ? 'h-1.5 w-7' : 'h-2.5 w-7',
              )}
            >
              <span
                className={cn(
                  'block h-[3px] rounded-full transition-all duration-150',
                  active
                    ? 'w-4 bg-primary-strong'
                    : 'w-2 bg-muted-foreground/30 group-hover/node:w-3 group-hover/node:bg-muted-foreground/70',
                )}
              />
            </button>
          );
        })}
      </div>

      {/* 悬浮详情卡片：固定垂直居中（不随悬停刻度上下移动）；列表用满高度内部滚动 */}
      {hoverIndex !== null && (
        <div
          ref={cardRef}
          role="group"
          aria-label={t('task.nodesAria')}
          onMouseEnter={cancelHide}
          style={{ top: cardTop }}
          className="pointer-events-auto absolute right-full z-20 mr-2 w-56 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-xl"
        >
          <div
            ref={scrollRef}
            className="overflow-y-auto"
            style={scrollMaxH === null ? undefined : { maxHeight: `${scrollMaxH}px` }}
          >
            {nodes.map((node, index) => {
              const active = node.id === activeId;
              const hovered = index === hoverIndex;
              return (
                <button
                  key={node.id}
                  type="button"
                  aria-label={node.label}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => {
                    setHoverIndex(null);
                    onJump(node);
                  }}
                  // 行内不更新 hoverIndex：否则指针落在卡片上会让锚点跟着变，列表在指针下抖动
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-right transition-colors hover:bg-muted/60',
                    hovered && 'bg-muted/40',
                  )}
                >
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-xs',
                      active ? 'text-primary-strong' : 'text-muted-foreground',
                    )}
                  >
                    {node.label}
                  </span>
                  <span
                    className={cn(
                      'h-[3px] shrink-0 rounded-full',
                      active ? 'w-4 bg-primary-strong' : 'w-2 bg-muted-foreground/40',
                    )}
                  />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </nav>
  );
}
