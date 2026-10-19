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
import { api } from '../../api/http';
import type { InterpreterKind, InterpreterOption, TerminalInfo } from '../../types/api';

interface TerminalPanelProps {
  /** 会话 id（= taskId） */
  sessionId: string;
}

interface Instance {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  disposers: Array<() => void>;
}

/** 明暗主题配色 */
function xtermTheme(dark: boolean) {
  return dark
    ? { background: '#0b0b0c', foreground: '#e4e4e7', cursor: '#e4e4e7', selectionBackground: '#3f3f46' }
    : { background: '#ffffff', foreground: '#27272a', cursor: '#27272a', selectionBackground: '#d4d4d8' };
}

export function TerminalPanel({ sessionId }: TerminalPanelProps) {
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

  // 稳定的最新回调引用（避免 xterm 回调闭包过期）
  const writeRef = useRef(write);
  writeRef.current = write;
  const resizeRef = useRef(resize);
  resizeRef.current = resize;

  // 进入面板：拉取列表
  useEffect(() => {
    refresh();
  }, [refresh]);

  // WS 重连后再次拉取（后端可能已重启，终端列表以服务端为准）
  useEffect(() => {
    if (wsRestoredSeq > 0) refresh();
  }, [wsRestoredSeq, refresh]);

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
      create({
        cols: host ? Math.max(40, Math.floor(host.clientWidth / 8)) : 80,
        rows: host ? Math.max(10, Math.floor(host.clientHeight / 18)) : 24,
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
      // （缺失会静默退回「reflow 启用」的错误默认 → 手动输入/切换/重绘出现重复与错乱）。
      // 必须创建时给定（构造选项），故依赖 terminal.list 同帧下发的 terminalPtyBackend。
      const ptyBackend = useStore.getState().terminalPtyBackend;
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
      const busOff = onTerminalOutput(id, (data, mode) => {
        if (mode === 'replace') term.reset();
        term.write(data);
      });
      disposers.push(busOff);

      const inst: Instance = { term, fit, el, disposers };
      instancesRef.current.set(id, inst);
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
        for (const d of inst.disposers) {
          try { d(); } catch { /* 静默 */ }
        }
        try { inst.term.dispose(); } catch { /* 静默 */ }
        inst.el.remove();
        map.delete(id);
      }
    }
  }, [list, dark, ensureInstance]);

  // 活跃终端：显示 + 订阅快照 + 适配尺寸 + 聚焦
  useEffect(() => {
    const map = instancesRef.current;
    for (const [id, inst] of map.entries()) {
      inst.el.style.display = id === activeId ? 'block' : 'none';
    }
    if (!activeId) return;
    const inst = map.get(activeId);
    if (!inst) return;
    subscribe(activeId);
    // 布局稳定后再 fit（切换标签时容器尺寸才确定）
    requestAnimationFrame(() => {
      try {
        inst.fit.fit();
        resizeRef.current(activeId, inst.term.cols, inst.term.rows);
      } catch { /* 静默 */ }
      inst.term.focus();
    });
  }, [activeId, subscribe]);

  // 宿主尺寸变化 → 适配活跃终端
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const id = activeIdRef.current;
      if (!id) return;
      const inst = instancesRef.current.get(id);
      if (!inst) return;
      try {
        inst.fit.fit();
        resizeRef.current(id, inst.term.cols, inst.term.rows);
      } catch { /* 静默 */ }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

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
      const id = activeIdRef.current;
      if (!id) return;
      const inst = instancesRef.current.get(id);
      if (!inst) return;
      try {
        inst.fit.fit();
        resizeRef.current(id, inst.term.cols, inst.term.rows);
      } catch { /* 静默 */ }
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  // 卸载：清理全部实例
  useEffect(() => {
    const map = instancesRef.current;
    return () => {
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