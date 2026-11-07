// src/modules/computer/native-uia.ts
// Windows 原生 UIA 树读取（PowerShell + UIAutomationClient）。
//
// 为什么需要它：cua 的 get_window_state 只认它自己登记过的窗口（有标题的顶层窗口），
// Qt 自绘弹层（Qt5QWindowPopupSaveBits 等）标题为空，驱动直接拒绝寻址。
// 这里用系统 PowerShell 直接对任意 HWND 走 UIA 树，作为「不可寻址浮层」的兜底观察。
//
// 只读、失败不抛错：非 Windows / PowerShell 不可用 / COM 失败 / 超时都返回 null，
// 调用方降级为「仅整屏像素」。

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface NativeUiaNode {
  /** 相对根节点的深度（0 = 根窗口） */
  depth: number;
  /** Button / Edit / Window ...（去掉 ControlType. 前缀） */
  controlType: string;
  name: string;
  automationId: string;
  /** UIA BoundingRectangle（屏幕物理像素） */
  rect: { x: number; y: number; width: number; height: number };
  enabled: boolean;
  offscreen: boolean;
}

export interface NativeUiaResult {
  nodes: NativeUiaNode[];
  truncated: boolean;
}

export interface NativeUiaOptions {
  maxNodes?: number;
  maxDepth?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_NODES = 200;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 1_000;
const CACHE_MAX = 50;

/** 可交互控件类型（自绘界面里名字为空但可点击的元素也要保留） */
const INTERACTIVE_CONTROL_TYPES = new Set([
  'Button',
  'Edit',
  'ComboBox',
  'ListItem',
  'MenuItem',
  'TabItem',
  'CheckBox',
  'RadioButton',
  'Hyperlink',
  'Text',
  'Slider',
  'TreeItem',
  'SplitButton',
]);

/** 是否为可交互控件类型 */
export function isInteractiveControlType(controlType: string): boolean {
  return INTERACTIVE_CONTROL_TYPES.has(controlType);
}

/** hwnd → 最近一次结果（1s 内复用，避免连续观察重复起 PowerShell） */
const cache = new Map<number, { at: number; result: NativeUiaResult | null }>();

/** PowerShell 可执行文件路径；非 Windows 返回 null */
function powershellPath(): string | null {
  if (process.platform !== 'win32') return null;
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  const exe = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(exe) ? exe : null;
}

/**
 * 生成 UIA 遍历脚本。
 * 输出每行为 base64(UTF-8(TSV))，避免 PowerShell 5.1 控制台编码影响中文名称。
 */
function buildScript(hwnd: number, maxNodes: number, maxDepth: number, view: 'control' | 'raw'): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$hwnd = [IntPtr][Int64]${hwnd}
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
if ($null -eq $root) { exit 3 }
$walker = if ('${view}' -eq 'raw') {
  [System.Windows.Automation.TreeWalker]::RawViewWalker
} else {
  [System.Windows.Automation.TreeWalker]::ControlViewWalker
}
$stack = New-Object System.Collections.Stack
$stack.Push(@($root, 0))
$count = 0
$lines = New-Object System.Collections.Generic.List[string]
while ($stack.Count -gt 0 -and $count -lt ${maxNodes}) {
  $item = $stack.Pop()
  $el = $item[0]
  $depth = [int]$item[1]
  try {
    $cur = $el.Current
    $name = $cur.Name
    if ($null -eq $name) { $name = '' }
    $name = ($name -replace "[\`t\`r\`n]", ' ')
    $aid = $cur.AutomationId
    if ($null -eq $aid) { $aid = '' }
    $aid = ($aid -replace "[\`t\`r\`n]", ' ')
    $ct = ($cur.ControlType.ProgrammaticName -replace '^ControlType\\.', '')
    $r = $cur.BoundingRectangle
    $en = [int]$cur.IsEnabled
    $off = [int]$cur.IsOffscreen
    $line = "$depth\`t$ct\`t$name\`t$aid\`t$([int]$r.X)\`t$([int]$r.Y)\`t$([int]$r.Width)\`t$([int]$r.Height)\`t$en\`t$off"
    $lines.Add([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line)))
  } catch {
    # 单个元素不可读（元素已失效/提供程序异常）：跳过，不影响其余节点
  }
  if ($depth -lt ${maxDepth}) {
    try {
      $child = $walker.GetLastChild($el)
      while ($null -ne $child) {
        $stack.Push(@($child, ($depth + 1)))
        $child = $walker.GetPreviousSibling($child)
      }
    } catch {
      # 子节点遍历失败：跳过该分支
    }
  }
  $count++
}
[Console]::Out.Write(($lines -join "\`n"))
`.trim();
}

function parseIntField(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** base64 TSV 行 → 节点 */
function parseLine(decoded: string): NativeUiaNode | null {
  const parts = decoded.split('\t');
  if (parts.length < 10) return null;
  const [depth, controlType, name, automationId, x, y, width, height, enabled, offscreen] = parts;
  return {
    depth: parseIntField(depth),
    controlType,
    name,
    automationId,
    rect: {
      x: parseIntField(x),
      y: parseIntField(y),
      width: parseIntField(width),
      height: parseIntField(height),
    },
    enabled: enabled === '1',
    offscreen: offscreen === '1',
  };
}

/** 运行一次脚本；失败/超时返回 null */
function runScript(
  exe: string,
  hwnd: number,
  opts: Required<NativeUiaOptions>,
  view: 'control' | 'raw',
): Promise<NativeUiaResult | null> {
  return new Promise(resolve => {
    const script = buildScript(hwnd, opts.maxNodes, opts.maxDepth, view);
    execFile(
      exe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Sta',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ],
      {
        windowsHide: true,
        timeout: opts.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const nodes: NativeUiaNode[] = [];
        for (const line of stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
            const node = parseLine(decoded);
            if (node) nodes.push(node);
          } catch {
            // 单行解析失败：跳过
          }
        }
        if (nodes.length === 0) {
          resolve(null);
          return;
        }
        resolve({ nodes, truncated: nodes.length >= opts.maxNodes });
      },
    );
  });
}

/**
 * 读取某个 HWND 的原生 UIA 树。
 * 先用 ControlView，读不到任何命名节点时用 RawView 重试一次；
 * 结果按 hwnd 缓存 1s。任何失败返回 null（不抛错）。
 */
export async function readNativeUia(
  hwnd: number,
  options: NativeUiaOptions = {},
): Promise<NativeUiaResult | null> {
  if (process.platform !== 'win32' || !Number.isFinite(hwnd) || hwnd <= 0) return null;
  const cached = cache.get(hwnd);
  if (cached && Date.now() - cached.at <= CACHE_TTL_MS) return cached.result;

  const exe = powershellPath();
  if (!exe) return null;
  const opts: Required<NativeUiaOptions> = {
    maxNodes: Math.max(1, Math.min(1_000, options.maxNodes ?? DEFAULT_MAX_NODES)),
    maxDepth: Math.max(1, Math.min(64, options.maxDepth ?? DEFAULT_MAX_DEPTH)),
    timeoutMs: Math.max(500, Math.min(30_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  };

  let result = await runScript(exe, hwnd, opts, 'control');
  const hasNamedInteractive =
    result?.nodes.some(
      node => node.name.trim().length > 0 && isInteractiveControlType(node.controlType),
    ) ?? false;
  if (!hasNamedInteractive) {
    const raw = await runScript(exe, hwnd, opts, 'raw');
    if (raw && (!result || raw.nodes.length > result.nodes.length)) result = raw;
  }

  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(hwnd, { at: Date.now(), result });
  return result;
}
