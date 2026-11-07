// src/modules/computer/win32.ts
// Windows 原生顶层窗口拓扑（Bun FFI，只读）。
//
// 为什么需要它：cua 的 list_windows 不会列出无标题的浮层/弹出窗口
// （实测 WPS「新建」浮层是独立的 Chrome_WidgetWin_0 窗口），
// 导致截图与 UIA 树始终来自主窗口。这里用 EnumWindows 枚举同 pid 的全部顶层窗口，
// 供「自动目标（浮层优先）」与「前台窗口是否已切换」判定使用。
//
// 非 Windows / Bun FFI 不可用时返回 null，调用方回退到 cua list_windows。

import { Buffer } from 'node:buffer';

export interface NativeWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeWindowInfo {
  /** HWND（数值；Windows 句柄实际为 32 位，Number 转换安全） */
  hwnd: number;
  pid: number;
  className: string;
  title: string;
  bounds: NativeWindowBounds;
  visible: boolean;
  minimized: boolean;
  /** 是否为当前系统前台窗口 */
  isForeground: boolean;
  /** owner HWND（无 owner 为 0） */
  owner: number;
  /** WS_POPUP：弹出层/对话框的典型样式 */
  isPopup: boolean;
  /** WS_EX_TOOLWINDOW：工具窗口（提示/阴影等） */
  isToolWindow: boolean;
  /** EnumWindows 顺序（0 = Z 序最前） */
  zOrder: number;
}

type BunFfi = typeof import('bun:ffi');

/** user32 的最小绑定集合（只读 API） */
interface User32Bindings {
  EnumWindows: (callback: unknown, lParam: bigint) => boolean;
  GetForegroundWindow: () => bigint;
  GetWindowThreadProcessId: (hwnd: bigint, pidOut: unknown) => number;
  IsWindow: (hwnd: bigint) => boolean;
  IsWindowVisible: (hwnd: bigint) => boolean;
  IsIconic: (hwnd: bigint) => boolean;
  GetWindowTextW: (hwnd: bigint, buffer: unknown, max: number) => number;
  GetClassNameW: (hwnd: bigint, buffer: unknown, max: number) => number;
  GetWindowRect: (hwnd: bigint, rect: unknown) => boolean;
  GetWindowLongW: (hwnd: bigint, index: number) => number;
  GetWindow: (hwnd: bigint, cmd: number) => bigint;
  GetLastActivePopup: (hwnd: bigint) => bigint;
}

let ffi: BunFfi | null = null;
let user32: User32Bindings | null = null;
let initPromise: Promise<boolean> | null = null;

const GW_OWNER = 4;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_POPUP = 0x80000000;
const WS_EX_TOOLWINDOW = 0x00000080;

/**
 * 内部/基础设施窗口类名：这些不是用户可操作的目标。
 * 输入法、IME、OLE DDE、Qt 内部事件窗口、WPS 账号/阴影窗口等。
 */
const INTERNAL_CLASS_RE =
  /^(?:IME|MSCTFIME UI|OleDdeWndClass|Base_PowerMessageWindow|Chrome_SystemMessageWindow|KAccountWnd_[^ ]*|QEventDispatcherWin32_Internal_Widget.*|__#_ACCOUNTSDK.*)$/i;
const SHADOW_CLASS_RE = /ShadowBorder/i;
/**
 * 瞬态提示类窗口：tooltip / 托盘溢出等。
 * 这些窗口经常以浮层形式出现在最前面，但不是用户要操作的目标；
 * 不能把它们当浮层目标，否则截图与元素树会被提示窗劫持。
 */
const TRANSIENT_CLASS_RE =
  /^(?:tooltips?_class32|Qt[\d.]*QWindowToolTip(?:SaveBits)?|NotifyIconOverflowWindow|Chrome_Tooltip)$/i;
/**
 * 框架辅助窗口：Qt 弹出层的阴影/保存位图窗口。
 * 这类窗口可见、与内容浮层重叠、面积也不小，但不是用户目标；
 * 一旦被当成浮层，截图与 UIA 树会落到空壳窗口上。
 */
const FRAMEWORK_HELPER_CLASS_RE =
  /^Qt[\d.]*QWindow(?:PopupDropShadowSaveBits|ToolTipSaveBits)$/i;

/** 原生枚举是否已就绪（未就绪时调用方应回退 cua list_windows） */
export function isNativeWindowEnumerationAvailable(): boolean {
  return user32 !== null;
}

/** 懒初始化：仅 Windows + Bun 运行时；失败后返回 false（不抛错） */
export async function initNativeWindows(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  if (user32) return true;
  if (initPromise) return initPromise;

  initPromise = (async (): Promise<boolean> => {
    try {
      const mod = await import('bun:ffi');
      const { symbols } = mod.dlopen('user32.dll', {
        // EnumWindows 的第一个参数是函数指针：必须是 FFIType.function（ptr 会抛
        // "Unable to convert ... to a pointer"）。
        EnumWindows: { args: [mod.FFIType.function, mod.FFIType.i64], returns: mod.FFIType.bool },
        GetForegroundWindow: { args: [], returns: mod.FFIType.i64 },
        GetWindowThreadProcessId: {
          args: [mod.FFIType.i64, mod.FFIType.ptr],
          returns: mod.FFIType.u32,
        },
        IsWindow: { args: [mod.FFIType.i64], returns: mod.FFIType.bool },
        IsWindowVisible: { args: [mod.FFIType.i64], returns: mod.FFIType.bool },
        IsIconic: { args: [mod.FFIType.i64], returns: mod.FFIType.bool },
        GetWindowTextW: {
          args: [mod.FFIType.i64, mod.FFIType.ptr, mod.FFIType.i32],
          returns: mod.FFIType.i32,
        },
        GetClassNameW: {
          args: [mod.FFIType.i64, mod.FFIType.ptr, mod.FFIType.i32],
          returns: mod.FFIType.i32,
        },
        GetWindowRect: { args: [mod.FFIType.i64, mod.FFIType.ptr], returns: mod.FFIType.bool },
        GetWindowLongW: { args: [mod.FFIType.i64, mod.FFIType.i32], returns: mod.FFIType.i32 },
        GetWindow: { args: [mod.FFIType.i64, mod.FFIType.u32], returns: mod.FFIType.i64 },
        GetLastActivePopup: { args: [mod.FFIType.i64], returns: mod.FFIType.i64 },
      });
      ffi = mod;
      user32 = symbols as unknown as User32Bindings;
      return true;
    } catch {
      ffi = null;
      user32 = null;
      return false;
    }
  })();

  return initPromise;
}

/** 是否为框架辅助窗口类（Qt 弹出阴影/保存位图等，不能作为操作目标） */
export function isFrameworkHelperWindowClass(className: string): boolean {
  return FRAMEWORK_HELPER_CLASS_RE.test(className);
}

/** 是否为内部窗口类名（输入法/阴影/Qt 内部/框架辅助窗口等） */
export function isInternalWindowClass(className: string): boolean {
  return (
    INTERNAL_CLASS_RE.test(className) ||
    SHADOW_CLASS_RE.test(className) ||
    isFrameworkHelperWindowClass(className)
  );
}

/** 是否为瞬态提示类窗口（tooltip/托盘溢出等），不应作为浮层目标 */
export function isTransientWindowClass(className: string): boolean {
  return TRANSIENT_CLASS_RE.test(className);
}

/** 是否为 cua 自己的合成光标覆盖层（按标题前缀识别） */
export function isCuaOverlayWindow(info: { title: string }): boolean {
  return info.title.startsWith('Cua.AgentCursorOverlay');
}

/** 读取单个窗口信息；所有 buffer 由调用方复用（同步回调内安全） */
function readWindow(
  handle: bigint,
  pidOut: Buffer,
  titleBuf: Buffer,
  classBuf: Buffer,
  rectBuf: Buffer,
  zOrder: number,
  foreground: bigint,
): NativeWindowInfo {
  const api = user32;
  const ffiApi = ffi;
  if (!api || !ffiApi) throw new Error('native windows unavailable');

  api.GetWindowThreadProcessId(handle, ffiApi.ptr(pidOut));
  const pid = pidOut.readUInt32LE(0);

  const titleLen = api.GetWindowTextW(handle, ffiApi.ptr(titleBuf), titleBuf.length / 2);
  const classLen = api.GetClassNameW(handle, ffiApi.ptr(classBuf), classBuf.length / 2);

  api.GetWindowRect(handle, ffiApi.ptr(rectBuf));
  const left = rectBuf.readInt32LE(0);
  const top = rectBuf.readInt32LE(4);
  const right = rectBuf.readInt32LE(8);
  const bottom = rectBuf.readInt32LE(12);

  const style = api.GetWindowLongW(handle, GWL_STYLE) >>> 0;
  const exStyle = api.GetWindowLongW(handle, GWL_EXSTYLE) >>> 0;
  const owner = api.GetWindow(handle, GW_OWNER);

  return {
    hwnd: Number(handle),
    pid,
    className: classBuf.toString('utf16le', 0, Math.max(0, classLen) * 2),
    title: titleBuf.toString('utf16le', 0, Math.max(0, titleLen) * 2),
    bounds: {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    },
    visible: api.IsWindowVisible(handle),
    minimized: api.IsIconic(handle),
    isForeground: handle === foreground,
    owner: Number(owner),
    isPopup: (style & WS_POPUP) !== 0,
    isToolWindow: (exStyle & WS_EX_TOOLWINDOW) !== 0,
    zOrder,
  };
}

/**
 * 枚举顶层窗口（EnumWindows 顺序即 Z 序，前 → 后）。
 * @param pid 只看该进程；省略则返回全部顶层窗口
 * @returns null 表示原生枚举不可用（调用方回退）
 */
export function listNativeWindows(pid?: number): NativeWindowInfo[] | null {
  const api = user32;
  const ffiApi = ffi;
  if (!api || !ffiApi) return null;

  const foreground = api.GetForegroundWindow();
  const pidBuf = Buffer.alloc(4);
  const titleBuf = Buffer.alloc(2048);
  const classBuf = Buffer.alloc(512);
  const rectBuf = Buffer.alloc(16);
  const rows: NativeWindowInfo[] = [];
  let zOrder = 0;

  const callback = new ffiApi.JSCallback(
    (handle: bigint): boolean => {
      try {
        // 先读 pid 过滤：绝大多数窗口只需一次 FFI 调用
        api.GetWindowThreadProcessId(handle, ffiApi.ptr(pidBuf));
        const winPid = pidBuf.readUInt32LE(0);
        if (pid === undefined || winPid === pid) {
          rows.push(readWindow(handle, pidBuf, titleBuf, classBuf, rectBuf, zOrder, foreground));
        }
      } catch {
        // 单个窗口读取失败（权限/竞态）：跳过，不影响其余窗口
      }
      zOrder += 1;
      return true;
    },
    { args: [ffiApi.FFIType.i64, ffiApi.FFIType.i64], returns: ffiApi.FFIType.bool },
  );

  try {
    api.EnumWindows(callback, 0n);
  } finally {
    callback.close();
  }
  return rows;
}

/** 读取指定 HWND 的窗口信息（用于校验错误里出现的 actual foreground HWND） */
export function getNativeWindow(hwnd: number): NativeWindowInfo | null {
  const api = user32;
  const ffiApi = ffi;
  if (!api || !ffiApi) return null;
  try {
    const handle = BigInt(hwnd);
    if (!api.IsWindow(handle)) return null;
    return readWindow(
      handle,
      Buffer.alloc(4),
      Buffer.alloc(2048),
      Buffer.alloc(512),
      Buffer.alloc(16),
      0,
      api.GetForegroundWindow(),
    );
  } catch {
    return null;
  }
}

/** 读取当前系统前台窗口（不可用/无前台时返回 null） */
export function getForegroundWindowInfo(): NativeWindowInfo | null {
  const api = user32;
  const ffiApi = ffi;
  if (!api || !ffiApi) return null;
  try {
    const handle = api.GetForegroundWindow();
    if (!handle || !api.IsWindow(handle)) return null;
    return readWindow(
      handle,
      Buffer.alloc(4),
      Buffer.alloc(2048),
      Buffer.alloc(512),
      Buffer.alloc(16),
      0,
      handle,
    );
  } catch {
    return null;
  }
}

/**
 * 读取某个窗口最后一次激活的 owned popup（GetLastActivePopup）。
 * 用于自动目标解析：同一锚点窗口弹出的浮层/对话框优先于其他同进程窗口。
 */
export function getNativeLastActivePopup(hwnd: number): NativeWindowInfo | null {
  const api = user32;
  const ffiApi = ffi;
  if (!api || !ffiApi) return null;
  try {
    const popup = api.GetLastActivePopup(BigInt(hwnd));
    if (!popup || popup === BigInt(hwnd) || !api.IsWindow(popup)) return null;
    return readWindow(
      popup,
      Buffer.alloc(4),
      Buffer.alloc(2048),
      Buffer.alloc(512),
      Buffer.alloc(16),
      0,
      api.GetForegroundWindow(),
    );
  } catch {
    return null;
  }
}
