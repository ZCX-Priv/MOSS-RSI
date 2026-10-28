// tools/run_code/index.ts
// 代码模式（PTC + Intelligent UI）唯一入口工具。
//
// 两档呈现（config.agent.codeMode.presentation）：
//   - standard：wire 暴露全部原生工具 + run_code；模型可自由选择直接调用或写程序。
//   - ptc：wire 只暴露 run_code；其余工具通过程序内 tools.* 调用。
//
// 本工具负责：
//   1. 参数/长度/命名空间预检（早失败，不启动子进程）；
//   2. 生成可见工具 allowlist 与并发安全表；
//   3. 调用 runtime/host.ts（Bun 子进程 + JSON-RPC + 超时/中止/限额）；
//   4. 净化 UISpec、组装 ToolResult 与 metadata.codeRun（供 RunCodeCard/历史回放）。

import { ServiceNames, type ConfigService } from '../../../core/types';
import type { MCPManager, ToolRegistry } from '../../contracts';
import type { ToolContext, ToolResult } from '../types';
import { runCodeProgram, type CodeRunCallRecord } from './runtime/host';
import { truncateToBytes, type CodeFailureKind, type CodeValue } from './runtime/protocol';
import { validateUISpec } from './ui/validate';
import type { UIDiagnostic, UISpec } from './ui/spec';

interface RunCodeParams {
  code?: unknown;
  description?: unknown;
  timeoutMs?: unknown;
}

export interface CodeRunMetadata {
  version: 1;
  /** 输出类型：纯文本 / 界面 / 界面+工具混合 */
  kind: 'text' | 'ui' | 'hybrid';
  /** 本次请求的呈现档位 */
  presentation: 'standard' | 'ptc';
  description: string;
  logs: string[];
  calls: CodeRunCallRecord[];
  callsTruncated?: boolean;
  uiSpec?: UISpec;
  uiDiagnostics?: UIDiagnostic[];
  durationMs: number;
  truncated?: boolean;
}

const MAX_METADATA_BYTES = 384 * 1024;
const MAX_TEXT_RESULT_BYTES = 128 * 1024;

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = (params ?? {}) as RunCodeParams;
    const config = ctx.services.tryResolve<ConfigService>(ServiceNames.CONFIG_SERVICE);
    if (!config) return err('run_code 不可用：配置服务未注册');
    const codeMode = config.getAppConfig().agent.codeMode;
    if (!codeMode.enabled) {
      return err('代码模式未启用（config.agent.codeMode.enabled=false）。请在设置 → 工具 → 代码模式中开启。');
    }

    const code = typeof p.code === 'string' ? p.code : '';
    if (code.trim() === '') return err('参数 code 必须是非空的 TypeScript 异步函数体');
    if (code.length > codeMode.maxCodeChars) {
      return err(`程序源码长度 ${code.length} 超过上限 ${codeMode.maxCodeChars}（config.agent.codeMode.maxCodeChars）`);
    }
    const description =
      typeof p.description === 'string' && p.description.trim() !== ''
        ? p.description.trim().slice(0, 200)
        : '代码程序';

    // ---- 命名空间预检（advisory：早失败，避免无意义子进程启动） ----
    if (referencesNamespace(code, 'team')) {
      return err('程序引用了 team 命名空间，但 Agent Teams 编排尚未实现。请改用 tools.* 或原生 agent 工具。');
    }
    const usesUi = referencesNamespace(code, 'ui');
    if (usesUi && !codeMode.uiEnabled) {
      return err('程序引用了 ui 命名空间，但 Intelligent UI 已关闭（config.agent.codeMode.uiEnabled=false）。');
    }

    // ---- 可见工具与并发安全表 ----
    const registry = ctx.services.tryResolve<ToolRegistry>(ServiceNames.TOOL_REGISTRY);
    if (!registry) return err('run_code 不可用：工具注册表未注册');
    const mcpManager = ctx.services.tryResolve<MCPManager>(ServiceNames.MCP_MANAGER);

    const builtinTools = registry.listSchemas().filter((t) => t.name !== 'run_code');
    let mcpTools: Array<{
      name: string;
      description: string;
      inputSchema: unknown;
      annotations: Record<string, unknown> | undefined;
    }> = [];
    try {
      mcpTools = (mcpManager?.listTools() ?? []).map((t) => ({
        name: `mcp__${t.server}__${t.name}`,
        description: `[MCP:${t.server}] ${t.description ?? t.name}`,
        inputSchema: t.inputSchema,
        annotations: t.annotations as Record<string, unknown> | undefined,
      }));
    } catch (error) {
      ctx.logger.warn('run_code: list MCP tools failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const bindings = [...builtinTools.map((t) => t.name), ...mcpTools.map((t) => t.name)];

    const safe = new Map<string, boolean>();
    for (const t of builtinTools) {
      safe.set(t.name, t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true);
    }
    for (const t of mcpTools) {
      safe.set(t.name, t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true);
    }

    const invokeTool = ctx.invokeTool;
    if (!invokeTool) {
      return err('run_code 必须在 Agent 会话中执行（缺少嵌套工具调用通道 invokeTool）');
    }

    // ---- 执行预算 ----
    const requested =
      typeof p.timeoutMs === 'number' && Number.isFinite(p.timeoutMs) ? p.timeoutMs : codeMode.timeoutMs;
    const timeoutMs = Math.max(1_000, Math.min(600_000, Math.round(requested)));

    const hostResult = await runCodeProgram({
      program: code,
      bindings,
      cwd: ctx.cwd,
      limits: {
        timeoutMs,
        maxOutputBytes: codeMode.maxOutputBytes,
        maxCodeChars: codeMode.maxCodeChars,
        maxParallelSubCalls: codeMode.maxParallelSubCalls,
      },
      uiEnabled: codeMode.uiEnabled,
      signal: ctx.signal,
      invokeTool,
      isConcurrencySafe: (name) => safe.get(name) === true,
      logger: ctx.logger,
    });

    // ---- UI 净化 ----
    const builderDiagnostics = normalizeDiagnostics(hostResult.uiDiagnostics);
    const validation = hostResult.ui !== undefined ? validateUISpec(hostResult.ui) : { diagnostics: [], fatal: false };
    const uiDiagnostics = [...builderDiagnostics, ...validation.diagnostics];
    const uiSpec = validation.spec;

    const hostFailed = !!hostResult.error;
    const kind: CodeRunMetadata['kind'] =
      !hostFailed && uiSpec ? (hostResult.nestedCalls > 0 ? 'hybrid' : 'ui') : 'text';

    // ---- 文本结果 ----
    const text = formatResultText({
      kind,
      hostFailed,
      error: hostResult.error,
      value: hostResult.value,
      logs: hostResult.logs,
      uiDiagnostics,
      uiFatal: validation.fatal,
      durationMs: hostResult.durationMs,
      description,
    });

    // ---- metadata ----
    const metadata = capMetadata({
      version: 1,
      kind,
      presentation: codeMode.presentation,
      description,
      logs: hostResult.logs,
      calls: hostResult.calls,
      ...(hostResult.callsTruncated ? { callsTruncated: true } : {}),
      ...(uiSpec ? { uiSpec } : {}),
      ...(uiDiagnostics.length > 0 ? { uiDiagnostics } : {}),
      durationMs: hostResult.durationMs,
      ...(hostResult.truncated ? { truncated: true } : {}),
    });

    return {
      content: [{ type: 'text', text: truncateToBytes(text, MAX_TEXT_RESULT_BYTES) }],
      isError: hostFailed,
      metadata: { codeRun: metadata },
    };
  },
};

function err(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** 轻量命名空间引用扫描：`ui.` / `ui[` / `team.` / `team[`（只做早失败提示） */
function referencesNamespace(code: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*(?:\\.|\\[)`).test(code);
}

function normalizeDiagnostics(value: unknown): UIDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const out: UIDiagnostic[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;
    if (typeof d.code !== 'string' || typeof d.path !== 'string') continue;
    out.push({
      code: d.code,
      path: d.path,
      ...(typeof d.detail === 'string' ? { detail: d.detail } : {}),
      severity: d.severity === 'error' ? 'error' : 'warning',
    });
    if (out.length >= 100) break;
  }
  return out;
}

interface FormatInput {
  kind: CodeRunMetadata['kind'];
  hostFailed: boolean;
  error?: { kind: CodeFailureKind; message: string };
  value?: CodeValue;
  logs: string[];
  uiDiagnostics: UIDiagnostic[];
  uiFatal: boolean;
  durationMs: number;
  description: string;
}

function formatResultText(input: FormatInput): string {
  const parts: string[] = [];

  if (input.hostFailed) {
    const e = input.error;
    parts.push(`[run_code] 执行失败（${e?.kind ?? 'exception'}，${input.durationMs}ms）`);
    parts.push(e?.message ?? 'unknown error');
    if (e?.kind === 'timeout') {
      parts.push('程序已超过执行预算，子进程已被终止。可以拆分任务、减少嵌套调用或显式增大 timeoutMs。');
    }
    if (e?.kind === 'abort') {
      parts.push('程序被用户/父 run 中止。');
    }
    if (e?.kind === 'output-limit') {
      parts.push('返回值/日志超过输出上限。请裁剪返回值或减少 console 输出。');
    }
  } else {
    if (input.kind === 'ui') {
      parts.push(`已渲染交互界面：${input.description}`);
    } else if (input.kind === 'hybrid') {
      parts.push(`程序完成（${input.durationMs}ms），已渲染交互界面：${input.description}`);
    } else {
      parts.push(`程序完成（${input.durationMs}ms）`);
    }
    if (input.value !== undefined) {
      parts.push(`返回值：\n${formatValue(input.value)}`);
    }
    if (input.kind === 'text' && input.value === undefined && input.logs.length === 0) {
      parts.push('（无返回值、无日志）');
    }
  }

  if (input.uiFatal) {
    parts.push('界面规格校验失败，已回退为文本结果。');
  }
  if (input.uiDiagnostics.length > 0) {
    const shown = input.uiDiagnostics.slice(0, 8).map((d) => `${d.code} @ ${d.path}${d.detail ? `: ${d.detail}` : ''}`);
    parts.push(`[UI 诊断]\n${shown.join('\n')}${input.uiDiagnostics.length > 8 ? `\n… 共 ${input.uiDiagnostics.length} 条` : ''}`);
  }
  if (input.logs.length > 0) {
    parts.push(`--- 日志 ---\n${input.logs.join('\n')}`);
  }
  return parts.join('\n\n');
}

function formatValue(value: CodeValue): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** metadata 体积保护：先裁日志，再裁 calls 预览；uiSpec 保留（自身已 ≤256KB）。 */
function capMetadata(meta: CodeRunMetadata): CodeRunMetadata {
  const bytes = () => Buffer.byteLength(JSON.stringify(meta), 'utf8');
  if (bytes() <= MAX_METADATA_BYTES) return meta;

  let logs = meta.logs;
  while (logs.length > 1 && byteLengthOfObject({ ...meta, logs }) > MAX_METADATA_BYTES) {
    logs = logs.slice(0, Math.max(1, Math.floor(logs.length / 2)));
  }
  meta = { ...meta, logs, truncated: true };

  if (byteLengthOfObject(meta) > MAX_METADATA_BYTES) {
    meta = {
      ...meta,
      calls: meta.calls.slice(0, 20).map((c) => ({
        ...c,
        argsPreview: truncateToBytes(c.argsPreview, 120),
        resultPreview: truncateToBytes(c.resultPreview, 120),
        ...(c.error ? { error: truncateToBytes(c.error, 200) } : {}),
      })),
      callsTruncated: true,
    };
  }
  return meta;
}

function byteLengthOfObject(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
