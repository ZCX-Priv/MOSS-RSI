// src/modules/server/insight-diagnose.ts
// WS 流式 AI 诊断通道（链路式）：
//  - kind='cause'   ：错误原因与解决方案（独立生成）
//  - kind='harness' ：Harness 可优化点（独立生成）
//  - kind='resource'：系统资源利用解读
//
// 事件序列（前端按 requestId 订阅）：
//   phase='step' 取证步骤（running→done/error，含「读取了什么数据」的明细）
//   phase='step' kind='model-analysis'（模型分析步骤）
//   phase='thinking' / 'text'（模型流式产出）
//   phase='done' / 'error'
// 输出为纯 Markdown 流式文本（前端 MarkdownRenderer streaming 渲染）。

import type { ConfigService, Environment, Logger, LogService, ServiceRegistry } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { AgentEngine, AgentMessage, LLMRouter } from '../contracts';
import { loadPromptFileOrNull } from '../context/prompt-loader';
import { sampleResourceSnapshot, type ResourceSnapshot } from './routes/system-monitor';

export type InsightKind = 'cause' | 'harness' | 'resource';

export interface InsightStep {
  id: string;
  /** 步骤类型（前端据此前缀做 i18n：insight.step.<kind>） */
  kind: string;
  /** 已读取/产出的数据摘要（数字为主，语言无关） */
  detail: string;
  status: 'running' | 'done' | 'error';
}

export interface InsightEvent {
  requestId: string;
  kind: InsightKind;
  phase: 'step' | 'thinking' | 'text' | 'done' | 'error';
  step?: InsightStep;
  text?: string;
  message?: string;
}

export interface InsightRequest {
  requestId: string;
  kind: InsightKind;
  sessionId?: string;
  providerError?: string;
}

export interface InsightDeps {
  services: ServiceRegistry;
  env: Environment;
  logger: Logger;
}

const CHAIN_MAX_MESSAGES = 30;
const CHAIN_CONTENT_MAX = 400;

type Emit = (e: InsightEvent) => void;

function emitStep(
  emit: Emit,
  requestId: string,
  kind: InsightKind,
  id: string,
  stepKind: string,
  status: InsightStep['status'],
  detail: string,
): void {
  emit({ requestId, kind, phase: 'step', step: { id, kind: stepKind, detail, status } });
}

/** 会话历史 → 任务流链路文本（最近 N 条，内容截断） */
function buildTaskFlowChain(history: AgentMessage[]): string {
  const recent = history.slice(-CHAIN_MAX_MESSAGES);
  const base = history.length - recent.length;
  const lines: string[] = [];
  for (let i = 0; i < recent.length; i++) {
    const m = recent[i];
    const tc =
      m.toolCalls && m.toolCalls.length > 0
        ? ` toolCalls=[${m.toolCalls.map((t) => t.name).join(', ')}]`
        : m.toolCallId
          ? ` toolCallId=${m.toolCallId}`
          : '';
    const isErr = m.isError ? ' [ERROR]' : '';
    const content = m.content.length > CHAIN_CONTENT_MAX ? `${m.content.slice(0, CHAIN_CONTENT_MAX)}…` : m.content;
    lines.push(`${base + i + 1}. ${m.role}${m.name ? `(${m.name})` : ''}${tc}${isErr} | ${content}`);
  }
  return lines.join('\n');
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

/** 资源快照 → 语言无关摘要（供模型 prompt 与步骤明细） */
function snapshotDigest(s: ResourceSnapshot): string {
  const topProcs = [...s.moss.processes]
    .sort((a, b) => b.rssBytes - a.rssBytes)
    .slice(0, 12)
    .map((p) => `  - pid=${p.pid} ${p.name} [${p.group}] cpu=${p.cpuPercent}% rss=${mb(p.rssBytes)}`);
  const cats = s.disk.categories.map((c) => `  - ${c.key}: ${mb(c.bytes)}`);
  const nets = s.network.interfaces.map(
    (i) => `  - ${i.name}${i.address ? ` (${i.address})` : ''} ↓${Math.round(i.rxRate / 1024)}KB/s ↑${Math.round(i.txRate / 1024)}KB/s`,
  );
  const mossBytes = s.moss.processes.filter((p) => p.isMoss).reduce((sum, p) => sum + p.rssBytes, 0);
  return [
    `CPU: ${s.cpu.usagePercent}% (${s.cpu.cores} cores, ${s.cpu.model}); MOSS tree ${s.cpu.mossPercent}%`,
    `Memory: used ${mb(s.memory.usedBytes)} / total ${mb(s.memory.totalBytes)} (${s.memory.usedPercent}%); MOSS tree ${mb(s.memory.mossBytes)}`,
    `Disk: ${s.disk.drive} used ${s.disk.usedPercent}% (free ${mb(s.disk.freeBytes)} / total ${mb(s.disk.totalBytes)})`,
    'MOSS data categories:',
    ...(cats.length > 0 ? cats : ['  - (none)']),
    `MOSS processes (${s.moss.processes.filter((p) => p.isMoss).length}, server pid=${s.moss.pid}, rss sum ${mb(mossBytes)}):`,
    ...(topProcs.length > 0 ? topProcs : ['  - (none)']),
    'Network:',
    ...(nets.length > 0 ? nets : ['  - (none)']),
  ].join('\n');
}

/** 诊断提示词文件路径（agent/prompts/insight/<kind>.md） */
const INSIGHT_PROMPT_PATHS: Record<InsightKind, string> = {
  cause: 'insight/cause.md',
  harness: 'insight/harness.md',
  resource: 'insight/resource.md',
};

/**
 * 执行一次诊断：先做取证步骤（emit step），再流式产出模型结论。
 * 任何异常均以 phase='error' 结束；signal.aborted 时静默返回。
 */
export async function runInsightDiagnose(
  deps: InsightDeps,
  req: InsightRequest,
  emit: Emit,
  signal: AbortSignal,
): Promise<void> {
  const { services } = deps;
  const { requestId, kind } = req;

  const router = services.tryResolve<LLMRouter>(ServiceNames.LLM_ROUTER);
  if (!router) {
    emit({ requestId, kind, phase: 'error', message: 'LLM router unavailable' });
    return;
  }
  const config = services.tryResolve<ConfigService>(ServiceNames.CONFIG_SERVICE);
  const model = config?.getAppConfig?.().agent.defaultModel ?? '';
  if (!model) {
    emit({ requestId, kind, phase: 'error', message: 'default model is not configured' });
    return;
  }

  try {
    // ===== 取证链 =====
    let evidence = '';
    if (kind === 'resource') {
      emitStep(emit, requestId, kind, 'snapshot', 'snapshot', 'running', '');
      let digest = '(snapshot unavailable)';
      try {
        const snap = await sampleResourceSnapshot(deps.env);
        digest = snapshotDigest(snap);
        emitStep(
          emit,
          requestId,
          kind,
          'snapshot',
          'snapshot',
          'done',
          `CPU ${snap.cpu.usagePercent}% / MEM ${snap.memory.usedPercent}% / DISK ${snap.disk.usedPercent}%`,
        );
        const mossProcs = snap.moss.processes.filter((p) => p.isMoss);
        const rss = mossProcs.reduce((s, p) => s + p.rssBytes, 0);
        emitStep(
          emit,
          requestId,
          kind,
          'moss-processes',
          'mossProcesses',
          'done',
          `${mossProcs.length} procs / ${mb(rss)}`,
        );
      } catch (err) {
        deps.logger.warn('insight: resource snapshot failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        emitStep(emit, requestId, kind, 'snapshot', 'snapshot', 'error', '');
      }
      evidence = digest;
    } else {
      // 1) 会话任务流链路
      emitStep(emit, requestId, kind, 'session-flow', 'sessionFlow', 'running', '');
      let chain = '（无会话链路）';
      try {
        const engine = services.tryResolve<AgentEngine & { getHistory?: (id: string) => AgentMessage[] }>('agent.engine');
        if (req.sessionId && engine?.getHistory) {
          const history = engine.getHistory(req.sessionId);
          chain = buildTaskFlowChain(history);
          emitStep(
            emit,
            requestId,
            kind,
            'session-flow',
            'sessionFlow',
            'done',
            `${history.length} msgs / ${chain.length} chars`,
          );
        } else {
          emitStep(emit, requestId, kind, 'session-flow', 'sessionFlow', 'done', '0 msgs');
        }
      } catch (err) {
        deps.logger.warn('insight: session flow read failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        emitStep(emit, requestId, kind, 'session-flow', 'sessionFlow', 'error', '');
      }
      // 2) 相关日志
      emitStep(emit, requestId, kind, 'logs', 'logs', 'running', '');
      let logs = '（无相关日志）';
      try {
        const logService = services.tryResolve<LogService>(ServiceNames.LOGGER);
        if (logService && req.sessionId) {
          const res = logService.readLogs({ search: req.sessionId, limit: 20 });
          logs = res.lines.length > 0 ? res.lines.join('\n') : logs;
          emitStep(emit, requestId, kind, 'logs', 'logs', 'done', `${res.lines.length} lines`);
        } else {
          emitStep(emit, requestId, kind, 'logs', 'logs', 'done', '0 lines');
        }
      } catch (err) {
        deps.logger.warn('insight: log read failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        emitStep(emit, requestId, kind, 'logs', 'logs', 'error', '');
      }
      evidence = [`【任务流链路】`, chain, '', `【相关日志】`, logs].join('\n');
    }

    if (signal.aborted) return;

    // ===== 模型分析（流式） =====
    // 诊断提示词从 agent/prompts/insight/<kind>.md 加载；缺失则直接报错结束（降级）
    const system = loadPromptFileOrNull(deps.env, INSIGHT_PROMPT_PATHS[kind]);
    if (!system) {
      emit({ requestId, kind, phase: 'error', message: 'insight prompt missing' });
      return;
    }
    emitStep(emit, requestId, kind, 'model-analysis', 'modelAnalysis', 'running', '');
    const user =
      kind === 'resource'
        ? evidence
        : req.providerError
          ? [`【原始错误】`, req.providerError, '', evidence].join('\n')
          : evidence;

    for await (const delta of router.stream(
      {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: true,
      },
      signal,
    )) {
      if (signal.aborted) return;
      if (delta.type === 'text') {
        emit({ requestId, kind, phase: 'text', text: delta.text });
      } else if (delta.type === 'thinking') {
        emit({ requestId, kind, phase: 'thinking', text: delta.text });
      } else if (delta.type === 'error') {
        emit({ requestId, kind, phase: 'error', message: delta.message });
        return;
      }
    }
    emitStep(emit, requestId, kind, 'model-analysis', 'modelAnalysis', 'done', '');
    emit({ requestId, kind, phase: 'done' });
  } catch (err) {
    if (signal.aborted) return;
    emit({
      requestId,
      kind,
      phase: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
