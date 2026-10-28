// webui/src/render/genui/catalog.tsx
// Intelligent UI 组件目录（与后端 catalog.ts 同名集合）。
// 所有组件使用现有 shadcn/radix 与 React；不引入任意 HTML/CSS/JS。
// 组件只通过 ctx 读状态/解析绑定/触发本地动作；不访问模型或网络。

import { lazy } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MarkdownRenderer } from '../markdown/MarkdownRenderer';
import type { GenUIComponentProps, GenUIComponent } from './context';
import type { GenUIPropValue, GenUIStateValue } from './types';

/** 图表懒加载（首屏不引入 echarts） */
const GenUIChart = lazy(() => import('./components/Chart'));

const TONE_BADGE: Record<string, string> = {
  success: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  warning: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  danger: 'bg-red-500/15 text-red-600 dark:text-red-400',
  info: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  primary: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  muted: 'bg-muted text-muted-foreground',
  default: 'bg-muted text-foreground',
};

const TONE_TEXT: Record<string, string> = {
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
  info: 'text-sky-600 dark:text-sky-400',
  primary: 'text-blue-600 dark:text-blue-400',
  muted: 'text-muted-foreground',
  default: 'text-foreground',
};

const CALL_OUT: Record<string, string> = {
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  danger: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
};

function toneOf(node: GenUIComponentProps['node']): string {
  return node.props?.tone as string;
}

/** 通用文本容器：把 children 拍平成字符串（含绑定求值 + 内联 Badge/Text 子节点） */
function TextContent({ node, ctx, children }: { node: GenUIComponentProps['node']; ctx: GenUIComponentProps['ctx']; children?: ReactNode }) {
  if (children) return <>{children}</>;
  return <>{renderTextChildren(node.children ?? [], ctx)}</>;
}

function renderTextChildren(
  children: GenUINodeChildren,
  ctx: GenUIComponentProps['ctx'],
): ReactNode[] {
  return (children ?? []).map((child, index) => {
    if (typeof child === 'string') return <span key={index}>{child}</span>;
    if (child && typeof child === 'object' && 'type' in child && typeof child.type === 'string') {
      const Comp = COMPONENTS[child.type];
      if (Comp) return <Comp key={index} node={child} ctx={ctx} renderChildren={() => null} />;
      return <span key={index}>{ctx.resolveText(child)}</span>;
    }
    if (child && typeof child === 'object') {
      return <span key={index}>{ctx.resolveText(child)}</span>;
    }
    return <span key={index}>{String(child)}</span>;
  });
}

type GenUINodeChildren = GenUIComponentProps['node']['children'];

const COMPONENTS: Record<string, GenUIComponent> = {
  Box({ node, ctx, renderChildren }) {
    const props = node.props ?? {};
    const direction = props.direction === 'row' ? 'row' : 'col';
    const gap = typeof props.gap === 'number' ? props.gap : 0;
    const padding = typeof props.padding === 'number' ? props.padding : 0;
    const base = cn(
      'flex',
      direction === 'row' ? 'items-center' : 'flex-col',
    );
    const style: React.CSSProperties = {
      gap: gap * 4,
      padding: padding * 4,
    };
    return (
      <div
        className={cn(
          base,
          props.border && 'rounded-lg border border-border',
          direction === 'row' && 'flex-wrap',
        )}
        style={style}
      >
        {renderChildren(node.children)}
      </div>
    );
  },

  Card({ node, ctx, renderChildren }) {
    const props = node.props ?? {};
    const title = ctx.resolveText(props.title);
    return (
      <Card className={cn('overflow-hidden', props.tone === 'muted' && 'bg-muted/40')}>
        {title && (
          <CardHeader className="px-4 py-3">
            <CardTitle className="text-sm font-medium">{title}</CardTitle>
          </CardHeader>
        )}
        <CardContent className={cn('px-4', title ? 'pb-4' : 'py-4')}>
          {renderChildren(node.children)}
        </CardContent>
      </Card>
    );
  },

  Divider() {
    return <div className="h-px w-full bg-border" />;
  },

  Title({ node, ctx, renderChildren }) {
    const props = node.props ?? {};
    const size =
      props.size === 'xl'
        ? 'text-2xl'
        : props.size === 'lg'
          ? 'text-xl'
          : props.size === 'md'
            ? 'text-lg'
            : 'text-base';
    const weight =
      props.weight === 'semibold'
        ? 'font-semibold'
        : props.weight === 'medium'
          ? 'font-medium'
          : 'font-bold';
    return (
      <h3 className={cn(size, weight, 'leading-snug', TONE_TEXT[toneOf(node)] ?? '')}>
        <TextContent node={node} ctx={ctx} children={renderChildren(node.children)} />
      </h3>
    );
  },

  Text({ node, ctx, renderChildren }) {
    const props = node.props ?? {};
    const size =
      props.size === 'lg'
        ? 'text-[15px]'
        : props.size === 'sm'
          ? 'text-xs'
          : 'text-sm';
    const weight =
      props.weight === 'semibold'
        ? 'font-semibold'
        : props.weight === 'medium'
          ? 'font-medium'
          : undefined;
    return (
      <p className={cn(size, weight, TONE_TEXT[toneOf(node)] ?? '', 'leading-relaxed')}>
        <TextContent node={node} ctx={ctx} children={renderChildren(node.children)} />
      </p>
    );
  },

  Markdown({ node, ctx, renderChildren }) {
    const text = ctx.resolveText(node.children ?? []);
    return (
      <div className="text-sm text-foreground">
        <MarkdownRenderer text={text} variant="compact" />
      </div>
    );
  },

  Badge({ node, ctx, renderChildren }) {
    return (
      <Badge variant="outline" className={cn('font-normal', TONE_BADGE[toneOf(node)] ?? '')}>
        <TextContent node={node} ctx={ctx} children={renderChildren(node.children)} />
      </Badge>
    );
  },

  Table({ node, ctx }) {
    const props = node.props ?? {};
    const columns = asArray(props.columns) as unknown as Array<{ key: string; label: string; align?: string }>;
    const rows = asArray(props.rows) as unknown as GenUIPropValue[][];
    if (!columns || columns.length === 0) return null;
    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              {columns.map((col) => (
                <th key={col.key} className="px-2 py-1.5 text-left align-middle text-xs font-medium text-muted-foreground">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((row, index) => (
              <tr key={index} className={cn('border-b border-border/60 last:border-0', props.striped && index % 2 === 1 && 'bg-muted/40')}>
                {columns.map((col, colIndex) => (
                  <td key={col.key} className="px-2 py-1.5 align-middle">
                    {ctx.resolveText(row[colIndex])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  },

  Chart({ node, ctx }) {
    const props = node.props ?? {};
    const kind = props.kind as 'bar' | 'line' | 'pie';
    const data = (props.data as GenUIPropValue[]) ?? [];
    const height = typeof props.height === 'number' ? props.height : 260;
    const chartData = data.map((datum) => {
      const d = datum as unknown as { label?: unknown; value?: unknown };
      return {
        label: ctx.resolveText(d.label),
        value: typeof d.value === 'number' ? d.value : 0,
      };
    });
    return (
      <GenUIChart
        kind={kind}
        data={chartData}
        height={height}
        tone={toneOf(node)}
        title={ctx.resolveText(props.title) || undefined}
      />
    );
  },

  KeyValue({ node, ctx }) {
    const props = node.props ?? {};
    const items = (asArray(props.items) ?? []) as unknown as Array<{ label: string; value: unknown }>;
    return (
      <div className="divide-y divide-border/70 rounded-lg border border-border">
        {items.map((item, index) => (
          <div key={index} className="flex items-center justify-between gap-3 px-3 py-1.5">
            <span className="text-xs text-muted-foreground">{ctx.resolveText(item.label)}</span>
            <span className="text-sm font-medium tabular-nums text-foreground">{ctx.resolveText(item.value)}</span>
          </div>
        ))}
      </div>
    );
  },

  Progress({ node, ctx }) {
    const props = node.props ?? {};
    const max = typeof props.max === 'number' && props.max > 0 ? props.max : 100;
    const value = typeof props.value === 'number' ? props.value : ctx.resolveToNumber(props.value);
    const clamped = Math.max(0, Math.min(max, value));
    return (
      <div className="flex flex-col gap-1">
        {ctx.resolveText(props.label) ? (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{ctx.resolveText(props.label)}</span>
            <span className="tabular-nums">{Math.round((clamped / max) * 100)}%</span>
          </div>
        ) : null}
        <Progress value={(clamped / Math.max(1, max)) * 100} />
      </div>
    );
  },

  Slider({ node, ctx }) {
    const props = node.props ?? {};
    const min = typeof props.min === 'number' ? props.min : 0;
    const max = typeof props.max === 'number' ? props.max : 100;
    const step = typeof props.step === 'number' ? props.step : 1;
    const value = ctx.resolveToNumber(props.value);
    const onChange = ctx.action(props.onChange);
    return (
      <div className="flex flex-col gap-1.5">
        {ctx.resolveText(props.label) ? (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{ctx.resolveText(props.label)}</span>
            <span className="tabular-nums text-foreground">{value}</span>
          </div>
        ) : null}
        <Slider
          min={min}
          max={max}
          step={step}
          value={[Number.isFinite(value) ? value : min]}
          onValueChange={(v) => onChange?.(v[0])}
        />
      </div>
    );
  },

  NumberInput({ node, ctx }) {
    const props = node.props ?? {};
    const value = ctx.resolveToNumber(props.value);
    const onChange = ctx.action(props.onChange);
    return (
      <label className="flex flex-col gap-1">
        {ctx.resolveText(props.label) ? (
          <span className="text-xs text-muted-foreground">{ctx.resolveText(props.label)}</span>
        ) : null}
        <Input
          type="number"
          min={typeof props.min === 'number' ? props.min : undefined}
          max={typeof props.max === 'number' ? props.max : undefined}
          step={typeof props.step === 'number' ? props.step : 1}
          value={Number.isFinite(value) ? value : ''}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next)) onChange?.(next);
          }}
        />
      </label>
    );
  },

  TextInput({ node, ctx }) {
    const props = node.props ?? {};
    const value = ctx.resolveText(props.value);
    const onChange = ctx.action(props.onChange);
    return (
      <label className="flex flex-col gap-1">
        {ctx.resolveText(props.label) ? (
          <span className="text-xs text-muted-foreground">{ctx.resolveText(props.label)}</span>
        ) : null}
        <Input
          placeholder={ctx.resolveText(props.placeholder) || undefined}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
        />
      </label>
    );
  },

  Select({ node, ctx }) {
    const { t } = useTranslation();
    const props = node.props ?? {};
    const options = (asArray(props.options) ?? []) as unknown as Array<{ value: string; label: string }>;
    const value = ctx.resolveText(props.value);
    const onChange = ctx.action(props.onChange);
    return (
      <label className="flex flex-col gap-1">
        {ctx.resolveText(props.label) ? (
          <span className="text-xs text-muted-foreground">{ctx.resolveText(props.label)}</span>
        ) : null}
        <Select value={value || undefined} onValueChange={(v) => onChange?.(v)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t('task.runCode.selectPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt, index) => (
              <SelectItem key={index} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    );
  },

  Switch({ node, ctx }) {
    const props = node.props ?? {};
    const checked = ctx.resolveToBoolean(props.checked);
    const onChange = ctx.action(props.onChange);
    return (
      <div className="flex items-center justify-between gap-3">
        {ctx.resolveText(props.label) ? (
          <span className="text-sm text-foreground">{ctx.resolveText(props.label)}</span>
        ) : (
          <span />
        )}
        <Switch checked={checked} onCheckedChange={(v) => onChange?.(v)} />
      </div>
    );
  },

  Button({ node, ctx }) {
    const props = node.props ?? {};
    const label = ctx.resolveText(props.label);
    const onClick = ctx.action(props.onClick);
    const variant =
      props.variant === 'secondary'
        ? 'secondary'
        : props.variant === 'ghost'
          ? 'ghost'
          : 'default';
    return (
      <Button variant={variant} onClick={() => onClick?.(null)}>
        {label}
      </Button>
    );
  },

  Tabs({ node, ctx, renderChildren }) {
    const props = node.props ?? {};
    const items = (asArray(props.items) ?? []) as unknown as Array<{
      value: string;
      label: string;
      content: GenUIPropValue;
    }>;
    const value = ctx.resolveText(props.value) || items[0]?.value;
    const onChange = ctx.action(props.onChange);
    if (items.length === 0) return null;
    return (
      <Tabs value={value} onValueChange={(v) => onChange?.(v)} className="w-full">
        <TabsList className="w-full justify-start">
          {items.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {items.map((item) => {
          const contentNode = item.content as unknown as GenUIPropValue;
          return (
            <TabsContent key={item.value} value={item.value} className="mt-2">
              {renderNodeFromRaw(contentNode, ctx, renderChildren)}
            </TabsContent>
          );
        })}
      </Tabs>
    );
  },

  Image({ node, ctx }) {
    const props = node.props ?? {};
    const src = ctx.resolveText(props.src);
    const height = typeof props.height === 'number' ? props.height : undefined;
    if (!src || !isSafeImageSrc(src)) return null;
    return (
      <img
        src={src}
        alt={ctx.resolveText(props.alt) || ''}
        style={height ? { height, width: 'auto' } : { maxHeight: 420, width: 'auto' }}
        className="rounded-lg object-contain"
      />
    );
  },

  Callout({ node, ctx, renderChildren }) {
    const props = node.props ?? {};
    const tone = (toneOf(node) as string) || 'info';
    return (
      <div className={cn('rounded-lg border px-3 py-2', CALL_OUT[tone] ?? CALL_OUT.info)}>
        {ctx.resolveText(props.title) ? (
          <div className="mb-1 text-sm font-medium">{ctx.resolveText(props.title)}</div>
        ) : null}
        <div className="text-sm">{renderChildren(node.children)}</div>
      </div>
    );
  },

  EmptyState({ node, ctx }) {
    const props = node.props ?? {};
    return (
      <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border py-8 text-center">
        {ctx.resolveText(props.title) ? (
          <span className="text-sm font-medium text-foreground">{ctx.resolveText(props.title)}</span>
        ) : null}
        {ctx.resolveText(props.text) ? (
          <span className="text-xs text-muted-foreground">{ctx.resolveText(props.text)}</span>
        ) : null}
      </div>
    );
  },

  Unsupported({ node }) {
    const { t } = useTranslation();
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {t('task.runCode.unsupportedComponent', {
          name: typeof node.props?.component === 'string' ? node.props.component : node.type,
        })}
      </div>
    );
  },
};

function renderNodeFromRaw(
  value: GenUIPropValue,
  ctx: GenUIComponentProps['ctx'],
  renderChildren: GenUIComponentProps['renderChildren'],
): ReactNode {
  if (value && typeof value === 'object' && 'type' in value && typeof (value as { type?: unknown }).type === 'string') {
    const node = value as unknown as GenUIComponentProps['node'];
    return <>{renderChildren([node])}</>;
  }
  return ctx.resolveText(value);
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** 图片地址白名单：只允许本机媒体通道 */
function isSafeImageSrc(src: string): boolean {
  return src.startsWith('/api/filesystem/media?') || src.startsWith('/api/filesystem/media/');
}

export type { GenUIComponentProps, GenUIComponent };
export { COMPONENTS };