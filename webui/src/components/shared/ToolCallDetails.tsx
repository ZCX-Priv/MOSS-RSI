// webui/src/components/shared/ToolCallDetails.tsx
// 工具调用折叠行（主对话与子代理执行过程共用，保证图标/交互/样式一致）。
//
// 摘要行：展开箭头 + 状态/工具图标 + 工具名
//   - generating/executing → 转圈；结果错误 → 红色 Alert；其余 → 工具自定义图标（未知回退 Wrench）
// 展开面板：参数（JSON 美化）、结果文本、MCP structuredContent、resources 引用。

import { useTranslation } from 'react-i18next';
import { ChevronRight, CircleAlert, FileText, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { resolveToolIcon } from '@/lib/tool-icons';
import type { ToolCall, ToolResult } from '../../types/api';

interface ToolCallDetailsProps {
  toolCall: ToolCall;
  /** 就近匹配到的完整结果（含 metadata：structuredContent / resources） */
  result?: ToolResult;
  /** 全局结果索引兜底（结果消息不紧邻调用消息时，只有文本与错误标记） */
  fallbackText?: string;
  fallbackIsError?: boolean;
  /** 工具名 → 图标白名单键（store.toolIconMap） */
  iconMap: Record<string, string>;
}

export function ToolCallDetails({
  toolCall,
  result,
  fallbackText,
  fallbackIsError,
  iconMap,
}: ToolCallDetailsProps) {
  const { t } = useTranslation();

  // 结果文本/错误标记：就近结果优先，全局索引兜底
  const resultText = result
    ? result.content
        .filter((c) => c.type === 'text')
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('\n')
    : fallbackText;
  const isError = result?.isError ?? fallbackIsError;
  // MCP 扩展：structuredContent（结构化输出）/ resources（资源引用）
  const structured = result?.metadata?.structuredContent;
  const resources = result?.metadata?.resources;

  let prettyArgs = toolCall.arguments;
  try {
    prettyArgs = JSON.stringify(JSON.parse(toolCall.arguments || '{}'), null, 2);
  } catch {
    // 非 JSON，原样显示
  }

  return (
    <details className="group px-2 py-0.5">
      <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
        {toolCall.status === 'generating' || toolCall.status === 'executing' ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : isError ? (
          <CircleAlert className="size-3.5 text-destructive" />
        ) : (
          (() => {
            const ToolIcon = resolveToolIcon(toolCall.name, iconMap);
            return <ToolIcon className="size-3.5" />;
          })()
        )}
        <span>{toolCall.name}</span>
      </summary>
      <div className="mt-1 flex flex-col gap-2 rounded-md border border-border p-2 text-xs max-h-[300px] overflow-auto no-scrollbar">
        {toolCall.arguments && (
          <div>
            <div className="text-muted-foreground/70">{t('task.toolCallArguments')}</div>
            <pre className="mono mt-0.5 whitespace-pre-wrap break-all text-foreground">
              {prettyArgs}
            </pre>
          </div>
        )}
        {resultText && (
          <div>
            <div className={cn('text-muted-foreground/70', isError && 'text-destructive/80')}>
              {isError ? t('task.errorResult') : t('task.result')}
            </div>
            <pre
              className={cn(
                'mono mt-0.5 whitespace-pre-wrap break-all',
                isError ? 'text-destructive' : 'text-foreground',
              )}
            >
              {resultText}
            </pre>
          </div>
        )}
        {/* MCP structuredContent：结构化输出 JSON */}
        {structured && (
          <div>
            <div className="text-muted-foreground/70">{t('task.structuredOutput')}</div>
            <pre className="mono mt-0.5 whitespace-pre-wrap break-all text-foreground">
              {JSON.stringify(structured, null, 2)}
            </pre>
          </div>
        )}
        {/* MCP resources：资源引用卡片（uri + mimeType + 可展开 text） */}
        {resources && resources.length > 0 && (
          <div>
            <div className="text-muted-foreground/70">
              {t('task.resourceRefs', { count: resources.length })}
            </div>
            <div className="mt-0.5 flex flex-col gap-1">
              {resources.map((r) => (
                <details key={r.uri} className="group/res rounded border border-border px-1.5 py-1">
                  <summary className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
                    <ChevronRight className="size-3 transition-transform group-open/res:rotate-90" />
                    <FileText className="size-3 shrink-0" />
                    <span className="truncate">{r.uri}</span>
                    {r.mimeType && (
                      <span className="ml-auto shrink-0 rounded bg-muted px-1 py-px text-[10px]">
                        {r.mimeType}
                      </span>
                    )}
                  </summary>
                  {r.text && (
                    <pre className="mono mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-foreground">
                      {r.text}
                    </pre>
                  )}
                </details>
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
