// tools/run_code/index.ts
// 代码模式（PTC + Intelligent UI）唯一入口工具。
//
// wire 始终为混合模式：原生工具 + run_code；提示词主推并行/多步任务使用 PTC。
//
// 本工具负责：
//   1. 参数/长度/命名空间预检（早失败，不启动子进程）；
//   2. 生成可见工具 allowlist 与并发安全表；
//   3. 调用 runtime/host.ts（Bun 子进程 + JSON-RPC + 超时/中止/限额）；
//   4. 净化 UISpec、组装 ToolResult 与 metadata.codeRun（供 RunCodeCard/历史回放）。
//
// 硬限制：程序内禁止调用 ask / agent / todo；这三项不会注入子进程 tools，访问即报错。

import { ServiceNames, type ConfigService } from '../../../core/types';
import type { MCPManager, ToolRegistry } from '../../contracts';
import type { ToolContext, ToolResult } from '../types';
import { isPtcForbiddenTool } from './forbidden';
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
  description: string;
  logs: string[];
  calls: CodeRunCallRecord[];
  callsTruncated?: boolean;
  uiSpec?: UISpec;
  uiDiagnostics?: UIDiagnostic[];
  /** 返回值预览（裁剪后的文本，供结果区展示；完整值仍在工具结果正文里） */
  valuePreview?: string;
  durationMs: number;
  truncated?: boolean;
}

const MAX_METADATA_BYTES = 384 * 1024;

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
      return err(
        '程序引用了 team 命名空间，但 Agent Teams 编排尚未实现。请改用 tools.*；子代理请在主流程直接调用原生 agent 工具。',
      );
    }
    const usesUi = referencesNamespace(code, 'ui');
    if (usesUi && !codeMode.uiEnabled) {
      return err('程序引用了 ui 命名空间，但 Intelligent UI 已关闭（config.agent.codeMode.uiEnabled=false）。');
    }

    // ---- 可见工具与并发安全表 ----
    const registry = ctx.services.tryResolve<ToolRegistry>(ServiceNames.TOOL_REGISTRY);
    if (!registry) return err('run_code 不可用：工具注册表未注册');
    const mcpManager = ctx.services.tryResolve<MCPManager>(ServiceNames.MCP_MANAGER);

    const builtinTools = registry
      .listSchemas()
      .filter((t) => t.name !== 'run_code' && !isPtcForbiddenTool(t.name));
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
      valueWarnings: hostResult.valueWarnings,
      logs: hostResult.logs,
      uiDiagnostics,
      uiFatal: validation.fatal,
      durationMs: hostResult.durationMs,
      description,
    });

    // ---- metadata ----
    const valuePreview =
      !hostFailed && hostResult.value !== undefined
        ? truncateToBytes(formatValue(hostResult.value), 2000)
        : undefined;
    const metadata = capMetadata({
      version: 1,
      kind,
      description,
      logs: hostResult.logs,
      calls: hostResult.calls,
      ...(hostResult.callsTruncated ? { callsTruncated: true } : {}),
      ...(uiSpec ? { uiSpec } : {}),
      ...(uiDiagnostics.length > 0 ? { uiDiagnostics } : {}),
      ...(valuePreview ? { valuePreview } : {}),
      durationMs: hostResult.durationMs,
      ...(hostResult.truncated ? { truncated: true } : {}),
    });

    return {
      content: [{ type: 'text', text }],
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
  valueWarnings?: Array<{ path: string; reason: string }>;
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
    if (e?.kind === 'syntax') {
      parts.push('这是代码结构/语法问题：按上面的行号只修改对应语句，不要在未定位前整段重写。');
    }
    if (e?.kind === 'output-limit') {
      parts.push(
        '返回值超过协议帧硬上限（64MB，仅崩溃保护，不是输出预算）。请只返回必要字段，或先在程序内聚合/裁剪。',
      );
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
  if (input.valueWarnings && input.valueWarnings.length > 0) {
    const shown = input.valueWarnings
      .slice(0, 8)
      .map((warning) => `${warning.path}: ${warning.reason}`);
    parts.push(
      `[返回值净化]\n${shown.join('\n')}${
        input.valueWarnings.length > 8 ? `\n… 共 ${input.valueWarnings.length} 条` : ''
      }`,
    );
  }
  if (input.logs.length > 0) {
    parts.push(`--- 日志 ---\n${input.logs.join('\n')}`);
  }
  return parts.join('\n\n');
}

function formatValue(value: CodeValue): string {
  if (typeof value === 'string') return value;
  try {
    const pretty = JSON.stringify(value, null, 2);
    if (pretty.length <= 65_536) return pretty;
    // 大结果用紧凑 JSON：避免 pretty-print 的空白把上下文再撑大一圈
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** metadata 里最多保留的日志字节数（仅 UI 展示；正文里的日志不受此限制） */
const MAX_METADATA_LOG_BYTES = 128 * 1024;

/** 按字节预算裁日志（避免对超大日志反复 JSON.stringify） */
function trimLogsForMetadata(logs: string[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of logs) {
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    if (used + bytes <= MAX_METADATA_LOG_BYTES) {
      out.push(line);
      used += bytes;
      continue;
    }
    const remain = MAX_METADATA_LOG_BYTES - used;
    if (remain > 0) {
      out.push(`${truncateToBytes(line, remain)}\n…（metadata 日志已裁剪）`);
    }
    break;
  }
  return out;
}

/** metadata 体积保护：先裁日志，再裁 calls 预览；uiSpec 保留（自身已 ≤256KB）。 */
function capMetadata(meta: CodeRunMetadata): CodeRunMetadata {
  const bytes = () => Buffer.byteLength(JSON.stringify(meta), 'utf8');
  if (bytes() <= MAX_METADATA_BYTES) return meta;

  const logs = trimLogsForMetadata(meta.logs);
  meta = { ...meta, logs, truncated: true };

  if (byteLengthOfObject(meta) > MAX_METADATA_BYTES) {
    meta = {
      ...meta,
      calls: meta.calls.slice(0, 20).map((c) => ({
        id: c.id,
        name: c.name,
        argsPreview: truncateToBytes(c.argsPreview, 120),
        resultPreview: truncateToBytes(c.resultPreview, 120),
        durationMs: c.durationMs,
        ok: c.ok,
        ...(c.error ? { error: truncateToBytes(c.error, 200) } : {}),
        // 富数据同步裁剪；resultMetadata 直接丢弃（超大 diff 等不再撑爆 transcript）
        ...(c.argumentsJson ? { argumentsJson: truncateToBytes(c.argumentsJson, 2048) } : {}),
        ...(c.resultText ? { resultText: truncateToBytes(c.resultText, 2048) } : {}),
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
