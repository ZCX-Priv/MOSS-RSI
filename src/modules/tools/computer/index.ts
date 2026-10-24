// src/modules/tools/computer/index.ts
// computer 工具：把 cua-driver 的桌面观察/操作能力封装为 MOSS 单一 action 工具。
// 设计：观察 → 动作 → 验证；默认后台投递（不抢焦点/不移动真实鼠标）。
// 元数据见同目录 tool.json；cua 进程与截图由 computer 模块的 ComputerService 持有。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { t } from '../../../core/i18n';
import { ServiceNames } from '../../../core/types';
import type { ComputerService, ComputerToolResult } from '../../contracts';
import type { ToolContext, ToolResult, ToolResultContent } from '../types';
import { errorResult, textResult } from '../types';
import {
  buildCuaCall,
  describeTarget,
  needsScreenshot,
  summarizeAction,
  type ComputerParams,
} from './actions';

/** 等待上限（与 tool.json 描述保持一致） */
const WAIT_MAX_MS = 10_000;
/** 单张内联截图上限（超过只保留路径） */
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pickString(obj: unknown, key: string): string | undefined {
  if (!isObject(obj)) return undefined;
  const value = obj[key];
  return typeof value === 'string' && value ? value : undefined;
}

function pickBoolean(obj: unknown, key: string): boolean | undefined {
  if (!isObject(obj)) return undefined;
  const value = obj[key];
  return typeof value === 'boolean' ? value : undefined;
}

function numberConfig(config: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const value = config?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 可中断的等待 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 本地 status 文本（不依赖 cua 连接是否成功） */
function statusText(service: ComputerService): string {
  const status = service.getStatus();
  return [
    t('tools.computerStatusHeader'),
    `installed: ${status.installed}`,
    `driver: ${status.driverPath ?? '—'}`,
    `version: ${status.version ?? '—'}`,
    `connection: ${status.connection}`,
    `tools: ${status.toolCount}`,
    `screen: ${status.screen ? `${status.screen.width}x${status.screen.height}` : '—'}`,
    `paused: ${status.paused}`,
    `maxImageDimension: ${status.config.maxImageDimension}`,
    `allowForeground: ${status.config.allowForeground}`,
    ...(status.error ? [`error: ${status.error}`] : []),
  ].join('\n');
}

/** cua 结果 → MOSS ToolResult（文本 + 截图 image content + 元信息） */
function formatResult(
  result: ComputerToolResult,
  meta: { action: string; tool: string; screenshotPath?: string },
): ToolResult {
  const images = [...result.images];
  const screenshotPath = meta.screenshotPath;

  if (screenshotPath && existsSync(screenshotPath)) {
    try {
      const st = statSync(screenshotPath);
      if (st.isFile() && st.size > 0 && !images.some(img => img.path === screenshotPath)) {
        if (st.size <= MAX_INLINE_IMAGE_BYTES) {
          const buf = readFileSync(screenshotPath);
          images.push({ data: buf.toString('base64'), mimeType: 'image/png', path: screenshotPath });
        }
      }
    } catch {
      // 截图读取失败不阻断文本结果
    }
  }

  const textParts: string[] = [];
  if (result.text.trim()) textParts.push(result.text);
  if (screenshotPath && existsSync(screenshotPath)) textParts.push(`截图：${screenshotPath}`);
  if (textParts.length === 0 && images.length === 0) {
    textParts.push(t('tools.computerActionDone', { action: meta.action }));
  }

  const content: ToolResultContent[] = [];
  if (textParts.length > 0) {
    content.push({ type: 'text', text: textParts.join('\n') });
  }
  for (const image of images) {
    content.push({
      type: 'image',
      source: { data: image.data, mimeType: image.mimeType },
      path: image.path,
    });
  }

  const effect = pickString(result.structured, 'effect');
  const verified = pickBoolean(result.structured, 'verified');
  // cua 对「投递了但未生效」通常返回 effect=suspected_noop（isError 仍为 false）；
  // 对 MOSS 来说这应视为失败，避免模型把 no-op 当成成功继续往下走。
  const isError =
    result.isError === true || effect === 'suspected_noop' || effect === 'refused';
  return {
    content,
    isError,
    metadata: {
      action: meta.action,
      tool: meta.tool,
      ...(screenshotPath && existsSync(screenshotPath) ? { screenshotPath } : {}),
      ...(effect ? { effect } : {}),
      ...(verified !== undefined ? { verified } : {}),
    },
  };
}

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = params as ComputerParams;
    if (!p || typeof p.action !== 'string') {
      return errorResult('action is required');
    }

    const service = ctx.services.tryResolve<ComputerService>(ServiceNames.COMPUTER);
    if (!service) {
      return errorResult(t('tools.computerServiceUnavailable'));
    }

    // 状态查询不需要连接，未安装时也能给出可操作信息
    if (p.action === 'status') {
      return textResult(statusText(service));
    }

    if (service.isPaused()) {
      return errorResult(t('tools.computerPaused'));
    }

    // 本地等待：不经过 cua（用于等待窗口出现/动画结束）
    if (p.action === 'wait') {
      const requested = typeof p.wait_ms === 'number' ? p.wait_ms : 1000;
      if (requested < 0 || requested > WAIT_MAX_MS) {
        return errorResult(t('tools.computerWaitTooLong'));
      }
      try {
        await delay(requested, ctx.signal);
        return textResult(t('tools.computerActionDone', { action: `wait ${requested}ms` }));
      } catch {
        return errorResult('aborted');
      }
    }

    try {
      await service.ensureConnected();

      const screenshotPath = needsScreenshot(p)
        ? service.createScreenshotPath(p.action, p.pid, p.window_id)
        : undefined;

      const { tool, args } = buildCuaCall(p, {
        service,
        toolConfig: ctx.toolConfig ?? {},
        screenshotPath,
      });

      const timeoutMs = Math.max(
        5_000,
        Math.min(300_000, numberConfig(ctx.toolConfig, 'timeout', 120_000)),
      );

      const result = await service.callTool(tool, args, {
        sessionId: ctx.sessionId,
        action: p.action,
        summary: summarizeAction(p),
        target: describeTarget(p),
        screenshotPath,
        source: 'agent',
        timeoutMs,
        signal: ctx.signal,
      });

      return formatResult(result, { action: p.action, tool, screenshotPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(t('tools.computerActionFailed', { message }));
    }
  },
};
