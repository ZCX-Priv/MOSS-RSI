// src/modules/context/compiler/env-probe.ts
// 环境探测：
// - 解释器探测：默认解释器 + 可用解释器列表（Windows: powershell/pwsh/cmd/git-bash；
//   POSIX: SHELL 环境变量 + zsh/bash）。Bun.which 同步探测，进程级缓存。
// - 工具链版本：node/npm/pnpm/python/git 等并行 spawn 探测（各 800ms 超时），
//   fire-and-forget 缓存；ensureEnvProbed() await 完整结果（首次 ~1s，之后 0ms）。
// - 编码：Windows 代码页（chcp）、POSIX LANG/LC_ALL；Intl locale 同步可得。
// 单一事实源：terminal 工具（tools/terminal）与系统提示词共用本模块的解释器探测结果，
// 保证「模型看到的解释器」与「实际执行的解释器」一致。
// 全部探测失败安全降级：解释器回退平台默认，工具链/编码为空——绝不阻塞主流程。

import { execSync } from 'node:child_process';
import type { Environment } from '../../../core/types';

/** 终端解释器标识（terminal 工具 interpreter 之外还包括探测到的 git-bash / pwsh / zsh） */
export type TerminalId = 'powershell' | 'pwsh' | 'cmd' | 'git-bash' | 'bash' | 'zsh' | 'sh';

export interface TerminalProbe {
  /** 默认解释器（未显式指定时 terminal 工具使用的解释器） */
  readonly defaultId: TerminalId;
  /** 可用解释器列表（含默认；按优先级排序） */
  readonly available: ReadonlyArray<TerminalId>;
}

export interface EnvProbeResult {
  readonly terminals: TerminalProbe;
  /** 开发工具链版本行（如 "node v22.11.0"；未探测到/未就绪为空数组） */
  readonly devTools: ReadonlyArray<string>;
  /** locale（如 zh-CN） */
  readonly locale: string;
  /** 编码描述（如 "GBK（代码页 936）" / "UTF-8 (zh_CN.UTF-8)"） */
  readonly encoding: string;
}

/** Git Bash 常见安装路径（which bash 命中 PATH 时也可能指向它） */
const GIT_BASH_PATHS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

/** 工具链探测清单：[可执行名, 版本参数]（java 用 -version 输出到 stderr） */
const DEV_TOOL_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['node', '--version'],
  ['npm', '--version'],
  ['pnpm', '--version'],
  ['yarn', '--version'],
  ['bun', '--version'],
  ['python', '--version'],
  ['python3', '--version'],
  ['pip', '--version'],
  ['git', '--version'],
  ['go', 'version'],
  ['rustc', '--version'],
  ['cargo', '--version'],
  ['java', '-version'],
  ['dotnet', '--version'],
];

/** 工具链探测单项超时（ms） */
const PROBE_TIMEOUT_MS = 800;

// ============================================================================
// 进程级缓存（探测结果进程内不变 → 静态系统提示词保持字节级稳定）
// ============================================================================

let terminalProbe: TerminalProbe | null = null;
let encodingDesc: string | null = null;
let devToolsPromise: Promise<ReadonlyArray<string>> | null = null;
let devToolsCache: ReadonlyArray<string> | null = null;

/** 同步工具：文件存在性（Bun.which；找不到返回 null） */
function which(bin: string): string | null {
  try {
    return Bun.which(bin) ?? null;
  } catch {
    return null;
  }
}

function fileExists(p: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * 从 git.exe 路径反推 Git Bash 的 bash.exe。
 * Git for Windows 目录约定：<root>\cmd\git.exe 与 <root>\bin\git.exe 并存，
 * bash 在 <root>\bin\bash.exe（或 <root>\usr\bin\bash.exe）。
 */
function deriveBashFromGit(gitPath: string): string[] {
  const norm = gitPath.replace(/\//g, '\\');
  const m = /^(.*)\\cmd\\git\.exe$/i.exec(norm) ?? /^(.*)\\bin\\git\.exe$/i.exec(norm);
  if (m) return [`${m[1]}\\bin\\bash.exe`];
  const mingw = /^(.*)\\mingw64\\bin\\git\.exe$/i.exec(norm);
  if (mingw) return [`${mingw[1]}\\usr\\bin\\bash.exe`, `${mingw[1]}\\bin\\bash.exe`];
  return [];
}

/**
 * 解析 Git Bash 的 bash.exe 真实路径（单一事实源：env-probe 与 terminal 解释器共用）。
 *
 * 关键缺陷修复：Git 可能装在**任意盘符**（实测本机为 `D:\Program Files\Git`），
 * 旧实现只硬编码 `C:\Program Files\Git\...` 候选 → 探测为「不可用」→ 请求 `interpreter:bash`
 * 时被静默回退到 PowerShell/CMD → 模型用 bash 语法却跑在 PowerShell 上，表现为
 * 「bash 命令执行不正常」。
 *
 * 解析顺序：PATH 中 git.exe 反推 → PATH 中的 bash → 常见安装路径。
 */
export function resolveGitBashPath(): string | null {
  const git = which('git');
  if (git) {
    for (const c of deriveBashFromGit(git)) if (fileExists(c)) return c;
  }
  const onPath = which('bash');
  if (onPath && fileExists(onPath)) return onPath;
  for (const p of GIT_BASH_PATHS) if (fileExists(p)) return p;
  return null;
}

// ============================================================================
// 解释器探测（同步；首次调用微秒级）
// ============================================================================

/** Windows 解释器探测：powershell/pwsh → cmd（ComSpec 兜底恒存在）→ git-bash（仅列表） */
function probeTerminalsWindows(): TerminalProbe {
  const available: TerminalId[] = [];
  // PowerShell：优先 powershell.exe，其次 pwsh.exe（PowerShell 7+ 单独安装）
  if (which('powershell') !== null || which('pwsh') !== null) {
    available.push('powershell');
  }
  // cmd：ComSpec 环境变量指向 cmd.exe（Windows 恒真）；which 不到也信任系统默认
  if (process.env.ComSpec || which('cmd') !== null) {
    available.push('cmd');
  }
  // Git Bash：从 git.exe 反推真实 bash 路径（任意盘符）+ PATH 中的 bash + 常见安装路径
  if (resolveGitBashPath() !== null) {
    available.push('git-bash');
  }
  // 默认：PowerShell 优先（用户决策）；不存在回退 cmd
  const defaultId: TerminalId = available.includes('powershell') ? 'powershell' : 'cmd';
  if (!available.includes('cmd')) available.push('cmd'); // 兜底保证非空
  return { defaultId, available };
}

/** POSIX 解释器探测：SHELL 环境变量 → zsh/bash → sh 兜底 */
function probeTerminalsPosix(): TerminalProbe {
  const available: TerminalId[] = [];
  const shellEnv = process.env.SHELL ?? '';
  const shellBase = shellEnv.split('/').pop() ?? '';
  const envKind: TerminalId | null = shellBase.includes('zsh')
    ? 'zsh'
    : shellBase.includes('bash')
      ? 'bash'
      : null;
  if (envKind) available.push(envKind);
  if (which('zsh') !== null && !available.includes('zsh')) available.push('zsh');
  if (which('bash') !== null && !available.includes('bash')) available.push('bash');
  if (available.length === 0) available.push('sh');
  // 默认：SHELL 声明的优先，否则 bash，再否则首个可用
  const defaultId: TerminalId = envKind ?? (available.includes('bash') ? 'bash' : available[0]);
  return { defaultId, available };
}

/** 解释器探测入口（同步；进程级缓存；terminal 工具与系统提示词共用——单一事实源） */
export function probeTerminals(isWindows: boolean): TerminalProbe {
  if (terminalProbe === null) {
    terminalProbe = isWindows ? probeTerminalsWindows() : probeTerminalsPosix();
  }
  return terminalProbe;
}

// ============================================================================
// 编码探测（同步；Windows chcp 一次性 ~50ms，进程级缓存）
// ============================================================================

const CODE_PAGE_NAMES: Record<string, string> = {
  '936': 'GBK',
  '950': 'Big5',
  '932': 'Shift-JIS',
  '949': 'EUC-KR',
  '437': 'ASCII（美国）',
  '850': 'Latin-1（西欧）',
  '1252': 'Latin-1（西欧）',
  '65001': 'UTF-8',
};

/** 编码描述（Windows：代码页；POSIX：LANG/LC_ALL；进程级缓存） */
function probeEncoding(env: Environment): string {
  if (encodingDesc !== null) return encodingDesc;
  let desc = '';
  if (env.isWindows) {
    try {
      const out = execSync('chcp', {
        timeout: 2000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim();
      const cp = /(\d+)\s*$/.exec(out)?.[1] ?? '';
      const name = CODE_PAGE_NAMES[cp];
      desc = cp ? `${name ? `${name}（代码页 ${cp}）` : `代码页 ${cp}`}` : '';
    } catch {
      desc = '';
    }
  } else {
    const lang = process.env.LANG ?? process.env.LC_ALL ?? '';
    desc = lang || '';
  }
  encodingDesc = desc;
  return desc;
}

// ============================================================================
// 工具链版本探测（异步并行；fire-and-forget + await 入口）
// ============================================================================

/** 单工具版本探测：spawn <bin> <arg>，取 stdout/stderr 首个含版本号的行（exit 0 才采信） */
async function probeOneTool(bin: string, arg: string): Promise<string | null> {
  return new Promise<string | null>(resolve => {
    let settled = false;
    const finish = (v: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* 已退出 */ }
      finish(null);
    }, PROBE_TIMEOUT_MS);
    type ProbeProc = {
      exited: Promise<number>;
      kill: (sig?: string | number) => boolean | void;
      stdout: ReadableStream<Uint8Array> | null;
      stderr: ReadableStream<Uint8Array> | null;
    };
    let proc: ProbeProc;
    try {
      proc = Bun.spawn({
        cmd: [bin, arg],
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        windowsHide: true,
      }) as unknown as ProbeProc;
    } catch {
      finish(null);
      return;
    }
    void (async () => {
      try {
        const [outBuf, errBuf] = await Promise.all([
          proc.stdout ? new Response(proc.stdout).arrayBuffer() : Promise.resolve(new ArrayBuffer(0)),
          proc.stderr ? new Response(proc.stderr).arrayBuffer() : Promise.resolve(new ArrayBuffer(0)),
        ]);
        const exitCode = await proc.exited;
        // exit 0 才采信：dotnet/python-stub 等失败时的提示行（"could not be loaded"）不得混入
        if (exitCode !== 0) {
          finish(null);
          return;
        }
        // 版本输出纯 ASCII 为主，直接 utf8 解码足够（版本号不含 CJK）
        const out = Buffer.from(outBuf).toString('utf8');
        const err = Buffer.from(errBuf).toString('utf8');
        // 首个含语义版本号的非空行（过滤 corepack 切换提示等无版本号的干扰行）
        const versionLine = [out, err]
          .flatMap(s => s.split('\n'))
          .map(l => l.trim())
          .find(l => l.length > 0 && l.length <= 120 && /\d+(\.\d+)+/.test(l)) ?? null;
        finish(versionLine ? `${bin}: ${versionLine}` : null);
      } catch {
        finish(null);
      }
    })();
  });
}

/** 工具链探测（并行；结果按命令清单顺序，只保留探测到的；python/python3 等同族保留首个命中） */
async function probeDevTools(): Promise<ReadonlyArray<string>> {
  const results = await Promise.all(
    DEV_TOOL_COMMANDS.map(([bin, arg]) => probeOneTool(bin, arg)),
  );
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const line of results) {
    if (!line) continue;
    const bin = line.split(':')[0]?.toLowerCase() ?? line;
    if (seen.has(bin)) continue;
    seen.add(bin);
    lines.push(line);
  }
  return lines;
}

/** 确保环境探测完成（prepareRequest 开头 await；首次 ~1s 并行探测，之后 0ms） */
export async function ensureEnvProbed(env: Environment): Promise<void> {
  probeTerminals(env.isWindows);
  probeEncoding(env);
  if (devToolsPromise === null) {
    devToolsPromise = probeDevTools();
    // 缓存填充失败静默降级（空工具链）
    void devToolsPromise.then(tools => { devToolsCache = tools; }).catch(() => { devToolsCache = []; });
  }
  await devToolsPromise;
}

/**
 * 同步读取探测结果（buildStaticSystemPrompt / terminal 工具共用）。
 * 工具链未就绪时返回空数组（ensureEnvProbed 之后恒完整；同步降级路径可接受）。
 */
export function getEnvProbe(env: Environment): EnvProbeResult {
  return {
    terminals: probeTerminals(env.isWindows),
    devTools: devToolsCache ?? [],
    locale: resolveLocale(),
    encoding: probeEncoding(env),
  };
}

function resolveLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ============================================================================
// 展示文案生成（[环境上下文] 消息专用；环境配对：探测到什么写什么，绝不写死）
// ============================================================================

/** 解释器人类可读名（提示词展示用） */
function terminalDisplayName(id: TerminalId): string {
  switch (id) {
    case 'powershell': return 'PowerShell';
    case 'pwsh': return 'PowerShell 7';
    case 'cmd': return 'CMD';
    case 'git-bash': return 'Git Bash';
    case 'bash': return 'Bash';
    case 'zsh': return 'Zsh';
    default: return 'sh';
  }
}

/**
 * 生成终端环境信息文案（环境配对：探测到什么写什么，绝不写死）。
 * 默认解释器与 terminal 工具（未显式指定 interpreter 时）实际使用的一致（本模块单一事实源）。
 */
function buildTerminalInfoText(env: Environment): string {
  const probe = getEnvProbe(env);
  const { defaultId, available } = probe.terminals;
  const lines: string[] = [
    `- 默认解释器：${terminalDisplayName(defaultId)}（terminal 工具未指定 interpreter 时使用它，写命令时以此语法为准）`,
  ];
  if (available.length > 0) {
    lines.push(`- 本机可用解释器：${available.map(terminalDisplayName).join('、')}`);
  }
  // 环境配对指引：Windows 上 Git Bash 缺席时明说，防止模型假设 POSIX 可用
  if (env.isWindows && !available.includes('git-bash')) {
    lines.push('- 本机没有检测到 Git Bash：不要使用 POSIX 专有语法（如 $()、单引号转义习惯），PowerShell/CMD 语法与 POSIX 有差异');
  }
  if (!env.isWindows && !available.includes('bash') && !available.includes('zsh')) {
    lines.push('- 本机没有检测到 bash/zsh：terminal 工具将以 /bin/sh 执行，避免使用 bash 专有语法');
  }
  return lines.join('\n');
}

/** 生成开发工具链文案（探测到什么列什么；缺席的工具不出现在列表中） */
function buildDevToolsText(env: Environment): string {
  const { devTools } = getEnvProbe(env);
  return devTools.length > 0
    ? devTools.map(l => `- ${l}`).join('\n')
    : '-（未探测到常用开发工具链；需要时先自行确认命令是否存在）';
}

/** 生成编码/语言环境文案 */
function buildEncodingText(env: Environment): string {
  const { locale, encoding } = getEnvProbe(env);
  const parts: string[] = [];
  if (encoding) parts.push(`终端编码 ${encoding}`);
  if (locale) parts.push(`语言环境 ${locale}`);
  return parts.length > 0 ? parts.join('；') : '（未知）';
}

export { buildTerminalInfoText, buildDevToolsText, buildEncodingText };
