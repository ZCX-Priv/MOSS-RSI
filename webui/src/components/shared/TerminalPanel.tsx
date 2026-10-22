// webui/src/components/shared/TerminalPanel.tsx
// 「终端」侧栏标签内容：VS Code 式内嵌多终端（标签栏 + 每终端一个 xterm 实例）。
// - 人类键入 → terminal.input；后端输出 → terminal.data → xterm 写入
// - 尺寸自适应（FitAddon + ResizeObserver）→ terminal.resize
// - 切换/新建订阅 → terminal.snapshot 快照复原；断连重连由 WS 重连自动补订阅
// 终端本体在后端进程（原生 PTY），人类与 agent 共用同一批终端。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Plus, Terminal as TerminalIcon, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTheme } from '../../contexts/ThemeContext';
import { useStore, SYSTEM_WORKING_DIRECTORY } from '../../store';
import { useTerminals } from '../../hooks/useTerminals';
import { useTabBarScroll } from '../../hooks/useTabBarScroll';
import { onTerminalOutput } from '../../lib/terminal-bus';
import { diag } from '../../lib/diag';
import { api } from '../../api/http';
import type { InterpreterKind, InterpreterOption, TerminalInfo } from '../../types/api';

interface TerminalPanelProps {
  /** 会话 id（= taskId） */
  sessionId: string;
  /** 面板当前是否展示（常驻保活；隐藏时暂停 xterm 解析以省 CPU） */
  active: boolean;
}

interface Instance {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  disposers: Array<() => void>;
  /** 待写入 xterm 的输出（非活跃/等待快照/解析中） */
  pending: string;
  /** xterm.write 进行中（背压：callback 返回前不再发起新写入） */
  writing: boolean;
  /** 隐藏期间累积超限：切回时用快照重同步，避免内存无界增长 */
  needsResync: boolean;
  /** 已请求快照但尚未收到 replace（此间 append 只缓存，避免被 reset 丢掉） */
  awaitingSnapshot: boolean;
  /** 隐藏期间收到的快照：激活时再 reset+write（避免在隐藏的 80x24 网格里解析大历史） */
  pendingSnapshot: string | null;
  /** 等待快照的兜底定时器（断线等场景放行实时输出） */
  snapshotTimer: ReturnType<typeof setTimeout> | null;
  /** 是否已订阅过（首次激活才订阅，避免对隐藏终端批量重放历史） */
  subscribed: boolean;
  /** 合批定时器 */
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** 上次写入时间（小数据立即写的节流） */
  lastWriteAt: number;
  /** 当前是否为可见终端（同一面板内切换标签时为 false） */
  visible: boolean;
  /** 立即冲刷待写数据（供激活/切回时调用） */
  flush: () => void;
}

/** terminal.resize 上报去抖（ms）：合并连续 fit，避免把布局中间态尺寸发给 PTY */
const RESIZE_REPORT_DEBOUNCE_MS = 200;
/** 单终端隐藏期间的最大待处理字符数；超出改用快照重同步 */
const MAX_PENDING_CHARS = 512 * 1024;

/** 明暗主题配色 */
function xtermTheme(dark: boolean) {
  return dark
    ? { background: '#0b0b0c', foreground: '#e4e4e7', cursor: '#e4e4e7', selectionBackground: '#3f3f46' }
    : { background: '#ffffff', foreground: '#27272a', cursor: '#27272a', selectionBackground: '#d4d4d8' };
}

export function TerminalPanel({ sessionId, active }: TerminalPanelProps) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === 'dark';
  const { list, activeId, refresh, create, write, resize, subscribe, close } = useTerminals(sessionId);
  /** 工作目录（非本机模式时作为新终端启动目录） */
  const workingDirectory = useStore((s) => s.workingDirectory);
  /** WS 重连恢复序号（重连后刷新终端列表，清掉后端重启后的陈旧条目） */
  const wsRestoredSeq = useStore((s) => s.wsRestoredSeq);

  const hostRef = useRef<HTMLDivElement>(null);
  const instancesRef = useRef<Map<string, Instance>>(new Map());
  /** 最新活跃终端 id（ResizeObserver 回调读取，避免闭包过期） */
  const activeIdRef = useRef<string | undefined>(activeId);
  activeIdRef.current = activeId;
  /** 面板是否展示（隐藏时暂停所有 xterm 解析） */
  const activeRef = useRef(active);
  activeRef.current = active;

  // 稳定的最新回调引用（避免 xterm 回调闭包过期）
  const writeRef = useRef(write);
  writeRef.current = write;
  const resizeRef = useRef(resize);
  resizeRef.current = resize;

  /** 待上报的 terminal.resize 定时器（每终端一个；去抖合并连续 fit） */
  const resizeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** 已上报给后端的网格尺寸（相同则不再发送，避免触发 ConPTY 整屏重绘） */
  const sentSizeRef = useRef<Map<string, { cols: number; rows: number }>>(new Map());

  /** 上报尺寸：与上次已发送值相同则跳过（ConPTY 收到同尺寸 Resize 也会整屏重绘） */
  const reportSize = useCallback((id: string, cols: number, rows: number) => {
    const sent = sentSizeRef.current.get(id);
    if (sent && sent.cols === cols && sent.rows === rows) return;
    sentSizeRef.current.set(id, { cols, rows });
    diag('terminal.resize', { terminalId: id, cols, rows });
    resizeRef.current(id, cols, rows);
  }, []);

  /**
   * 适配并上报尺寸。
   * - fit 先本地生效（显示立即正确）；
   * - 只有「网格真的变化」或「本实例首次上报」才安排一次去抖上报；
   * - 去抖到期取最新网格，避免布局抖动/回前台瞬间把中间态尺寸发给 PTY。
   */
  const fitAndReport = useCallback(
    (id: string, inst: Instance) => {
      const firstReport = !sentSizeRef.current.has(id);
      const colsBefore = inst.term.cols;
      const rowsBefore = inst.term.rows;
      try {
        inst.fit.fit();
      } catch {
        return; // 宿主不可测量（隐藏/零尺寸）：不报尺寸
      }
      const changed = inst.term.cols !== colsBefore || inst.term.rows !== rowsBefore;
      if (!changed && !firstReport) return;

      const timers = resizeTimersRef.current;
      const prev = timers.get(id);
      if (prev) clearTimeout(prev);
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          // 实例可能已在去抖窗口内被关闭：以实例表为准
          if (!instancesRef.current.has(id)) return;
          try {
            reportSize(id, inst.term.cols, inst.term.rows);
          } catch {
            /* 实例已销毁：静默 */
          }
        }, RESIZE_REPORT_DEBOUNCE_MS),
      );
    },
    [reportSize],
  );

  /**
   * 请求终端快照（仅「可见 / 首次激活」时调用）。
   * 调用前必须已 fit：subscribe 带上当前网格，后端先 resize 再序列化 →
   * 快照与前端屏幕同尺寸，reset+write 不再触发 reflow（错位与切回卡顿的根因）。
   */
  const requestSnapshot = useCallback(
    (id: string, inst: Instance) => {
      inst.pending = '';
      inst.pendingSnapshot = null;
      inst.awaitingSnapshot = true;
      inst.subscribed = true;
      inst.needsResync = false;
      sentSizeRef.current.set(id, { cols: inst.term.cols, rows: inst.term.rows });
      subscribe(id, inst.term.cols, inst.term.rows);
      if (inst.snapshotTimer) clearTimeout(inst.snapshotTimer);
      // 快照迟迟不来（断线等）时兜底放行实时输出，避免终端永远停在旧画面
      inst.snapshotTimer = setTimeout(() => {
        inst.snapshotTimer = null;
        if (!inst.awaitingSnapshot) return;
        inst.awaitingSnapshot = false;
        inst.flush();
      }, 3000);
    },
    [subscribe],
  );

  // 进入面板：拉取列表
  useEffect(() => {
    refresh();
  }, [refresh]);

  // WS 重连后再次拉取（后端可能已重启，终端列表以服务端为准），并重新订阅当前终端：
  // 断线期间 terminal.data 不会补发，只有重订阅才能拿到后端最新快照、补齐缺失输出。
  useEffect(() => {
    if (wsRestoredSeq <= 0) return;
    refresh();
    const id = activeIdRef.current;
    // 断线期间的输出不会补发：所有实例标记需要重同步；当前活跃终端立即拉快照，
    // 其余终端在切回时再拉（避免一次重连就重放多个终端的历史）。
    for (const [tid, inst] of instancesRef.current) {
      inst.pending = '';
      inst.pendingSnapshot = null;
      inst.awaitingSnapshot = false;
      inst.needsResync = tid !== id;
    }
    if (id) {
      const inst = instancesRef.current.get(id);
      if (inst) requestSnapshot(id, inst);
    }
  }, [wsRestoredSeq, refresh, requestSnapshot]);

  // 本机可用解释器类型（「新建终端」菜单数据源；只列真实存在的类型）
  const [interpreters, setInterpreters] = useState<InterpreterOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .listInterpreters()
      .then((r) => {
        if (!cancelled) setInterpreters(r.interpreters ?? []);
      })
      .catch(() => {
        if (!cancelled) setInterpreters([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 新建终端时使用的启动目录（本机模式不指定，用后端默认） */
  const createCwd = useCallback(
    (): string | undefined =>
      !workingDirectory || workingDirectory === SYSTEM_WORKING_DIRECTORY ? undefined : workingDirectory,
    [workingDirectory],
  );

  /** 新建终端（可指定解释器类型）；cols/rows 按宿主尺寸估算，随后由 fit 纠正 */
  const createWith = useCallback(
    (interpreter?: InterpreterKind) => {
      const host = hostRef.current;
      // 宿主不可测量（隐藏）时用 80x24 的常规尺寸，避免创建出 40x10 的小网格后立刻大改尺寸
      create({
        cols: host && host.clientWidth > 0 ? Math.max(40, Math.floor(host.clientWidth / 8)) : 80,
        rows: host && host.clientHeight > 0 ? Math.max(10, Math.floor(host.clientHeight / 18)) : 24,
        cwd: createCwd(),
        interpreter,
      });
    },
    [create, createCwd],
  );

  // ── 标签栏横向滚动（与右侧边栏标签栏同款规则：按一个标签滚动 + 自动滚入视野）──
  const {
    ref: tabBarRef,
    canScrollLeft,
    canScrollRight,
    onScroll: onTabBarScroll,
    scrollByTab: scrollTabs,
    scrollTabIntoView,
  } = useTabBarScroll<HTMLDivElement>();

  // 新建/切换终端后让当前标签自动滚入视野（解决「标签建着建着就消失」）
  useEffect(() => {
    scrollTabIntoView(activeId);
  }, [activeId, list.length, scrollTabIntoView]);

  /** 创建某终端的 xterm 实例并挂载到宿主 */
  const ensureInstance = useCallback(
    (info: TerminalInfo): Instance | null => {
      const id = info.id;
      const existing = instancesRef.current.get(id);
      if (existing) return existing;
      const host = hostRef.current;
      if (!host) return null;

      const el = document.createElement('div');
      el.style.position = 'absolute';
      el.style.inset = '0';
      el.style.display = 'none';
      host.appendChild(el);

      // Windows ConPTY 兼容：xterm 的 windowsPty 启发式必须同时提供 buildNumber 才生效
      // （缺失会静默退回「reflow 启用」的错误默认 → 重绘/切换出现重复与错乱）。
      // 必须创建时给定（构造选项）：优先用 terminal.created 单帧携带的 ptyBackend，
      // 回退到 terminal.list 同帧下发的全局值（避免列表晚到时实例永远缺 windowsPty）。
      const ptyBackend = info.ptyBackend ?? useStore.getState().terminalPtyBackend;
      const term = new Terminal({
        convertEol: false,
        cursorBlink: true,
        scrollback: 5000,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Cascadia Code", monospace',
        theme: xtermTheme(dark),
        allowProposedApi: true,
        ...(ptyBackend
          ? { windowsPty: { backend: ptyBackend.backend, buildNumber: ptyBackend.buildNumber } }
          : {}),
        // 离线历史项（后端已重启，终端本体不存在）：只读回放，禁止输入
        disableStdin: Boolean(info.offline),
      });
      const fit = new FitAddon();
      const links = new WebLinksAddon();
      term.loadAddon(fit);
      term.loadAddon(links);
      term.open(el);

      const disposers: Array<() => void> = [];
      const dataSub = term.onData((data) => writeRef.current(id, data));
      disposers.push(() => dataSub.dispose());

      // 实例先建出来（输出回调需要引用它的 pending/writing 状态）
      const inst = {
        term,
        fit,
        el,
        disposers,
        pending: '',
        writing: false,
        needsResync: false,
        awaitingSnapshot: false,
        pendingSnapshot: null,
        snapshotTimer: null,
        subscribed: false,
        flushTimer: null,
        lastWriteAt: 0,
        visible: false,
        flush: () => {},
      } as Instance;

      /**
       * 冲刷待写数据。
       * - 只有「面板展示 + 本终端可见 + 已拿到快照」时才真正写 xterm；
       * - 用 term.write 的 callback 做背压：解析完成前不再发起新写入，
       *   避免 xterm 内部 write buffer 在长输出下无限堆积（主线程卡死/内存膨胀）。
       */
      const flushNow = (): void => {
        if (inst.flushTimer) {
          clearTimeout(inst.flushTimer);
          inst.flushTimer = null;
        }
        if (
          !activeRef.current ||
          !inst.visible ||
          inst.awaitingSnapshot ||
          inst.writing ||
          !inst.pending
        ) {
          return;
        }
        const chunk = inst.pending;
        inst.pending = '';
        inst.writing = true;
        inst.lastWriteAt = Date.now();
        try {
          inst.term.write(chunk, () => {
            inst.writing = false;
            if (!inst.pending) return;
            // 仍有积累：大块立即继续，小块让出一拍再合批
            if (inst.pending.length >= 64 * 1024) flushNow();
            else if (inst.flushTimer === null) {
              inst.flushTimer = setTimeout(() => {
                inst.flushTimer = null;
                flushNow();
              }, 0);
            }
          });
        } catch {
          inst.writing = false;
        }
      };
      const scheduleFlush = (delay: number): void => {
        if (inst.flushTimer !== null) return;
        inst.flushTimer = setTimeout(() => {
          inst.flushTimer = null;
          flushNow();
        }, delay);
      };
      inst.flush = flushNow;

      const busOff = onTerminalOutput(id, (data, mode) => {
        if (mode === 'replace') {
          // 快照：清屏后整段写入。request 与 snapshot 之间到达的增量按 WS 保序
          // 已经包含在快照中（先于快照发送），必须丢弃而不是缓存，否则会重复。
          if (inst.flushTimer) {
            clearTimeout(inst.flushTimer);
            inst.flushTimer = null;
          }
          inst.pending = '';
          inst.awaitingSnapshot = false;
          inst.needsResync = false;
          if (!activeRef.current || !inst.visible) {
            // 隐藏：只暂存，激活时先 fit 再写入（避免在隐藏的 80x24 网格解析大历史、
            // 切回时 fit 触发整段 scrollback reflow → 「切入终端特别慢」）。
            inst.pendingSnapshot = data;
            return;
          }
          try {
            inst.term.reset();
            inst.term.write(data);
          } catch {
            /* 实例已销毁：静默 */
          }
          return;
        }
        // append
        if (inst.awaitingSnapshot) return; // 快照会覆盖这段（WS 保序）
        // 还没订阅过（终端一直隐藏）：无需缓存，首次激活会整体拉快照
        if (!inst.subscribed) {
          inst.needsResync = true;
          return;
        }
        inst.pending += data;
        if (!activeRef.current || !inst.visible) {
          // 隐藏期间只缓存，不解析：超过上限则放弃缓存，切回时用快照重同步
          if (inst.pending.length > MAX_PENDING_CHARS) {
            inst.pending = '';
            inst.needsResync = true;
          }
          return;
        }
        if (inst.pending.length >= 64 * 1024) {
          flushNow();
          return;
        }
        // 小数据快速路径：键盘回显等低延迟场景立即写（8ms 节流）
        if (data.length <= 256 && !inst.writing && Date.now() - inst.lastWriteAt >= 8) {
          flushNow();
          return;
        }
        scheduleFlush(16);
      });
      disposers.push(() => {
        if (inst.flushTimer) {
          clearTimeout(inst.flushTimer);
          inst.flushTimer = null;
        }
        if (inst.snapshotTimer) {
          clearTimeout(inst.snapshotTimer);
          inst.snapshotTimer = null;
        }
        inst.pending = '';
        inst.pendingSnapshot = null;
        busOff();
      });

      instancesRef.current.set(id, inst);
      // 创建时**不订阅**：隐藏终端批量拉快照 = 把多份大历史写进隐藏的 xterm，
      // 切回时再 fit 触发 reflow，正是「切入终端内容载入特别慢」的主因。
      // 首次激活时先 fit 再订阅（见激活 effect），快照与前端网格一致。

      // 新实例尚未向后端上报过尺寸：首次 fit 必须上报一次（后端创建时用的是估算值）
      sentSizeRef.current.delete(id);
      return inst;
    },
    [dark],
  );

  // 同步实例集合：新增/移除终端
  useEffect(() => {
    const map = instancesRef.current;
    const ids = new Set(list.map((t) => t.id));
    for (const term of list) {
      const inst = ensureInstance(term);
      if (inst && inst.term.options.theme?.background !== xtermTheme(dark).background) {
        inst.term.options.theme = xtermTheme(dark);
      }
      // 离线态可能随 terminal.list 刷新而变化：同步只读开关
      if (inst && inst.term.options.disableStdin !== Boolean(term.offline)) {
        inst.term.options.disableStdin = Boolean(term.offline);
      }
    }
    for (const [id, inst] of Array.from(map.entries())) {
      if (!ids.has(id)) {
        const timer = resizeTimersRef.current.get(id);
        if (timer) {
          clearTimeout(timer);
          resizeTimersRef.current.delete(id);
        }
        sentSizeRef.current.delete(id);
        for (const d of inst.disposers) {
          try { d(); } catch { /* 静默 */ }
        }
        try { inst.term.dispose(); } catch { /* 静默 */ }
        inst.el.remove();
        map.delete(id);
      }
    }
  }, [list, dark, ensureInstance]);

  // 活跃终端：显示 + 恢复渲染 + 适配尺寸 + 聚焦
  // 首次激活才订阅快照（隐藏期间不写历史）；needsResync 时重新同步；其余情况直接 flush 增量。
  useEffect(() => {
    const map = instancesRef.current;
    for (const [id, inst] of map.entries()) {
      const visible = active && id === activeId;
      inst.visible = visible;
      inst.el.style.display = visible ? 'block' : 'none';
      if (!visible && inst.flushTimer) {
        clearTimeout(inst.flushTimer);
        inst.flushTimer = null;
      }
    }
    if (!active || !activeId) return;
    const inst = map.get(activeId);
    if (!inst) return;
    // 布局稳定后：先 fit 拿到真实网格，再决定「写缓存 / 拉快照 / 应用隐藏期快照」。
    // 顺序很关键：先 fit 再订阅（后端按该网格序列化）→ reset+write 不再触发 reflow。
    requestAnimationFrame(() => {
      if (activeIdRef.current !== activeId || instancesRef.current.get(activeId) !== inst) return;
      try {
        inst.fit.fit();
      } catch {
        /* 宿主不可测量：保留原网格 */
      }
      if (inst.pendingSnapshot !== null) {
        const snap = inst.pendingSnapshot;
        inst.pendingSnapshot = null;
        inst.awaitingSnapshot = false;
        try {
          inst.term.reset();
          inst.term.write(snap);
        } catch {
          /* 实例已销毁：静默 */
        }
        inst.flush();
      } else if (!inst.subscribed || inst.needsResync) {
        requestSnapshot(activeId, inst);
      } else {
        inst.flush();
      }
      fitAndReport(activeId, inst);
      try {
        inst.term.refresh(0, Math.max(0, inst.term.rows - 1));
      } catch {
        /* 实例已销毁：静默 */
      }
      inst.term.focus();
    });
  }, [active, activeId, requestSnapshot, fitAndReport]);

  // 宿主尺寸变化 → 适配活跃终端
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      if (!activeRef.current) return;
      const id = activeIdRef.current;
      if (!id) return;
      const inst = instancesRef.current.get(id);
      if (!inst) return;
      fitAndReport(id, inst);
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [fitAndReport]);

  // 移动端（Android Chrome）在「用户手势内」聚焦当前终端——切换标签时的 rAF focus() 非手势调用，
  // Android 不会唤起软键盘，导致「输入不了命令」。tap 到终端区域时同步聚焦。
  const focusActive = useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    try {
      instancesRef.current.get(id)?.term.focus();
    } catch { /* 静默 */ }
  }, []);

  // 软键盘弹出/收起会改变可视区高度：重算终端尺寸（fit + resize），避免内容被遮挡、
  // 光标跑出可视区、以及尺寸错乱导致的「无法滚动」。visualViewport 仅在移动端可用。
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      if (!activeRef.current) return;
      const id = activeIdRef.current;
      if (!id) return;
      const inst = instancesRef.current.get(id);
      if (!inst) return;
      fitAndReport(id, inst);
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, [fitAndReport]);

  // 页面回前台：视口可能被浏览器挂起/重排 → 复核尺寸（网格未变则不会发 resize），
  // 并强制整屏重绘，避免 xterm 在后台被暂停渲染后留下未绘制的行。
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (!activeRef.current) return;
      const id = activeIdRef.current;
      if (!id) return;
      const inst = instancesRef.current.get(id);
      if (!inst) return;
      fitAndReport(id, inst);
      try {
        inst.term.refresh(0, Math.max(0, inst.term.rows - 1));
      } catch { /* 静默 */ }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [fitAndReport]);

  // 卸载：清理全部实例（含未到期的 resize 去抖定时器）
  useEffect(() => {
    const map = instancesRef.current;
    const timers = resizeTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      sentSizeRef.current.clear();
      for (const inst of map.values()) {
        for (const d of inst.disposers) {
          try { d(); } catch { /* 静默 */ }
        }
        try { inst.term.dispose(); } catch { /* 静默 */ }
        inst.el.remove();
      }
      map.clear();
    };
  }, []);

  const titleOf = useMemo(
    () => (id: string) => list.find((t) => t.id === id)?.title ?? id,
    [list],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-zinc-950">
      {/* 终端标签栏 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        {/* 左滚动箭头：仅当左侧还有未滚动到内容时显示 */}
        {canScrollLeft && (
          <button
            type="button"
            onClick={() => scrollTabs(-1)}
            title={t('task.scrollTabsLeft')}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}
        <div
          ref={tabBarRef}
          onScroll={onTabBarScroll}
          className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scroll-smooth"
        >
          {list.map((term) => (
            <div
              key={term.id}
              data-tab-id={term.id}
              className={`group flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
                term.id === activeId
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              }`}
            >
              <button
                type="button"
                onClick={() => useStore.getState().setActiveTerminal(sessionId, term.id)}
                className="flex min-w-0 items-center gap-1.5"
                title={term.cwd}
              >
                <TerminalIcon className="size-3.5 shrink-0" />
                <span className="max-w-[140px] truncate">{titleOf(term.id)}</span>
                {term.offline ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">{t('terminal.offlineTag')}</span>
                ) : (
                  !term.running && (
                    <span className="shrink-0 text-[10px] text-destructive">
                      {t('terminal.exitedTag', { code: term.exitCode ?? 0 })}
                    </span>
                  )
                )}
              </button>
              <button
                type="button"
                onClick={() => close(term.id)}
                className="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded hover:bg-muted"
                title={t('terminal.close')}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
        {/* 右滚动箭头：仅当右侧还有未滚动到内容时显示 */}
        {canScrollRight && (
          <button
            type="button"
            onClick={() => scrollTabs(1)}
            title={t('task.scrollTabsRight')}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </button>
        )}
        {/* 加号：下拉菜单选择新建的终端类型（只列本机可用） */}
        <NewTerminalMenu
          options={interpreters}
          onCreate={createWith}
          trigger={
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              title={t('terminal.newTerminal')}
            >
              <Plus className="size-4" />
            </button>
          }
        />
      </div>

      {/* 终端宿主：每终端一个绝对定位 div，仅活跃可见。
          onPointerDown：移动端在用户手势内聚焦当前终端（唤起软键盘并接收键盘输入）。 */}
      <div
        ref={hostRef}
        onPointerDown={focusActive}
        className="relative min-h-0 flex-1 overflow-hidden"
      >
        {list.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <TerminalIcon className="size-6" />
            <span className="text-xs">{t('terminal.emptyPanel')}</span>
            <NewTerminalMenu
              options={interpreters}
              onCreate={createWith}
              trigger={
                <button
                  type="button"
                  className="mt-1 rounded-md border border-border px-3 py-1 text-xs hover:bg-muted"
                >
                  {t('terminal.newTerminal')}
                </button>
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** 「新建终端」类型下拉菜单：只列本机实测可用的解释器类型 */
function NewTerminalMenu({
  options,
  onCreate,
  trigger,
}: {
  options: InterpreterOption[];
  onCreate: (interpreter?: InterpreterKind) => void;
  trigger: React.ReactNode;
}) {
  const { t } = useTranslation();
  const items = options.filter((o) => o.available);
  if (items.length === 0) {
    return (
      <span className="cursor-not-allowed opacity-50" title={t('terminal.noInterpreter')}>
        {trigger}
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} collisionPadding={8}>
        <div className="px-2 py-1 text-[11px] text-muted-foreground">{t('terminal.newTerminalMenu')}</div>
        {items.map((it) => (
          <DropdownMenuItem key={it.kind} onSelect={() => onCreate(it.kind)} className="gap-2 text-xs">
            <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span>{it.label}</span>
            {it.isDefault && (
              <span className="ml-auto text-[10px] text-muted-foreground">{t('terminal.defaultTag')}</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}