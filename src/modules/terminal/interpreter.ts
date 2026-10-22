// src/modules/terminal/interpreter.ts
// 交互式解释器解析 + **shell 集成注入**（不可见读取命令完成与退出码）。
//
// 为什么：交互式 PTY 会回显"敲进去"的文本，任何 typed 完成标记都会被人眼看到。
// 改用 OSC 133（FinalTerm/Windows Terminal 标准；VS Code 用其超集 633）——由 shell 的
// **提示符钩子**在启动期注入（不产生回显），运行期发**不可见**序列标注命令完成 + 退出码；
// 后端（service）解析序列即可精确取边界/退出码，人与自然端都看不到标记。
//
// 各 shell 的钩子与注入方式（均启动期、零可见回显）：
//   PowerShell → prompt 函数 + PSConsoleHostReadLine 包装；启动参数 -NoExit -Command <脚本>
//   cmd.exe    → 无 OSC（PROMPT 无法取上一条退出码）：固定 `prompt $P$G`，service 用提示符结算
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
  /** 是否具备不可见 OSC 完成标记（cmd 无钩子 → false，由 service 走标记兜底） */
  hasOsc: boolean;
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

/** OSC 133 C 标记（命令已读入、开始执行）：作为精确输出起点，避免依赖文本回显匹配 */
function posixEmitC(nonce: string): string {
  return `printf '\\033]133;C;${nonce}\\a'`;
}

/**
 * PowerShell 集成脚本：设输出编码 + 定义 prompt 函数（运行期发不可见 OSC）。
 *
 * 两个实测要点（缺一不可）：
 * 1. `$?` 必须是 prompt 的**第一条语句**读取：任何赋值/命令都会重置 `$?`，否则失败命令会被报成 0；
 * 2. 用 `IsInExecution` 门控：PSReadLine 会在「输入重绘」时提前调用 prompt（此时命令尚未执行），
 *    提前发出的 D 会落在命令回显之前（被回显门控丢弃）甚至造成早结算；只在
 *    `PSConsoleHostReadLine`（命令行已读入、开始执行）之后的下一次 prompt 才发 D。
 */
function powershellScript(nonce: string): string {
  return (
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` +
    `$global:__MossNonce='${nonce}'; $global:__MossInExec=$false; $global:__MossCode=$null; ` +
    // 不能用 Get-Module 判断：启动期 PSReadLine 尚未作为模块枚举出来（实测 Get-Module 为 0），
    // 但读行钩子函数已存在。显式 import 后按函数存在性判断，才能可靠安装 C/D 标记包装。
    `Import-Module PSReadLine -ErrorAction SilentlyContinue; ` +
    `if (Get-Command -Name PSConsoleHostReadLine -ErrorAction SilentlyContinue) { ` +
    `$global:__MossReadLine=$function:PSConsoleHostReadLine; ` +
    `function global:PSConsoleHostReadLine { ` +
    `$l=$global:__MossReadLine.Invoke(); $global:__MossInExec=$true; ` +
    `[Console]::Write("$([char]27)]133;C;$($global:__MossNonce)$([char]7)"); $l } }; ` +
    `function global:prompt { ` +
    `$code = if ($global:?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }; ` +
    `$global:__MossCode=$code; $e=[char]27; $b=[char]7; $n=$global:__MossNonce; ` +
    `if ($global:__MossInExec) { $global:__MossInExec=$false; [Console]::Write("$e]133;D;$code;$n$b") }; ` +
    `[Console]::Write("$e]133;A;$n$b"); ` +
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
    // 基础参数保持简洁；集成经 -NoExit -Command 注入（不产生回显）。
    // -ExecutionPolicy Bypass：长命令会落盘为 .ps1 后 dot-source，默认 Restricted 策略会阻止执行。
    args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'],
    label: 'PowerShell',
    kind: 'powershell',
    shell: 'powershell',
    hasOsc: true,
    makeIntegration: (nonce) => ({
      extraArgs: ['-NoExit', '-Command', powershellScript(nonce)],
    }),
  };
}

/** CMD 交互式配置（无 OSC 钩子：用固定提示符 `$P$G` 供 service 做提示符结算） */
function cmdInterpreter(): InteractiveInterpreter {
  return {
    bin: 'cmd.exe',
    args: [],
    label: 'CMD',
    kind: 'cmd',
    shell: 'cmd',
    hasOsc: false,
    // prompt $P$G 强制提示符为 `<盘符>:\<路径>>`（UNC 为 `\\server\share>`）：
    // AutoRun / 用户自定义 PROMPT 不再影响完成判定；输出里也绝不会出现标记命令。
    makeIntegration: () => ({
      extraArgs: ['/K', 'chcp 65001>nul & prompt $P$G'],
    }),
  };
}

/** POSIX / Git Bash 配置（bash：--rcfile 注入 PROMPT_COMMAND 钩子） */
function bashInterpreter(bin: string, label: string): InteractiveInterpreter {
  // PS0 在「命令已读入、开始执行前」展开：用它发 C 标记（bash 4.4+；不支持时静默退化，
  // 由 service 的 marker 兜底接管）。两个 nonce 占位符都要替换。
  const body =
    `[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n` +
    `__moss_pc(){ ${posixEmit('__NONCE__')}; }\n` +
    `PROMPT_COMMAND=__moss_pc\n` +
    `PS0='$(printf "\\033]133;C;__NONCE__\\a")'\n`;
  return {
    bin,
    args: ['-i'],
    label,
    kind: 'bash',
    shell: 'bash',
    hasOsc: true,
    makeIntegration: (nonce) => ({
      extraArgs: ['--rcfile', MOSS_RCFILE_PLACEHOLDER],
      rcFiles: [{ name: 'moss-bashrc', body: body.split('__NONCE__').join(nonce) }],
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
    // preexec 在命令执行前触发：发 C 标记（精确输出起点）
    `__moss_preexec(){ ${posixEmitC('__NONCE__')}; }\n` +
    `add-zsh-hook precmd __moss_precmd\n` +
    `add-zsh-hook preexec __moss_preexec\n`;
  return {
    bin,
    args: ['-i'],
    label,
    kind: 'bash',
    shell: 'zsh',
    hasOsc: true,
    makeIntegration: (nonce) => ({
      env: {
        ZDOTDIR: MOSS_RCDIR_PLACEHOLDER,
        MOSS_ORIG_ZDOTDIR: process.env.ZDOTDIR ?? '',
      },
      rcFiles: [
        { name: '.zshenv', body: zshenv },
        { name: '.zshrc', body: zshrc.split('__NONCE__').join(nonce) },
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
