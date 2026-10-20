// src/modules/terminal/interpreter.ts
// 交互式解释器解析 + **shell 集成注入**（不可见读取命令完成与退出码）。
//
// 为什么：交互式 PTY 会回显"敲进去"的文本，任何 typed 完成标记都会被人眼看到。
// 改用 OSC 133（FinalTerm/Windows Terminal 标准；VS Code 用其超集 633）——由 shell 的
// **提示符钩子**在启动期注入（不产生回显），运行期发**不可见**序列标注命令完成 + 退出码；
// 后端（service）解析序列即可精确取边界/退出码，人与自然端都看不到标记。
//
// 各 shell 的钩子与注入方式（均启动期、零可见回显）：
//   PowerShell → prompt 函数；启动参数 -NoExit -Command <脚本>（脚本同时设输出编码）
//   cmd.exe    → PROMPT 环境变量（无退出码：cmd 的 PROMPT 不能展开 %errorlevel%）
//   bash       → PROMPT_COMMAND（--rcfile 注入，先 source 用户 rc 再覆盖钩子）
//   zsh        → precmd 钩子（ZDOTDIR 指向临时目录的 .zshrc/.zshenv；同 VS Code 做法）

import { probeTerminals, resolveGitBashPath } from '../context/compiler/env-probe';
import type { InterpreterKind } from './types';

/** 生成 rc 文件时使用的占位符（由 service 在落地真实路径后替换） */
export const MOSS_RCDIR_PLACEHOLDER = '__MOSS_RCDIR__';
export const MOSS_RCFILE_PLACEHOLDER = '__MOSS_RCFILE__';

/** 启动期注入的 shell 集成（不产生可见回显） */
export interface ShellIntegration {
  /** 并入启动 argv 的额外参数 */
  extraArgs?: string[];
  /** 并入 spawn 环境的变量 */
  env?: Record<string, string>;
  /** 需落地到 <终端临时目录>/<name> 的脚本（bash --rcfile / zsh ZDOTDIR） */
  rcFiles?: Array<{ name: string; body: string }>;
}

/** 交互式解释器启动配置 */
export interface InteractiveInterpreter {
  /** 可执行文件 */
  bin: string;
  /** 基础启动参数（不含集成脚本） */
  args: string[];
  /** 展示名 */
  label: string;
  /** 解释器类型（与工具 interpreter 参数对齐） */
  kind: InterpreterKind;
  /** 实际 shell 家族（kind 归并了 bash/zsh；集成写法按此区分） */
  shell: 'powershell' | 'cmd' | 'bash' | 'zsh';
  /** 生成本次终端的集成注入（含 per-terminal nonce） */
  makeIntegration(nonce: string): ShellIntegration;
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

/** OSC 133 完成/提示符序列的「printf 形态」（bash/zsh 通用；$? = 上一条退出码） */
function posixEmit(nonce: string): string {
  return `printf '\\033]133;D;%s;${nonce}\\a\\033]133;A;${nonce}\\a' "$?"`;
}

/** PowerShell 集成脚本：设输出编码 + 定义 prompt 函数（运行期发不可见 OSC） */
function powershellScript(nonce: string): string {
  return (
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` +
    `function global:prompt { ` +
    `$e=[char]27; $b=[char]7; $n='${nonce}'; ` +
    `$code = if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }; ` +
    `[Console]::Write("$e]133;D;$code;$n$b$e]133;A;$n$b"); ` +
    `return "PS $($ExecutionContext.SessionState.Path.CurrentLocation)> " }`
  );
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
    // 基础参数保持简洁；集成经 -NoExit -Command 注入（不产生回显）
    args: ['-NoLogo', '-NoProfile'],
    label: 'PowerShell',
    kind: 'powershell',
    shell: 'powershell',
    makeIntegration: (nonce) => ({
      extraArgs: ['-NoExit', '-Command', powershellScript(nonce)],
    }),
  };
}

/** CMD 交互式配置（/K 执行编码初始化并保持交互；PROMPT 内嵌不可见 OSC，无退出码） */
function cmdInterpreter(): InteractiveInterpreter {
  return {
    bin: 'cmd.exe',
    args: [],
    label: 'CMD',
    kind: 'cmd',
    shell: 'cmd',
    makeIntegration: (nonce) => ({
      extraArgs: ['/K', 'chcp 65001>nul'],
      // cmd 的 $E = ESC；ST 用 ESC + '\'；末尾保留标准提示符 $P$G
      env: { PROMPT: `$E]133;D;${nonce}$E\\$E]133;A;${nonce}$E\\$P$G` },
    }),
  };
}

/** POSIX / Git Bash 配置（bash：--rcfile 注入 PROMPT_COMMAND 钩子） */
function bashInterpreter(bin: string, label: string): InteractiveInterpreter {
  const body =
    `[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n` +
    `__moss_pc(){ ${posixEmit('__NONCE__')}; }\n` +
    `PROMPT_COMMAND=__moss_pc\n`;
  return {
    bin,
    args: ['-i'],
    label,
    kind: 'bash',
    shell: 'bash',
    makeIntegration: (nonce) => ({
      extraArgs: ['--rcfile', MOSS_RCFILE_PLACEHOLDER],
      rcFiles: [{ name: 'moss-bashrc', body: body.replace('__NONCE__', nonce) }],
    }),
  };
}

/** zsh 配置（ZDOTDIR 指向临时目录：source 真 rc 后 add-zsh-hook precmd） */
function zshInterpreter(bin: string, label: string): InteractiveInterpreter {
  const zshenv =
    `__z="\${MOSS_ORIG_ZDOTDIR:-$HOME}"; [ -f "$__z/.zshenv" ] && . "$__z/.zshenv"\n`;
  const zshrc =
    `__z="\${MOSS_ORIG_ZDOTDIR:-$HOME}"; [ -f "$__z/.zshrc" ] && . "$__z/.zshrc"\n` +
    `autoload -Uz add-zsh-hook\n` +
    `__moss_precmd(){ ${posixEmit('__NONCE__')}; }\n` +
    `add-zsh-hook precmd __moss_precmd\n`;
  return {
    bin,
    args: ['-i'],
    label,
    kind: 'bash',
    shell: 'zsh',
    makeIntegration: (nonce) => ({
      env: {
        ZDOTDIR: MOSS_RCDIR_PLACEHOLDER,
        MOSS_ORIG_ZDOTDIR: process.env.ZDOTDIR ?? '',
      },
      rcFiles: [
        { name: '.zshenv', body: zshenv },
        { name: '.zshrc', body: zshrc.replace('__NONCE__', nonce) },
      ],
    }),
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
      if (gitBash) return bashInterpreter(gitBash, 'Git Bash');
      return defaultCfg;
    }
    return defaultCfg;
  }

  if (probe.defaultId === 'zsh') {
    return zshInterpreter('/bin/zsh', 'Zsh');
  }
  return bashInterpreter('/bin/bash', 'Bash');
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
