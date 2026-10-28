// webui/src/render/genui/catalog.tsx
// Intelligent UI 组件目录（与后端 catalog.ts 同名集合）。
// 所有组件使用现有 shadcn/radix 与 React；不引入任意 HTML/CSS/JS。
// 组件只通过 ctx 读状态/解析绑定/触发本地动作；不访问模型或网络。
//
// 布局约定：
//   - Grid 负责严格多列；Box row 只负责一维排列，宽组件让它独占一行。
//   - 所有标量属性都先经 ctx 解析绑定，再做运行时兜底（枚举/数字/布尔）。

import { lazy } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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

const TONES = ['default', 'muted', 'primary', 'success', 'warning', 'danger', 'info'] as const;

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

/** Box 的表面色（棋盘格子/分组底色；保持低饱和，避免卡片感） */
const TONE_SURFACE: Record<string, string> = {
  default: '',
  muted: 'bg-muted/50',
  primary: 'bg-blue-500/10',
  success: 'bg-emerald-500/15',
  warning: 'bg-amber-500/15',
  danger: 'bg-red-500/15',
  info: 'bg-sky-500/10',
};

const CALL_OUT: Record<string, string> = {
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  danger: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
};

const ALIGN_CLASS: Record<string, string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
};

const JUSTIFY_CLASS: Record<string, string> = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
};

const RADIUS_CLASS: Record<string, string> = {
  sm: 'rounded-md',
  md: 'rounded-lg',
  lg: 'rounded-xl',
};

/** 解析枚举属性：绑定结果不在白名单时回落到默认值 */
function resolveEnum<T extends string>(
  node: GenUIComponentProps['node'],
  ctx: GenUIComponentProps['ctx'],
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = ctx.resolveText(node.props?.[key]);
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** 解析数字属性；缺省返回 fallback */
function resolveNumberProp(
  node: GenUIComponentProps['node'],
  ctx: GenUIComponentProps['ctx'],
  key: string,
  fallback = 0,
): number {
  const raw = node.props?.[key];
  if (raw === undefined) return fallback;
  const value = ctx.resolveToNumber(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** 解析布尔属性；缺省返回 fallback */
function resolveBoolProp(
  node: GenUIComponentProps['node'],
  ctx: GenUIComponentProps['ctx'],
  key: string,
  fallback: boolean,
): boolean {
  const raw = node.props?.[key];
  if (raw === undefined) return fallback;
  return ctx.resolveToBoolean(raw);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function toneOf(node: GenUIComponentProps['node'], ctx: GenUIComponentProps['ctx']): string {
  return resolveEnum(node, ctx, 'tone', TONES, 'default');
}

function alignClass(align?: string): string {
  return align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : 'text-left';
}

/** Button 的点击事件值：绑定解析失败或非标量时回落到 null */
function resolveEventValue(
  value: GenUIPropValue | undefined,
  ctx: GenUIComponentProps['ctx'],
): GenUIStateValue {
  if (value === undefined) return null;
  const resolved = ctx.resolve(value);
  return resolved === null || typeof resolved === 'string' || typeof resolved === 'number' || typeof resolved === 'boolean'
    ? resolved
    : null;
}

/** 通用文本容器：把 children 拍平成字符串（含绑定求值 + 内联 Badge/Text 子节点） */
function TextContent({
  node,
  ctx,
  children,
}: {
  node: GenUIComponentProps['node'];
  ctx: GenUIComponentProps['ctx'];
  children?: ReactNode;
}) {
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
    const direction = resolveEnum(node, ctx, 'direction', ['row', 'col'] as const, 'col');
    const align = resolveEnum(
      node,
      ctx,
      'align',
      ['start', 'center', 'end', 'stretch'] as const,
      direction === 'row' ? 'center' : 'stretch',
    );
    const justify = resolveEnum(node, ctx, 'justify', ['start', 'center', 'end', 'between'] as const, 'start');
    const wrap = resolveBoolProp(node, ctx, 'wrap', true);
    const border = resolveBoolProp(node, ctx, 'border', false);
    const tone = toneOf(node, ctx);
    const radius = props.radius === undefined ? '' : resolveEnum(node, ctx, 'radius', ['sm', 'md', 'lg'] as const, 'md');
    const gap = clampNumber(resolveNumberProp(node, ctx, 'gap'), 0, 8);
    const padding = clampNumber(resolveNumberProp(node, ctx, 'padding'), 0, 8);
    const height =
      props.height === undefined ? undefined : clampNumber(resolveNumberProp(node, ctx, 'height'), 8, 600);
    const style: React.CSSProperties = { gap: gap * 4, padding: padding * 4 };
    if (height !== undefined) style.height = height;

    return (
      <div
        className={cn(
          'flex min-w-0',
          direction === 'row' ? 'flex-row [&>*]:shrink-0 [&>*]:max-w-full' : 'flex-col [&>*]:min-w-0',
          direction === 'row' && wrap && 'flex-wrap',
          ALIGN_CLASS[align],
          JUSTIFY_CLASS[justify],
          border && 'border border-border/70',
          radius ? RADIUS_CLASS[radius] : '',
          TONE_SURFACE[tone] ?? '',
        )}
        style={style}
      >
        {renderChildren(node.children)}
      </div>
    );
  },

  Grid({ node, ctx, renderChildren }) {
    const columns = clampNumber(resolveNumberProp(node, ctx, 'columns', 1), 1, 24);
    const gap = clampNumber(resolveNumberProp(node, ctx, 'gap'), 0, 8);
    const padding = clampNumber(resolveNumberProp(node, ctx, 'padding'), 0, 8);
    return (
      <div
        className="grid min-w-0 [&>*]:min-w-0"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: gap * 4,
          padding: padding * 4,
        }}
      >
        {renderChildren(node.children)}
      </div>
    );
  },

  Card({ node, ctx, renderChildren }) {
    const title = ctx.resolveText(node.props?.title);
    return (
      <section className="flex min-w-0 flex-col gap-2">
        {title ? <div className="text-sm font-medium text-foreground">{title}</div> : null}
        <div className="flex min-w-0 flex-col gap-2">{renderChildren(node.children)}</div>
      </section>
    );
  },

  Divider() {
    return <div className="my-0.5 h-px w-full shrink-0 bg-border" />;
  },

  Title({ node, ctx, renderChildren }) {
    const size = resolveEnum(node, ctx, 'size', ['sm', 'md', 'lg', 'xl'] as const, 'md');
    const weight = resolveEnum(node, ctx, 'weight', ['normal', 'medium', 'semibold'] as const, 'semibold');
    const sizeClass =
      size === 'xl' ? 'text-2xl' : size === 'lg' ? 'text-xl' : size === 'md' ? 'text-lg' : 'text-sm';
    const weightClass =
      weight === 'normal' ? 'font-normal' : weight === 'medium' ? 'font-medium' : 'font-semibold';
    return (
      <h3 className={cn(sizeClass, weightClass, 'break-words leading-snug', TONE_TEXT[toneOf(node, ctx)] ?? '')}>
        <TextContent node={node} ctx={ctx} children={renderChildren(node.children)} />
      </h3>
    );
  },

  Text({ node, ctx, renderChildren }) {
    const props = node.props ?? {};
    const size = resolveEnum(node, ctx, 'size', ['sm', 'md', 'lg', 'xl'] as const, 'md');
    const sizeClass = size === 'xl' ? 'text-base' : size === 'lg' ? 'text-[15px]' : size === 'sm' ? 'text-xs' : 'text-sm';
    const weightValue =
      props.weight === undefined
        ? undefined
        : resolveEnum(node, ctx, 'weight', ['normal', 'medium', 'semibold'] as const, 'normal');
    const weightClass =
      weightValue === 'semibold' ? 'font-semibold' : weightValue === 'medium' ? 'font-medium' : weightValue === 'normal' ? 'font-normal' : '';
    return (
      <p className={cn(sizeClass, weightClass, TONE_TEXT[toneOf(node, ctx)] ?? '', 'break-words leading-relaxed')}>
        <TextContent node={node} ctx={ctx} children={renderChildren(node.children)} />
      </p>
    );
  },

  Markdown({ node, ctx }) {
    const text = ctx.resolveText(node.children ?? []);
    return (
      <div className="min-w-0 text-sm text-foreground">
        <MarkdownRenderer text={text} variant="compact" />
      </div>
    );
  },

  Badge({ node, ctx, renderChildren }) {
    return (
      <Badge variant="outline" className={cn('font-normal', TONE_BADGE[toneOf(node, ctx)] ?? '')}>
        <TextContent node={node} ctx={ctx} children={renderChildren(node.children)} />
      </Badge>
    );
  },

  Table({ node, ctx }) {
    const props = node.props ?? {};
    const columns = asArray(props.columns) as unknown as Array<{
      key: string;
      label: string;
      align?: string;
    }> | null;
    const rows = asArray(props.rows) as unknown as GenUIPropValue[][] | null;
    const striped = resolveBoolProp(node, ctx, 'striped', false);
    if (!columns || columns.length === 0) return null;
    return (
      <div className="w-full min-w-0 overflow-x-auto">
        <table className="w-full min-w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    'px-2 py-1.5 align-middle text-xs font-medium text-muted-foreground',
                    alignClass(col.align),
                  )}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((row, index) => (
              <tr
                key={index}
                className={cn(
                  'border-b border-border/60 last:border-0',
                  striped && index % 2 === 1 && 'bg-muted/40',
                )}
              >
                {columns.map((col, colIndex) => (
                  <td
                    key={col.key}
                    className={cn('break-words px-2 py-1.5 align-middle', alignClass(col.align))}
                  >
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
    const kind = resolveEnum(node, ctx, 'kind', ['bar', 'line', 'pie'] as const, 'bar');
    const data = asArray(props.data) ?? [];
    const height = clampNumber(resolveNumberProp(node, ctx, 'height', 260), 120, 600);
    const chartData = data.map((datum) => {
      const d = datum as unknown as { label?: unknown; value?: unknown };
      return {
        label: ctx.resolveText(d.label),
        value: typeof d.value === 'number' ? d.value : ctx.resolveToNumber(d.value),
      };
    });
    return (
      <div className="w-full min-w-0">
        <GenUIChart
          kind={kind}
          data={chartData}
          height={height}
          tone={toneOf(node, ctx)}
          title={ctx.resolveText(props.title) || undefined}
        />
      </div>
    );
  },

  KeyValue({ node, ctx }) {
    const items = (asArray(node.props?.items) ?? []) as unknown as Array<{ label: string; value: unknown }>;
    return (
      <div className="flex min-w-0 flex-col divide-y divide-border/60">
        {items.map((item, index) => (
          <div key={index} className="flex min-w-0 items-start justify-between gap-3 py-1.5">
            <span className="shrink-0 text-xs text-muted-foreground">{ctx.resolveText(item.label)}</span>
            <span className="min-w-0 break-words text-right text-sm font-medium tabular-nums text-foreground">
              {ctx.resolveText(item.value)}
            </span>
          </div>
        ))}
      </div>
    );
  },

  Progress({ node, ctx }) {
    const props = node.props ?? {};
    const max = Math.max(1, resolveNumberProp(node, ctx, 'max', 100));
    const value = clampNumber(ctx.resolveToNumber(props.value), 0, max);
    const label = ctx.resolveText(props.label);
    return (
      <div className="flex min-w-0 flex-col gap-1">
        {label ? (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{label}</span>
            <span className="shrink-0 tabular-nums">{Math.round((value / max) * 100)}%</span>
          </div>
        ) : null}
        <Progress value={(value / max) * 100} />
      </div>
    );
  },

  Slider({ node, ctx }) {
    const props = node.props ?? {};
    const min = resolveNumberProp(node, ctx, 'min', 0);
    const maxRaw = resolveNumberProp(node, ctx, 'max', 100);
    const max = maxRaw > min ? maxRaw : min + 1;
    const stepRaw = resolveNumberProp(node, ctx, 'step', 1);
    const step = stepRaw > 0 ? stepRaw : 1;
    const value = clampNumber(ctx.resolveToNumber(props.value), min, max);
    const onChange = ctx.action(props.onChange);
    const label = ctx.resolveText(props.label);
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        {label ? (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{label}</span>
            <span className="shrink-0 tabular-nums text-foreground">{value}</span>
          </div>
        ) : null}
        <Slider min={min} max={max} step={step} value={[value]} onValueChange={(v) => onChange?.(v[0])} />
      </div>
    );
  },

  NumberInput({ node, ctx }) {
    const props = node.props ?? {};
    const value = ctx.resolveToNumber(props.value);
    const onChange = ctx.action(props.onChange);
    const label = ctx.resolveText(props.label);
    return (
      <label className="flex min-w-0 flex-col gap-1">
        {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
        <Input
          type="number"
          min={props.min === undefined ? undefined : resolveNumberProp(node, ctx, 'min')}
          max={props.max === undefined ? undefined : resolveNumberProp(node, ctx, 'max')}
          step={props.step === undefined ? 1 : resolveNumberProp(node, ctx, 'step', 1)}
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
    const label = ctx.resolveText(props.label);
    return (
      <label className="flex min-w-0 flex-col gap-1">
        {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
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
    const label = ctx.resolveText(props.label);
    return (
      <label className="flex min-w-0 flex-col gap-1">
        {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
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
    const label = ctx.resolveText(props.label);
    return (
      <div className="flex min-w-0 items-center justify-between gap-3">
        {label ? <span className="min-w-0 text-sm text-foreground">{label}</span> : <span />}
        <Switch checked={checked} onCheckedChange={(v) => onChange?.(v)} />
      </div>
    );
  },

  Button({ node, ctx }) {
    const props = node.props ?? {};
    const label = ctx.resolveText(props.label);
    const onClick = ctx.action(props.onClick);
    const variant = resolveEnum(node, ctx, 'variant', ['primary', 'secondary', 'ghost'] as const, 'primary');
    const size = resolveEnum(node, ctx, 'size', ['sm', 'md', 'lg'] as const, 'md');
    const full = resolveBoolProp(node, ctx, 'full', false);
    const value = resolveEventValue(props.value, ctx);
    return (
      <Button
        variant={variant === 'secondary' ? 'secondary' : variant === 'ghost' ? 'ghost' : 'default'}
        size={size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : 'default'}
        className={cn(full && 'w-full')}
        onClick={() => onClick?.(value)}
      >
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
      <Tabs value={value} onValueChange={(v) => onChange?.(v)} className="w-full min-w-0">
        <TabsList className="w-full justify-start overflow-x-auto">
          {items.map((item) => (
            <TabsTrigger key={item.value} value={item.value} className="shrink-0">
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {items.map((item) => {
          const contentNode = item.content as unknown as GenUIPropValue;
          return (
            <TabsContent key={item.value} value={item.value} className="mt-2 min-w-0">
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
    const height = props.height === undefined ? undefined : clampNumber(resolveNumberProp(node, ctx, 'height'), 40, 800);
    if (!src || !isSafeImageSrc(src)) return null;
    return (
      <img
        src={src}
        alt={ctx.resolveText(props.alt) || ''}
        style={{ ...(height ? { height } : { maxHeight: 420 }), maxWidth: '100%', width: 'auto' }}
        className="rounded-md object-contain"
      />
    );
  },

  Callout({ node, ctx, renderChildren }) {
    const props = node.props ?? {};
    const tone = resolveEnum(node, ctx, 'tone', ['info', 'success', 'warning', 'danger'] as const, 'info');
    const title = ctx.resolveText(props.title);
    return (
      <div className={cn('min-w-0 rounded-lg border px-3 py-2', CALL_OUT[tone] ?? CALL_OUT.info)}>
        {title ? <div className="mb-1 text-sm font-medium">{title}</div> : null}
        <div className="min-w-0 text-sm">{renderChildren(node.children)}</div>
      </div>
    );
  },

  EmptyState({ node, ctx }) {
    const props = node.props ?? {};
    const title = ctx.resolveText(props.title);
    const text = ctx.resolveText(props.text);
    return (
      <div className="flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border py-8 text-center">
        {title ? <span className="text-sm font-medium text-foreground">{title}</span> : null}
        {text ? <span className="text-xs text-muted-foreground">{text}</span> : null}
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
