// webui/src/hooks/useInsightStream.ts
// AI 诊断流式订阅 hook：发一次 insight.diagnose 请求，聚合该 requestId 的 step/thinking/text 事件。
// 每次 kind 对应一次独立生成（cause / harness / resource 互不影响）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { wsClient } from '@/api/ws';
import { onInsightEvent } from '@/lib/insight-bus';
import type { InsightKind, InsightStep } from '@/types/api';

export type InsightStatus = 'idle' | 'running' | 'done' | 'error';

export interface InsightStreamState {
  steps: InsightStep[];
  thinking: string;
  text: string;
  status: InsightStatus;
  error: string | null;
}

function genRequestId(): string {
  return `ins_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function useInsightStream(opts: {
  kind: InsightKind;
  /** true 时自动发起（弹窗打开）；false/卸载时取消后台流 */
  active: boolean;
  sessionId?: string;
  providerError?: string;
}): InsightStreamState & { rerun: () => void } {
  const { kind, active, sessionId, providerError } = opts;
  const [steps, setSteps] = useState<InsightStep[]>([]);
  const [thinking, setThinking] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<InsightStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef<string>('');

  const run = useCallback(() => {
    const requestId = genRequestId();
    requestIdRef.current = requestId;
    setSteps([]);
    setThinking('');
    setText('');
    setError(null);
    setStatus('running');
    wsClient.send({
      type: 'insight.diagnose',
      ...(sessionId ? { sessionId } : {}),
      payload: {
        requestId,
        kind,
        ...(sessionId ? { sessionId } : {}),
        ...(providerError ? { providerError } : {}),
      },
    });
  }, [kind, sessionId, providerError]);

  // 订阅诊断事件：仅处理本 hook 当前 requestId 的事件
  useEffect(() => {
    return onInsightEvent((e) => {
      if (e.requestId !== requestIdRef.current || e.kind !== kind) return;
      if (e.phase === 'step' && e.step) {
        const step = e.step;
        setSteps((prev) => {
          const idx = prev.findIndex((s) => s.id === step.id);
          if (idx < 0) return [...prev, step];
          const next = prev.slice();
          next[idx] = step;
          return next;
        });
      } else if (e.phase === 'thinking' && e.text) {
        setThinking((t) => t + e.text);
      } else if (e.phase === 'text' && e.text) {
        setText((t) => t + e.text);
      } else if (e.phase === 'done') {
        setStatus('done');
      } else if (e.phase === 'error') {
        setStatus('error');
        setError(e.message ?? 'unknown error');
      }
    });
  }, [kind]);

  // active=true 自动发起；变为 false 或卸载时取消后台流
  useEffect(() => {
    if (!active) return;
    run();
    return () => {
      if (requestIdRef.current) {
        wsClient.send({ type: 'insight.diagnose.cancel', payload: { requestId: requestIdRef.current } });
        requestIdRef.current = '';
      }
    };
    // 仅依赖 active：providerError 在一次打开期间固定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return { steps, thinking, text, status, error, rerun: run };
}
