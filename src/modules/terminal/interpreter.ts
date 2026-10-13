// src/modules/terminal/interpreter.ts
// 交互式解释器解析：为持久终端挑选可用的交互式解释器程序（复用 env-probe 的实测结果作单一事实源）。

import { probeTerminals, resolveGitBashPath } from '../context/compiler/env-probe';
import type { InterpreterKind } from './types';

/** 交互式解释器启动配置 */
export interface InteractiveInterpreter {
  /** 可执行文件 */
  bin: string;
  /** 启动参数（交互式） */
  args: string[];
  /** 展示名 */
  label: string;
  /** 解释器类型（与工具 interpreter 参数对齐） */
  kind: InterpreterKind;
  /** 启动后需执行一次以设置输出编码的命令（cmd/powershell 需要） */
  encodingInit: string | null;
  /** 生成「命令完成标记 + 退出状态」命令（各解释器语法不同） */
  markerCommand: (marker: string) => string;
}

/** 解释器可用性选项（对外暴露给前端类型菜单） */
export interface InterpreterOption {
  kind: InterpreterKind;
  label: string;
  /** 本机实测是否可用 */
  available: boolean;
  /** 是否为系统默认解释器 */
  isDefault: boolean;
}

/** PowerShell 交互式配置（优先 powershell.exe，缺失回退 pwsh.exe） */
function powershellInterpreter(): InteractiveInterpreter {
  let bin = 'powershell.exe';
  try {
    if (!Bun.which('powershell') && Bun.which('pwsh')) bin = 'pwsh.exe';
  } catch {
    // 探测异常：保持 powershell.exe
  }
  return {
    bin,
    args: ['-NoLogo', '-NoProfile'],
    label: 'PowerShell',
    kind: 'powershell',
    encodingInit: '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    // 标记行尾部附退出状态（$? → True/False）
    markerCommand: (m) => `Write-Output "${m} $(if ($?) {0} else {1})"`,
  };
}

/** CMD 交互式配置（前置 chcp 65001 切换 UTF-8 代码页） */
function cmdInterpreter(): InteractiveInterpreter {
  return {
    bin: 'cmd.exe',
    args: [],
    label: 'CMD',
    kind: 'cmd',
    encodingInit: 'chcp 65001 >nul',
    // 标记行尾部附上一命令退出码（%errorlevel%）
    markerCommand: (m) => `echo ${m} %errorlevel%`,
  };
}

/** POSIX / Git Bash 配置（标记行尾部附 $?） */
function posixInterpreter(bin: string, label: string, kind: InterpreterKind): InteractiveInterpreter {
  return {
    bin,
    args: ['-i'],
    label,
    kind,
    encodingInit: null,
    markerCommand: (m) => `printf '${m} %s\\n' "$?"`,
  };
}

/**
 * 解析交互式解释器（平台 + 用户偏好 + 实测可用性）。
 * Windows：默认 PowerShell（实测可用时）否则 CMD；bash → Git Bash（实测存在时）。
 * POSIX：默认 SHELL 声明的 bash/zsh。
 */
export function resolveInterpreter(isWindows: boolean, pref?: InterpreterKind): InteractiveInterpreter {
  const probe = probeTerminals(isWindows);
  const available = new Set(probe.available);

  if (isWindows) {
    const defaultCfg: InteractiveInterpreter =
      probe.defaultId === 'powershell' ? powershellInterpreter() : cmdInterpreter();
    if (pref === 'powershell') {
      return available.has('powershell') || available.has('pwsh') ? powershellInterpreter() : defaultCfg;
    }
    if (pref === 'cmd') {
      return available.has('cmd') ? cmdInterpreter() : defaultCfg;
    }
    if (pref === 'bash') {
      // 走共享解析器（从 git.exe 反推任意盘符的 Git Bash，修复 D 盘安装被漏判的问题）
      const gitBash = available.has('git-bash') ? resolveGitBashPath() : null;
      if (gitBash) return posixInterpreter(gitBash, 'Git Bash', 'bash');
      return defaultCfg;
    }
    return defaultCfg;
  }

  const defaultBin = probe.defaultId === 'zsh' ? '/bin/zsh' : '/bin/bash';
  const defaultLabel = probe.defaultId === 'zsh' ? 'Zsh' : 'Bash';
  return posixInterpreter(defaultBin, defaultLabel, 'bash');
}

/** 生成唯一命令完成标记 */
export function makeMarker(): string {
  return `__MOSS_DONE_${Math.random().toString(36).slice(2, 10)}__`;
}

/**
 * 本机可用解释器类型列表（供前端「新建终端」菜单：只列真实存在的类型）。
 * Windows：PowerShell / CMD / Git Bash（各自按实测可用性）；POSIX：单个默认解释器（标签 Bash/Zsh）。
 */
export function listInterpreters(isWindows: boolean): InterpreterOption[] {
  const probe = probeTerminals(isWindows);
  const available = new Set(probe.available);

  if (isWindows) {
    return [
      {
        kind: 'powershell',
        label: 'PowerShell',
        available: available.has('powershell') || available.has('pwsh'),
        isDefault: probe.defaultId === 'powershell',
      },
      { kind: 'cmd', label: 'CMD', available: available.has('cmd'), isDefault: probe.defaultId === 'cmd' },
      { kind: 'bash', label: 'Git Bash', available: available.has('git-bash'), isDefault: false },
    ];
  }

  const label = probe.defaultId === 'zsh' ? 'Zsh' : 'Bash';
  return [{ kind: 'bash', label, available: true, isDefault: true }];
}