// src/utils/prevent-sleep.ts
// 系统级防休眠：让 MOSS 后端持有一个「阻止系统进入睡眠」的常驻子进程。
//
// 为什么必须由后端做：浏览器的 Screen Wake Lock 只能保持屏幕/标签页活跃，
// 无法阻止合盖或系统空闲睡眠（睡眠会杀掉 WebSocket → WebUI 掉线重连）。
// 各平台实现：
//   - Windows：PowerShell 调 kernel32!SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
//   - macOS：caffeinate -i -w <moss pid>
//   - Linux：systemd-inhibit --what=sleep:idle ...（用 kill -0 轮询父进程，父进程退出即释放）
//
// 只阻止「系统睡眠」，不阻止关屏（不含 ES_DISPLAY_REQUIRED / caffeinate -d）。
// 所有子进程都监视 MOSS 的 pid：即使 MOSS 被强杀，防休眠也会随之解除，避免残留。

import type { Logger } from '../core/types';

interface KeepAwakeChild {
  kill(signal?: number | NodeJS.Signals): void;
  pid?: number;
}

let child: KeepAwakeChild | null = null;
let activePlatform: string | null = null;
let lastWarned = false;

/** 当前是否已持有防休眠句柄 */
export function isPreventSleepActive(): boolean {
  return child !== null;
}

/** 构造各平台的常驻命令；不支持的平台返回 null */
function buildCommand(): { cmd: string[]; label: string } | null {
  const pid = process.pid;
  if (process.platform === 'win32') {
    // -EncodedCommand 避免脚本里的引号/换行被 shell 破坏；脚本在父进程消失后自然退出
    const script = [
      "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class MossPower { [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern uint SetThreadExecutionState(uint esFlags); }';",
      '[MossPower]::SetThreadExecutionState(0x80000001) | Out-Null;',
      `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }`,
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return {
      cmd: [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        encoded,
      ],
      label: 'SetThreadExecutionState',
    };
  }
  if (process.platform === 'darwin') {
    return { cmd: ['caffeinate', '-i', '-w', String(pid)], label: 'caffeinate' };
  }
  if (process.platform === 'linux') {
    return {
      cmd: [
        'systemd-inhibit',
        '--what=sleep:idle',
        '--who=MOSS',
        '--why=MOSS keep awake',
        'sh',
        '-c',
        `while kill -0 ${pid} 2>/dev/null; do sleep 5; done`,
      ],
      label: 'systemd-inhibit',
    };
  }
  return null;
}

/**
 * 应用/解除防休眠（幂等）。
 * 失败不抛错：只记录一次 warn，功能降级为「不阻止休眠」，不影响后端主流程。
 */
export function applyPreventSleep(enabled: boolean, logger?: Logger): void {
  if (!enabled) {
    disposePreventSleep();
    return;
  }
  if (child) return;
  const command = buildCommand();
  if (!command) {
    if (!lastWarned) {
      lastWarned = true;
      logger?.warn('prevent-sleep: unsupported platform', { platform: process.platform });
    }
    return;
  }
  try {
    const proc = Bun.spawn(command.cmd, {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    });
    child = proc as unknown as KeepAwakeChild;
    activePlatform = command.label;
    logger?.info('prevent-sleep: enabled', {
      platform: process.platform,
      helper: command.label,
      pid: child.pid,
    });
  } catch (err) {
    if (!lastWarned) {
      lastWarned = true;
      logger?.warn('prevent-sleep: failed to start helper', {
        platform: process.platform,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** 释放防休眠句柄（进程退出/配置关闭时调用） */
export function disposePreventSleep(logger?: Logger): void {
  if (!child) return;
  const proc = child;
  child = null;
  try {
    proc.kill();
  } catch {
    // 已退出
  }
  if (activePlatform) {
    logger?.info('prevent-sleep: disabled', { helper: activePlatform });
    activePlatform = null;
  }
}
