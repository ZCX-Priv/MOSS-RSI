// webui/src/components/shared/SplashScreen.tsx
// 入场加载屏（阶段 2）：React 挂载后接管 index.html 的 #moss-boot 骨架，视觉完全一致。
//   - 版式：logo 呼吸闪烁 → 下方三颗圆点依次弹跳 → 进度文字
//   - 真实进度引擎：里程碑 target（只增不减）来自真实加载信号，
//     display 经 rAF 平滑追赶——不虚报、不卡 99%、不突窜 100%
//   - 每浏览器会话只完整展示一次（sessionStorage 哨兵）
//   - 尊重动画总开关与系统"减弱动态效果"

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { useStore } from '../../store';

/** 会话哨兵 key：存在即本会话已展示过 */
const SPLASH_SESSION_KEY = 'moss-splash-shown';
/** 最短展示时长：保证入场段完整（ms）；首屏已就绪时不额外拖延 */
const MIN_DISPLAY_MS = 600;
/** 兜底放行：后端异常 / 路由长期未就绪时不永久卡死（ms） */
const FALLBACK_MS = 8_000;
/** 淡出时长（ms），与 CSS transition duration 保持一致 */
const EXIT_MS = 600;

// 进度里程碑 target 值（只增不减；UI 就绪是真实信号，不再是「资源列表非空」的近似）
const T_MOUNT = 30; // splash 挂载
const T_CONFIG = 55; // 配置加载完成（appConfig 就绪）
const T_PAGE = 80; // 当前路由页面真正渲染（Suspense 未挂起）
const T_READY = 100; // 会话首屏历史就绪（无 taskId 的页面视为已就绪）

export function SplashScreen() {
  const { t } = useTranslation();
  const animationSettings = useStore((s) => s.animationSettings);
  // 当前路由的会话 id：有 taskId 时才等待该会话的首屏消息加载完成
  const { pathname } = useLocation();
  const routeTaskId = pathname.startsWith('/task/') ? pathname.slice('/task/'.length) : '';

  // 渲染期同步判断（首帧即正确）：会话内已展示 / 动画总关 / 系统减弱动态 → 不展示
  const shouldShow = useMemo(() => {
    try {
      if (sessionStorage.getItem(SPLASH_SESSION_KEY) === '1') return false;
    } catch {
      // sessionStorage 不可用：照常展示（无哨兵，宁可多显示一次）
    }
    if (!animationSettings.enabled) return false;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animationSettings.enabled]);

  const [pct, setPct] = useState(0);
  const [exiting, setExiting] = useState(false);
  const [done, setDone] = useState(false);
  const targetRef = useRef(T_MOUNT);
  const displayRef = useRef(0);
  const mountedAtRef = useRef(0);
  const exitingRef = useRef(false);

  // 会话哨兵写入 + 挂载时间戳
  useEffect(() => {
    if (!shouldShow) return;
    try {
      sessionStorage.setItem(SPLASH_SESSION_KEY, '1');
    } catch {
      // 忽略：哨兵写失败不影响本次展示
    }
    mountedAtRef.current = Date.now();
  }, [shouldShow]);

  // 里程碑订阅：真实加载信号 → target（只增不减）
  useEffect(() => {
    if (!shouldShow) return;
    const bump = (v: number) => {
      if (v > targetRef.current) targetRef.current = v;
    };
    const checkState = (s: ReturnType<typeof useStore.getState>) => {
      if (s.appConfig !== null) bump(T_CONFIG);
      // 页面真正渲染（Suspense 未挂起）才算 PAGE 完成——不再用「资源列表非空」近似，
      // 否则 Splash 结束后可能仍停在 PageLoading（截图 2 的断层）。
      if (s.bootPageReady) bump(T_PAGE);
      // 有 taskId 的路由才等待该会话首屏历史；空白页（/task、/）视为已就绪
      if (routeTaskId === '' || s.bootSessionId === routeTaskId) bump(T_READY);
    };
    // 挂载时信号可能已就绪（如 splash 晚于某个 hook 完成加载）
    checkState(useStore.getState());
    const unsubStore = useStore.subscribe(checkState);
    // 兜底：后端异常 / 路由长期未就绪时强制放行，避免启动被永久阻塞
    const fallback = window.setTimeout(() => bump(T_READY), FALLBACK_MS);
    return () => {
      unsubStore();
      window.clearTimeout(fallback);
    };
  }, [shouldShow, routeTaskId]);

  // rAF 追赶循环：display 平滑逼近 target，永不反超
  useEffect(() => {
    if (!shouldShow) return;
    let raf = 0;
    const tick = () => {
      const target = targetRef.current;
      if (displayRef.current < target) {
        displayRef.current = Math.min(
          displayRef.current + (target - displayRef.current) * 0.06 + 0.15,
          target,
        );
        setPct(Math.floor(displayRef.current));
      }
      // 退出条件：目标已到 100 + 显示追平 + 满足最短展示时长
      if (
        !exitingRef.current &&
        targetRef.current >= T_READY &&
        displayRef.current >= 99.6 &&
        Date.now() - mountedAtRef.current >= MIN_DISPLAY_MS
      ) {
        exitingRef.current = true;
        setExiting(true);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [shouldShow]);

  // 淡出结束后卸载
  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(() => setDone(true), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [exiting]);

  if (!shouldShow || done) return null;

  // 阶段文案按当前显示进度推导（PAGE 之后会话消息正在补齐 → 「即将就绪」）
  const phaseKey =
    pct < T_CONFIG
      ? 'splash.loading'
      : pct < T_PAGE
        ? 'splash.config'
        : 'splash.ready';

  return (
    <div
      className="moss-splash-wrap select-none"
      data-exiting={exiting ? 'true' : 'false'}
      aria-label="MOSS"
    >
      {/* 布局样式全部内嵌（随组件 DOM 立即生效，不依赖 Tailwind CSSOM 加载时序）：
          PWA 下外部 CSS 晚到时 splash 布局/间距/字号依然正确，消除"裸布局→正常布局"跳变。
          版式与 index.html boot 骨架逐项一致（三段式：logo 呼吸 → MOSS 字样 → 文字；
          gap 24px / 26px·14px 字号 / line-height 1.5 / system-ui），切换零高度差。
          主题判定用 .dark class：main.tsx 的 initTheme 在 createRoot().render() 之前完成。 */}
      <style>{`
        .moss-splash-wrap {
          position: fixed;
          inset: 0;
          z-index: 100;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 24px;
          background: oklch(0.145 0 0);
          font-family: system-ui, sans-serif;
          transition: opacity 600ms ease-out;
        }
        html:not(.dark) .moss-splash-wrap {
          background: oklch(1 0 0);
        }
        .moss-splash-wrap[data-exiting='true'] {
          opacity: 0;
        }
        .moss-splash-logo {
          width: 80px;
          height: 80px;
          animation: moss-splash-pulse 2s ease-in-out infinite;
        }
        .moss-splash-word {
          font-size: 26px;
          font-weight: 600;
          letter-spacing: 0.3em;
          /* 抵消字距尾随空隙，保持视觉居中 */
          margin-right: -0.3em;
          line-height: 1.5;
          color: #fafafa;
        }
        html:not(.dark) .moss-splash-word {
          color: #18181b;
        }
        .moss-splash-status {
          font-size: 14px;
          line-height: 1.5;
          color: #71717a;
          font-variant-numeric: tabular-nums;
        }
        @keyframes moss-splash-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
        @media (prefers-reduced-motion: reduce) {
          .moss-splash-logo { animation: none !important; }
        }
      `}</style>
      <img
        src="/MOSS.png"
        alt="MOSS"
        width={80}
        height={80}
        className="moss-splash-logo"
        draggable={false}
      />
      <div className="moss-splash-word">MOSS</div>
      <div className="moss-splash-status">
        {t(phaseKey)} · {pct}%
      </div>
    </div>
  );
}
