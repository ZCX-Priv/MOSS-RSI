// webui/src/render/genui/catalog.tsx
// Intelligent UI 组件目录（与后端 catalog.ts 同名集合）。
// 所有组件使用现有 shadcn/radix 与 React；不引入任意 HTML/CSS/JS。
// 组件只通过 ctx 读状态/解析绑定/触发本地动作；不访问模型或网络。
//
// 布局约定：
//   - Grid 负责严格多列；Box row 只负责一维排列，宽组件让它独占一行。
//   - 所有标量属性都先经 ctx 解析绑定，再做运行时兜底（枚举/数字/布尔）。

import { lazy } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle, Info, XCircle, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MarkdownRenderer } from '../markdown/MarkdownRenderer';
import { useDarkMode } from '../core/use-dark-mode';
import { PageFrame } from './page/PageFrame';
import { genuiIcon } from './icons';
import type { GenUIComponentProps, GenUIComponent } from './context';
import type { GenUIPropValue, GenUIStateValue } from './types';

/** 图表懒加载（首屏不引入 echarts） */
const GenUIChart = lazy(() => import('./components/Chart'));

const TONES = ['default', 'muted', 'primary', 'success', 'warning', 'danger', 'info'] as const;
const ALIGNS = ['left', 'center', 'right'] as const;

/** 文本色 */
const TONE_TEXT: Record<string, string> = {
  default: 'text-foreground',
  muted: 'text-muted-foreground',
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
};

/** 浅底（soft surface / soft badge） */
const TONE_SOFT: Record<string, string> = {
  default: 'bg-muted/50 text-foreground',
  muted: 'bg-muted/50 text-muted-foreground',
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
  info: 'bg-info/10 text-info',
};

/** 实底（solid surface / solid badge） */
const TONE_SOLID: Record<string, string> = {
  default: 'bg-muted text-foreground',
  muted: 'bg-muted text-muted-foreground',
  primary: 'bg-primary text-primary-foreground',
  success: 'bg-success text-white',
  warning: 'bg-warning text-black',
  danger: 'bg-danger text-white',
  info: 'bg-info text-white',
};

/** 圆点 */
const TONE_DOT: Record<string, string> = {
  default: 'bg-muted-foreground',
  muted: 'bg-muted-foreground/60',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
};

/** 描边（outline badge） */
const TONE_OUTLINE: Record<string, string> = {
  default: 'border-border text-foreground',
  muted: 'border-border text-muted-foreground',
  primary: 'border-primary/40 text-primary',
  success: 'border-success/40 text-success',
  warning: 'border-warning/40 text-warning',
  danger: 'border-danger/40 text-danger',
  info: 'border-info/40 text-info',
};

/** Progress 指示条颜色（radix Progress 的 indicator 带 data-slot） */
const TONE_PROGRESS: Record<string, string> = {
  default: '',
  muted: '[&_[data-slot=progress-indicator]]:bg-muted-foreground',
  primary: '[&_[data-slot=progress-indicator]]:bg-primary',
  success: '[&_[data-slot=progress-indicator]]:bg-success',
  warning: '[&_[data-slot=progress-indicator]]:bg-warning',
  danger: '[&_[data-slot=progress-indicator]]:bg-danger',
  info: '[&_[data-slot=progress-indicator]]:bg-info',
};

const CALL_OUT: Record<string, string> = {
  info: 'border-info/30 bg-info/10 text-info',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  danger: 'border-danger/30 bg-danger/10 text-danger',
};

const CALL_ICON: Record<string, LucideIcon> = {
  info: Info,
  success: CheckCircle,
  warning: AlertTriangle,
  danger: XCircle,
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
  none: 'rounded-none',
  sm: 'rounded-md',
  md: 'rounded-lg',
  lg: 'rounded-xl',
  xl: 'rounded-2xl',
  full: 'rounded-full',
};

const SHADOW_CLASS: Record<string, string> = {
  none: '',
  sm: 'shadow-sm',
  md: 'shadow-md',
};

const TEXT_ALIGN_CLASS: Record<string, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
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

/** 间距刻度：1 ≈ 4px */
function space(value: number): number {
  return clampNumber(value, 0, 8) * 4;
}

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
    const radius = resolveEnum(node, ctx, 'radius', ['none', 'sm', 'md', 'lg', 'xl', 'full'] as const, 'md');
    const shadow = resolveEnum(node, ctx, 'shadow', ['none', 'sm', 'md'] as const, 'none');
    // 未显式声明 surface 时：有色 → 浅底；默认色 → 透明（兼容旧规格）
    const surface = resolveEnum(
      node,
      ctx,
      'surface',
      ['none', 'soft', 'solid'] as const,
      tone === 'default' ? 'none' : 'soft',
    );
    const gap = space(resolveNumberProp(node, ctx, 'gap'));
    const padding = space(resolveNumberProp(node, ctx, 'padding'));
    const height =
      props.height === undefined ? undefined : clampNumber(resolveNumberProp(node, ctx, 'height'), 8, 600);
    const widthRaw = props.width === undefined ? undefined : ctx.resolve(props.width);
    const style: CSSProperties = { gap, padding };
    if (height !== undefined) style.height = height;
    if (typeof widthRaw === 'number' && Number.isFinite(widthRaw)) style.width = widthRaw;
    else if (widthRaw === 'full') style.width = '100%';

    return (
      <div
        className={cn(
          'flex min-w-0',
          direction === 'row' ? 'flex-row [&>*]:shrink-0 [&>*]:max-w-full' : 'flex-col [&>*]:min-w-0',
          direction === 'row' && wrap && 'flex-wrap',
          ALIGN_CLASS[align],
          JUSTIFY_CLASS[justify],
          border && 'border border-border/70',
          surface !== 'none' && RADIUS_CLASS[radius],
          surface === 'soft' && (TONE_SOFT[tone] ?? ''),
          surface === 'solid' && (TONE_SOLID[tone] ?? ''),
          SHADOW_CLASS[shadow],
        )}
        style={style}
      >
        {renderChildren(node.children)}
      </div>
    );
  },

  Grid({ node, ctx, renderChildren }) {
    const columns = clampNumber(resolveNumberProp(node, ctx, 'columns', 1), 1, 24);
    const gap = space(resolveNumberProp(node, ctx, 'gap'));
    const padding = space(resolveNumberProp(node, ctx, 'padding'));
    const align = resolveEnum(node, ctx, 'align', ['start', 'center', 'stretch'] as const, 'stretch');
    return (
      <div
        className={cn('grid min-w-0 [&>*]:min-w-0', ALIGN_CLASS[align])}
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap,
          padding,
        }}
      >
        {renderChildren(node.children)}
      </div>
    );
  },

  Card({ node, ctx, renderChildren }) {
    const props = node.props ?? {};
    const title = ctx.resolveText(props.title);
    const subtitle = ctx.resolveText(props.subtitle);
    const tone = toneOf(node, ctx);
    const border = resolveBoolProp(node, ctx, 'border', true);
    const radius = resolveEnum(node, ctx, 'radius', ['none', 'sm', 'md', 'lg', 'xl', 'full'] as const, 'lg');
    const shadow = resolveEnum(node, ctx, 'shadow', ['none', 'sm', 'md'] as const, 'sm');
    const compact = resolveBoolProp(node, ctx, 'compact', false);
    const padding = space(resolveNumberProp(node, ctx, 'padding', compact ? 3 : 4));
    return (
      <section
        className={cn(
          'flex min-w-0 flex-col',
          RADIUS_CLASS[radius],
          tone === 'default' ? 'bg-card/50' : TONE_SOFT[tone],
          border && 'border border-border/70',
          SHADOW_CLASS[shadow],
        )}
        style={{ padding, gap: compact ? 8 : 12 }}
      >
        {(title || subtitle) && (
          <header className="flex min-w-0 flex-col gap-0.5">
            {title ? <div className="text-[13px] font-semibold leading-snug text-foreground">{title}</div> : null}
            {subtitle ? (
              <div className="text-[11px] leading-snug text-muted-foreground">{subtitle}</div>
            ) : null}
          </header>
        )}
        <div className="flex min-w-0 flex-col gap-2">{renderChildren(node.children)}</div>
      </section>
    );
  },

  Section({ node, ctx, renderChildren }) {
    const props = node.props ?? {};
    const title = ctx.resolveText(props.title);
    const description = ctx.resolveText(props.description);
    const gap = space(resolveNumberProp(node, ctx, 'gap', 3));
    return (
      <section className="flex min-w-0 flex-col" style={{ gap }}>
        {(title || description) && (
          <header className="flex min-w-0 flex-col gap-0.5">
            {title ? <div className="text-sm font-semibold leading-snug text-foreground">{title}</div> : null}
            {description ? (
              <div className="text-[11px] leading-snug text-muted-foreground">{description}</div>
            ) : null}
          </header>
        )}
        <div className="flex min-w-0 flex-col gap-2">{renderChildren(node.children)}</div>
      </section>
    );
  },

  Divider({ node, ctx }) {
    const label = ctx.resolveText(node.props?.label);
    if (!label) return <div className="my-0.5 h-px w-full shrink-0 bg-border" />;
    return (
      <div className="flex w-full min-w-0 items-center gap-2">
        <span className="h-px min-w-4 flex-1 bg-border" />
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="h-px min-w-4 flex-1 bg-border" />
      </div>
    );
  },

  Title({ node, ctx, renderChildren }) {
    const size = resolveEnum(node, ctx, 'size', ['sm', 'md', 'lg', 'xl'] as const, 'md');
    const weight = resolveEnum(node, ctx, 'weight', ['normal', 'medium', 'semibold', 'bold'] as const, 'semibold');
    const align = resolveEnum(node, ctx, 'align', ALIGNS, 'left');
    const sizeClass =
      size === 'xl' ? 'text-2xl' : size === 'lg' ? 'text-xl' : size === 'md' ? 'text-base' : 'text-sm';
    const weightClass =
      weight === 'bold'
        ? 'font-bold'
        : weight === 'semibold'
          ? 'font-semibold'
          : weight === 'medium'
            ? 'font-medium'
            : 'font-normal';
    return (
      <h3
        className={cn(
          sizeClass,
          weightClass,
          TEXT_ALIGN_CLASS[align],
          'break-words leading-snug',
          TONE_TEXT[toneOf(node, ctx)] ?? '',
        )}
      >
        <TextContent node={node} ctx={ctx} children={renderChildren(node.children)} />
      </h3>
    );
  },

  Text({ node, ctx, renderChildren }) {
    const props = node.props ?? {};
    const size = resolveEnum(node, ctx, 'size', ['xs', 'sm', 'md', 'lg'] as const, 'md');
    const align = resolveEnum(node, ctx, 'align', ALIGNS, 'left');
    const mono = resolveBoolProp(node, ctx, 'mono', false);
    const truncate = resolveBoolProp(node, ctx, 'truncate', false);
    const sizeClass =
      size === 'lg' ? 'text-[15px]' : size === 'md' ? 'text-sm' : size === 'sm' ? 'text-xs' : 'text-[11px]';
    const weightValue = resolveEnum(
      node,
      ctx,
      'weight',
      ['normal', 'medium', 'semibold', 'bold'] as const,
      'normal',
    );
    const weightClass =
      weightValue === 'bold'
        ? 'font-bold'
        : weightValue === 'semibold'
          ? 'font-semibold'
          : weightValue === 'medium'
            ? 'font-medium'
            : '';
    return (
      <p
        className={cn(
          sizeClass,
          weightClass,
          mono && 'font-mono',
          truncate && 'truncate',
          TEXT_ALIGN_CLASS[align],
          TONE_TEXT[toneOf(node, ctx)] ?? '',
          'break-words leading-relaxed',
        )}
      >
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
    const tone = toneOf(node, ctx);
    const variant = resolveEnum(node, ctx, 'variant', ['soft', 'solid', 'outline'] as const, 'soft');
    const dot = resolveBoolProp(node, ctx, 'dot', false);
    return (
      <span
        className={cn(
          'inline-flex w-fit max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-[10px] font-medium leading-tight',
          variant === 'solid' && (TONE_SOLID[tone] ?? ''),
          variant === 'soft' && (TONE_SOFT[tone] ?? ''),
          variant === 'outline' && cn('border bg-transparent', TONE_OUTLINE[tone] ?? ''),
        )}
      >
        {dot ? <span className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[tone] ?? '')} /> : null}
        <TextContent node={node} ctx={ctx} children={renderChildren(node.children)} />
      </span>
    );
  },

  Stat({ node, ctx }) {
    const props = node.props ?? {};
    const label = ctx.resolveText(props.label);
    const value = ctx.resolveText(props.value);
    const hint = ctx.resolveText(props.hint);
    const delta = ctx.resolveText(props.delta);
    const trend = resolveEnum(node, ctx, 'trend', ['up', 'down', 'flat'] as const, 'flat');
    const tone = toneOf(node, ctx);
    const size = resolveEnum(node, ctx, 'size', ['md', 'lg'] as const, 'md');
    const TrendIcon = trend === 'up' ? genuiIcon('trending-up') : trend === 'down' ? genuiIcon('trending-down') : null;
    const trendClass = trend === 'up' ? 'text-success' : trend === 'down' ? 'text-danger' : 'text-muted-foreground';
    return (
      <div
        className={cn(
          'flex min-w-0 flex-col justify-center gap-0.5 rounded-lg border border-border/60 bg-muted/30',
          size === 'lg' ? 'px-4 py-3' : 'px-3 py-2',
        )}
      >
        <span className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            'truncate font-semibold tabular-nums leading-tight',
            size === 'lg' ? 'text-2xl' : 'text-xl',
            TONE_TEXT[tone] ?? 'text-foreground',
          )}
        >
          {value}
        </span>
        {(delta || hint) && (
          <div className="flex min-w-0 items-center gap-1 text-[11px]">
            {delta ? (
              <span className={cn('inline-flex shrink-0 items-center gap-0.5 tabular-nums', trendClass)}>
                {TrendIcon ? <TrendIcon className="size-3" /> : null}
                {delta}
              </span>
            ) : null}
            {hint ? <span className="min-w-0 truncate text-muted-foreground">{hint}</span> : null}
          </div>
        )}
      </div>
    );
  },

  List({ node, ctx }) {
    const items = (asArray(node.props?.items) ?? []) as unknown as Array<{
      label?: unknown;
      description?: unknown;
      value?: unknown;
      icon?: unknown;
      tone?: unknown;
    }>;
    const dense = resolveBoolProp(node, ctx, 'dense', false);
    const dividers = resolveBoolProp(node, ctx, 'dividers', true);
    if (items.length === 0) return null;
    return (
      <div className={cn('flex min-w-0 flex-col', dividers && 'divide-y divide-border/60')}>
        {items.map((item, index) => {
          const tone = ctx.resolveText(item.tone) || 'default';
          const Icon = genuiIcon(ctx.resolveText(item.icon) || undefined);
          const hasIcon = typeof item.icon === 'string' || (item.icon !== null && typeof item.icon === 'object');
          const value = ctx.resolveText(item.value);
          return (
            <div
              key={index}
              className={cn('flex min-w-0 items-center gap-2', dense ? 'py-1' : 'py-1.5')}
            >
              {hasIcon ? (
                <Icon className={cn('size-3.5 shrink-0', TONE_TEXT[tone] ?? 'text-muted-foreground')} />
              ) : null}
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm leading-snug text-foreground">{ctx.resolveText(item.label)}</span>
                {ctx.resolveText(item.description) ? (
                  <span className="truncate text-[11px] leading-snug text-muted-foreground">
                    {ctx.resolveText(item.description)}
                  </span>
                ) : null}
              </div>
              {value ? (
                <span className="shrink-0 text-sm font-medium tabular-nums text-muted-foreground">{value}</span>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  },

  Timeline({ node, ctx }) {
    const items = (asArray(node.props?.items) ?? []) as unknown as Array<{
      label?: unknown;
      description?: unknown;
      time?: unknown;
      tone?: unknown;
    }>;
    if (items.length === 0) return null;
    return (
      <div className="flex min-w-0 flex-col">
        {items.map((item, index) => {
          const tone = ctx.resolveText(item.tone) || 'primary';
          return (
            <div key={index} className="flex min-w-0 gap-2">
              <div className="flex shrink-0 flex-col items-center">
                <span className={cn('mt-1.5 size-2 rounded-full', TONE_DOT[tone] ?? 'bg-primary')} />
                {index < items.length - 1 && <span className="w-px flex-1 bg-border" />}
              </div>
              <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5', index < items.length - 1 && 'pb-2.5')}>
                <div className="flex min-w-0 items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-sm leading-snug text-foreground">
                    {ctx.resolveText(item.label)}
                  </span>
                  {ctx.resolveText(item.time) ? (
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {ctx.resolveText(item.time)}
                    </span>
                  ) : null}
                </div>
                {ctx.resolveText(item.description) ? (
                  <span className="break-words text-[11px] leading-snug text-muted-foreground">
                    {ctx.resolveText(item.description)}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
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
    const dense = resolveBoolProp(node, ctx, 'dense', false);
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
                    'align-middle text-xs font-medium text-muted-foreground',
                    dense ? 'px-1.5 py-1' : 'px-2 py-1.5',
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
                    className={cn(
                      'break-words align-middle',
                      dense ? 'px-1.5 py-1' : 'px-2 py-1.5',
                      alignClass(col.align),
                    )}
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
    const kind = resolveEnum(node, ctx, 'kind', ['bar', 'line', 'area', 'pie'] as const, 'bar');
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

  Sparkline({ node, ctx }) {
    const props = node.props ?? {};
    const values = asArray(props.values) ?? [];
    const numbers = values
      .map((item) => (typeof item === 'number' ? item : ctx.resolveToNumber(item)))
      .filter((item) => Number.isFinite(item));
    if (numbers.length < 2) return null;
    const height = clampNumber(resolveNumberProp(node, ctx, 'height', 40), 24, 160);
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    const span = max - min || 1;
    const points = numbers
      .map((value, index) => {
        const x = (index / (numbers.length - 1)) * 100;
        const y = 100 - ((value - min) / span) * 92 - 4;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
    const tone = toneOf(node, ctx);
    return (
      <div
        className={cn('w-full min-w-0', TONE_TEXT[tone] ?? 'text-primary')}
        style={{ height }}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="size-full">
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    );
  },

  KeyValue({ node, ctx }) {
    const items = (asArray(node.props?.items) ?? []) as unknown as Array<{ label: string; value: unknown }>;
    const columns = clampNumber(resolveNumberProp(node, ctx, 'columns', 1), 1, 4);
    return (
      <div
        className={cn('min-w-0', columns > 1 ? 'grid gap-x-4 gap-y-1' : 'flex flex-col divide-y divide-border/60')}
        style={columns > 1 ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
      >
        {items.map((item, index) => (
          <div
            key={index}
            className={cn(
              'flex min-w-0 items-start justify-between gap-3',
              columns === 1 && 'py-1.5',
            )}
          >
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
    const tone = toneOf(node, ctx);
    const showPercent = resolveBoolProp(node, ctx, 'showValue', Boolean(label));
    return (
      <div className="flex min-w-0 flex-col gap-1">
        {(label || showPercent) && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{label}</span>
            {showPercent ? (
              <span className="shrink-0 tabular-nums">{Math.round((value / max) * 100)}%</span>
            ) : null}
          </div>
        )}
        <Progress className={cn(TONE_PROGRESS[tone] ?? '')} value={(value / max) * 100} />
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

  Checkbox({ node, ctx }) {
    const props = node.props ?? {};
    const checked = ctx.resolveToBoolean(props.checked);
    const onChange = ctx.action(props.onChange);
    const label = ctx.resolveText(props.label);
    return (
      <label className="flex min-w-0 cursor-pointer items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange?.(e.target.checked)}
          className="size-3.5 shrink-0 cursor-pointer accent-primary"
        />
        {label ? <span className="min-w-0">{label}</span> : null}
      </label>
    );
  },

  RadioGroup({ node, ctx }) {
    const props = node.props ?? {};
    const options = (asArray(props.options) ?? []) as unknown as Array<{ value: string; label: string }>;
    const value = ctx.resolveText(props.value);
    const onChange = ctx.action(props.onChange);
    const label = ctx.resolveText(props.label);
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {options.map((opt, index) => (
            <label
              key={index}
              className="flex cursor-pointer items-center gap-1.5 text-sm text-foreground"
            >
              <input
                type="radio"
                name={`genui-radio-${label || 'group'}-${index}`}
                checked={value === opt.value}
                onChange={() => onChange?.(opt.value)}
                className="size-3.5 cursor-pointer accent-primary"
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>
    );
  },

  SegmentedControl({ node, ctx }) {
    const props = node.props ?? {};
    const options = (asArray(props.options) ?? []) as unknown as Array<{ value: string; label: string }>;
    const value = ctx.resolveText(props.value);
    const onChange = ctx.action(props.onChange);
    if (options.length === 0) return null;
    return (
      <div className="inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-lg bg-muted p-0.5">
        {options.map((opt, index) => {
          const active = value === opt.value;
          return (
            <button
              key={index}
              type="button"
              onClick={() => onChange?.(opt.value)}
              className={cn(
                'cursor-pointer rounded-md px-2.5 py-1 text-xs transition-colors',
                active
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    );
  },

  Button({ node, ctx }) {
    const props = node.props ?? {};
    const label = ctx.resolveText(props.label);
    const onClick = ctx.action(props.onClick);
    const variant = resolveEnum(node, ctx, 'variant', ['primary', 'secondary', 'ghost', 'danger'] as const, 'primary');
    const size = resolveEnum(node, ctx, 'size', ['sm', 'md', 'lg'] as const, 'md');
    const full = resolveBoolProp(node, ctx, 'full', false);
    const value = resolveEventValue(props.value, ctx);
    const iconName = ctx.resolveText(props.icon);
    const Icon = genuiIcon(iconName || undefined);
    return (
      <Button
        variant={
          variant === 'secondary'
            ? 'secondary'
            : variant === 'ghost'
              ? 'ghost'
              : variant === 'danger'
                ? 'destructive'
                : 'default'
        }
        size={size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : 'default'}
        className={cn(full && 'w-full')}
        onClick={() => onClick?.(value)}
      >
        {iconName ? <Icon className="size-3.5" /> : null}
        {label}
      </Button>
    );
  },

  Icon({ node, ctx }) {
    const props = node.props ?? {};
    const Comp = genuiIcon(ctx.resolveText(props.name) || undefined);
    const size = clampNumber(resolveNumberProp(node, ctx, 'size', 18), 12, 64);
    return (
      <Comp
        className={cn('shrink-0', TONE_TEXT[toneOf(node, ctx)] ?? 'text-muted-foreground')}
        style={{ width: size, height: size }}
      />
    );
  },

  Avatar({ node, ctx }) {
    const props = node.props ?? {};
    const name = ctx.resolveText(props.name);
    const src = ctx.resolveText(props.src);
    const size = resolveEnum(node, ctx, 'size', ['sm', 'md', 'lg'] as const, 'md');
    const tone = toneOf(node, ctx);
    const sizeClass = size === 'lg' ? 'size-10 text-sm' : size === 'sm' ? 'size-6 text-[10px]' : 'size-8 text-xs';
    if (src && isSafeImageSrc(src)) {
      return (
        <img
          src={src}
          alt={name}
          className={cn('shrink-0 rounded-full object-cover', sizeClass)}
        />
      );
    }
    const initial = name.trim().slice(0, 1).toUpperCase() || '?';
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full font-semibold',
          sizeClass,
          TONE_SOFT[tone] ?? TONE_SOFT.default,
        )}
      >
        {initial}
      </span>
    );
  },

  Code({ node, ctx }) {
    const props = node.props ?? {};
    const code = ctx.resolveText(props.code);
    const lang = ctx.resolveText(props.lang);
    const height =
      props.height === undefined ? undefined : clampNumber(resolveNumberProp(node, ctx, 'height'), 60, 600);
    return (
      <div className="min-w-0 overflow-hidden rounded-lg border border-border/70 bg-muted/40">
        {lang ? (
          <div className="border-b border-border/60 px-2.5 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {lang}
          </div>
        ) : null}
        <pre
          className="overflow-auto p-2.5 font-mono text-[11px] leading-relaxed text-foreground"
          style={height ? { height } : { maxHeight: 360 }}
        >
          {code}
        </pre>
      </div>
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
    const fit = resolveEnum(node, ctx, 'fit', ['cover', 'contain'] as const, 'contain');
    const radius = resolveEnum(node, ctx, 'radius', ['none', 'sm', 'md', 'lg', 'xl', 'full'] as const, 'md');
    if (!src || !isSafeImageSrc(src)) return null;
    return (
      <img
        src={src}
        alt={ctx.resolveText(props.alt) || ''}
        style={{ ...(height ? { height } : { maxHeight: 420 }), maxWidth: '100%', width: 'auto' }}
        className={cn('object-center', fit === 'cover' ? 'object-cover' : 'object-contain', RADIUS_CLASS[radius])}
      />
    );
  },

  Embed({ node, ctx }) {
    const dark = useDarkMode();
    const props = node.props ?? {};
    const mode = resolveEnum(node, ctx, 'mode', ['html', 'tsx'] as const, 'html');
    const source = ctx.resolveText(props.source);
    if (!source) return null;
    const title = ctx.resolveText(props.title) || undefined;
    const height = clampNumber(resolveNumberProp(node, ctx, 'height', 360), 240, 1200);
    const embedId = typeof props.__embedId === 'string' ? props.__embedId : '';
    const compiledJs = embedId ? ctx.embedScripts?.[embedId] : undefined;
    // 沙箱 iframe：与 run_code 内嵌页面同源同能力（含刷新按钮与 CDN 设置）
    return (
      <PageFrame
        mode={mode}
        source={source}
        title={title}
        height={height}
        streaming={false}
        dark={dark}
        compiledJs={compiledJs}
      />
    );
  },

  Callout({ node, ctx, renderChildren }) {
    const props = node.props ?? {};
    const tone = resolveEnum(node, ctx, 'tone', ['info', 'success', 'warning', 'danger'] as const, 'info');
    const title = ctx.resolveText(props.title);
    const iconName = ctx.resolveText(props.icon);
    const Icon = iconName ? genuiIcon(iconName) : CALL_ICON[tone] ?? Info;
    return (
      <div className={cn('flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2', CALL_OUT[tone] ?? CALL_OUT.info)}>
        <Icon className="mt-0.5 size-4 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {title ? <div className="text-sm font-medium">{title}</div> : null}
          <div className="min-w-0 text-sm">{renderChildren(node.children)}</div>
        </div>
      </div>
    );
  },

  EmptyState({ node, ctx }) {
    const props = node.props ?? {};
    const title = ctx.resolveText(props.title);
    const text = ctx.resolveText(props.text);
    const Icon = genuiIcon(ctx.resolveText(props.icon) || 'layers');
    return (
      <div className="flex min-w-0 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-8 text-center">
        <Icon className="size-6 text-muted-foreground/70" />
        {title ? <span className="text-sm font-medium text-foreground">{title}</span> : null}
        {text ? <span className="max-w-xs text-xs text-muted-foreground">{text}</span> : null}
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
