// webui/src/components/pages/McpMarketPage.tsx
// MCP 市场：源切换（mcpmarket / official / modelscope）+ 搜索 + 无限滚动。
// 点击安装后拉取详情，弹窗根据元数据自动生成 env 输入框与 JSON 预览。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Cable,
  Copy,
  Download,
  Eye,
  EyeOff,
  Info,
  Loader2,
  RefreshCw,
  Settings2,
  Star,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { useMcp } from '../../hooks/useMcp';
import { api } from '../../api/http';
import { wsClient } from '../../api/ws';
import { copyText } from '../../lib/clipboard';
import { RunningBar } from '../shared/RunningBar';
import type {
  McpMarketDetail,
  McpMarketEnvField,
  McpMarketInstallOption,
  McpMarketItem,
  McpMarketSource,
} from '../../types/api';

const PAGE_SIZE = 24;
const SOURCE_STORAGE_KEY = 'moss.mcpMarketSource';
const SERVER_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** 安装三阶段：下载安装配置 → 写入安装 → 启动并连接 */
type InstallPhase = 'download' | 'install' | 'start';

interface InstallTask {
  /** `${source}:${id}` */
  key: string;
  name: string;
  phase: InstallPhase;
}

const INSTALL_PHASES: InstallPhase[] = ['download', 'install', 'start'];

/** 阶段对应进度值（阶段内不谎报字节进度，仅做阶段级推进） */
const INSTALL_PHASE_PERCENT: Record<InstallPhase, number> = {
  download: 20,
  install: 55,
  start: 85,
};

const SOURCE_OPTIONS: Array<{ value: McpMarketSource; labelKey: string }> = [
  { value: 'mcpmarket', labelKey: 'plugins.mcpMarketSourceMcpMarket' },
  { value: 'official', labelKey: 'plugins.mcpMarketSourceOfficial' },
  { value: 'modelscope', labelKey: 'plugins.mcpMarketSourceModelScope' },
];

const SOURCE_LABEL_KEYS: Record<McpMarketSource, string> = {
  mcpmarket: 'plugins.mcpMarketSourceMcpMarket',
  official: 'plugins.mcpMarketSourceOfficial',
  modelscope: 'plugins.mcpMarketSourceModelScope',
};

function readSavedSource(): McpMarketSource {
  const saved = localStorage.getItem(SOURCE_STORAGE_KEY);
  return saved === 'official' || saved === 'modelscope' ? saved : 'mcpmarket';
}

/** 市场卡片图标：加载失败回退 Cable */
function MarketIcon({ item }: { item: McpMarketItem }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
      {item.iconUrl && !broken ? (
        <img
          src={item.iconUrl}
          alt=""
          loading="lazy"
          className="size-10 object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        <Cable className="size-5 text-muted-foreground" />
      )}
    </div>
  );
}

function defaultsFor(option: McpMarketInstallOption | undefined): Record<string, string> {
  if (!option) return {};
  const out: Record<string, string> = {};
  for (const field of option.env) {
    if (field.fixedValue !== undefined) continue;
    out[field.name] = field.default ?? '';
  }
  return out;
}

function renderHeaderTemplates(
  templates: Record<string, string> | undefined,
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [header, template] of Object.entries(templates ?? {})) {
    out[header] = template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => values[key] ?? '');
  }
  return out;
}

/** 生成与参考图一致的 mcpServers JSON 预览 */
function buildPreview(
  option: McpMarketInstallOption | undefined,
  name: string,
  envValues: Record<string, string>,
): string {
  if (!option) return '{}';
  const entry: Record<string, unknown> = {};
  if (option.kind === 'stdio') {
    entry.command = option.command ?? '';
    if (option.args && option.args.length > 0) entry.args = option.args;
    const env: Record<string, string> = {};
    for (const field of option.env) {
      const value = field.fixedValue ?? envValues[field.name] ?? '';
      if (value) env[field.name] = value;
    }
    if (Object.keys(env).length > 0) entry.env = env;
  } else {
    entry.type = option.transport === 'sse' ? 'sse' : 'http';
    entry.url = option.url ?? '';
    const headers = renderHeaderTemplates(option.headerTemplates, envValues);
    if (Object.keys(headers).length > 0) entry.headers = headers;
  }
  return JSON.stringify({ mcpServers: { [name || 'server']: entry } }, null, 2);
}

export function McpMarketPage({
  keyword,
  onKeywordChange,
}: {
  keyword: string;
  onKeywordChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const { servers, reload } = useMcp();

  const [source, setSource] = useState<McpMarketSource>(readSavedSource);
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [items, setItems] = useState<McpMarketItem[]>([]);
  const [nextToken, setNextToken] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  const [detail, setDetail] = useState<McpMarketDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [installedName, setInstalledName] = useState<string | undefined>(undefined);
  /** 当前安装任务：关闭弹窗后仍保留，卡片按钮据此显示“安装中” */
  const [installTask, setInstallTask] = useState<InstallTask | null>(null);

  /** 请求序号：源/关键词快速切换时丢弃过期响应 */
  const seqRef = useRef(0);

  useEffect(() => {
    localStorage.setItem(SOURCE_STORAGE_KEY, source);
  }, [source]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword.trim()), 300);
    return () => clearTimeout(timer);
  }, [keyword]);

  const load = useCallback(
    async (pageToken: string | undefined, append: boolean): Promise<void> => {
      const seq = ++seqRef.current;
      if (append) {
        setLoadingMore(true);
      } else {
        // 源/关键词切换：先清空旧列表，避免短暂展示另一个源的条目
        setItems([]);
        setNextToken(undefined);
        setLoading(true);
      }
      setError(false);
      try {
        const res = await api.marketMcpQuery({
          source,
          keyword: debouncedKeyword,
          pageToken,
        });
        if (seq !== seqRef.current) return;
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setNextToken(res.nextPageToken);
      } catch {
        if (seq === seqRef.current) setError(true);
      } finally {
        if (seq === seqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [source, debouncedKeyword],
  );

  useEffect(() => {
    void load(undefined, false);
  }, [load]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const handleScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el || loading || loadingMore || !nextToken) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) void load(nextToken, true);
  }, [loading, loadingMore, nextToken, load]);

  // 内容不足一屏时自动补齐，否则无法触发下一页
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || loading || loadingMore || !nextToken) return;
    if (el.scrollHeight - el.clientHeight < 300) void load(nextToken, true);
  }, [items.length, loading, loadingMore, nextToken, load]);

  const installedFor = useCallback(
    (item: McpMarketItem) =>
      servers.find((server) => server.market?.source === item.source && server.market.id === item.id),
    [servers],
  );

  // 安装阶段事件（后端 mcp:install:progress）：驱动弹窗进度条
  useEffect(() => {
    const unsub = wsClient.onMessage((msg) => {
      if (msg.type !== 'mcp.install-progress') return;
      const payload = msg.payload as
        | { source?: unknown; id?: unknown; phase?: unknown }
        | undefined;
      if (!payload) return;
      if (!INSTALL_PHASES.includes(payload.phase as InstallPhase)) return;
      const key = `${String(payload.source ?? '')}:${String(payload.id ?? '')}`;
      const phase = payload.phase as InstallPhase;
      setInstallTask((prev) => (prev && prev.key === key ? { ...prev, phase } : prev));
    });
    return unsub;
  }, []);

  /** 发起安装：任务托管在页面层，弹窗关闭后仍持续；结束后刷新列表 */
  const startInstall = useCallback(
    async (
      payload: {
        source: McpMarketSource;
        id: string;
        optionIndex?: number;
        env?: Record<string, string>;
        name?: string;
      },
      marketDetail: McpMarketDetail,
    ): Promise<void> => {
      const key = `${payload.source}:${payload.id}`;
      setInstallTask({ key, name: marketDetail.name, phase: 'download' });
      try {
        const result = await api.marketMcpInstall(payload);
        if (result.connected === false) {
          toast.warning(
            t('plugins.mcpInstallConnectFailed', { error: result.error ?? '' }),
            { duration: 8000 },
          );
        } else {
          toast.success(t('plugins.mcpInstallSuccess', { name: result.name }));
        }
        await reload();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`${t('plugins.mcpInstallFailed')}${message ? `: ${message}` : ''}`);
        throw err;
      } finally {
        setInstallTask(null);
      }
    },
    [reload, t],
  );

  const openInstall = useCallback(
    async (item: McpMarketItem, existingName?: string): Promise<void> => {
      setDetailLoadingId(item.id);
      try {
        const result = await api.marketMcpDetail(item.source, item.id);
        setDetail(result);
        setInstalledName(existingName);
        setDetailOpen(true);
      } catch (err) {
        toast.error(
          `${t('plugins.mcpMarketLoadFailed')}${err instanceof Error ? `: ${err.message}` : ''}`,
        );
      } finally {
        setDetailLoadingId(null);
      }
    },
    [t],
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 数据源切换（搜索框已统一在胶囊导航行） */}
      <div className="flex flex-wrap items-center gap-1.5 px-6 py-3">
        {SOURCE_OPTIONS.map((option) => (
          <Button
            key={option.value}
            variant={source === option.value ? 'secondary' : 'outline'}
            size="sm"
            className="h-7 rounded-lg px-2.5 text-xs"
            onClick={() => setSource(option.value)}
          >
            {t(option.labelKey)}
          </Button>
        ))}
      </div>

      {/* 列表 */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-auto px-6 pb-6">
        {loading && items.length === 0 && (
          <div className="flex justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && items.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-12 text-sm text-muted-foreground">
            <span>{t('plugins.mcpMarketLoadFailed')}</span>
            <Button variant="outline" size="sm" className="gap-1" onClick={() => void load(undefined, false)}>
              <RefreshCw className="size-3.5" />
              {t('plugins.mcpMarketRetry')}
            </Button>
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t('plugins.mcpMarketEmpty')}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => {
            const installed = installedFor(item);
            const busy = detailLoadingId === item.id;
            const installing = installTask?.key === `${item.source}:${item.id}`;
            return (
              <Card key={`${item.source}:${item.id}`} className="flex flex-row items-start gap-3 p-3">
                <MarketIcon item={item} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-medium text-foreground">{item.name}</h3>
                    {item.version && (
                      <Badge variant="outline" className="shrink-0 font-normal">
                        {item.version}
                      </Badge>
                    )}
                  </div>
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    {item.description || t('plugins.mcpMarketNoDescription')}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{t(SOURCE_LABEL_KEYS[item.source])}</span>
                    {item.hosted && (
                      <Badge variant="secondary" className="px-1 py-0 text-[10px] font-normal">
                        {t('plugins.mcpMarketHosted')}
                      </Badge>
                    )}
                    {item.stars !== undefined && (
                      <span className="inline-flex items-center gap-0.5">
                        <Star className="size-3" />
                        {item.stars}
                      </span>
                    )}
                    {item.views !== undefined && (
                      <span className="inline-flex items-center gap-0.5">
                        <Eye className="size-3" />
                        {item.views}
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  variant={installed ? 'outline' : 'default'}
                  size="sm"
                  className="relative shrink-0 gap-1 overflow-hidden"
                  disabled={busy || installing}
                  onClick={() => void openInstall(item, installed?.name)}
                >
                  {installing && <RunningBar />}
                  {busy || installing ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : installed ? (
                    <Settings2 className="size-3.5" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                  {installing
                    ? t('plugins.mcpInstalling')
                    : installed
                      ? t('plugins.mcpMarketReconfigure')
                      : t('plugins.mcpMarketInstall')}
                </Button>
              </Card>
            );
          })}
        </div>

        {loadingMore && (
          <div className="flex justify-center py-4">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>

      <McpInstallDialog
        open={detailOpen}
        detail={detail}
        installedName={installedName}
        task={installTask}
        onInstall={startInstall}
        onOpenChange={setDetailOpen}
      />
    </div>
  );
}

/* ===== 安装弹窗 ===== */

function McpInstallDialog({
  open,
  detail,
  installedName,
  task,
  onInstall,
  onOpenChange,
}: {
  open: boolean;
  detail: McpMarketDetail | null;
  installedName?: string;
  task?: InstallTask | null;
  onInstall: (
    payload: {
      source: McpMarketSource;
      id: string;
      optionIndex?: number;
      env?: Record<string, string>;
      name?: string;
    },
    detail: McpMarketDetail,
  ) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [optionIndex, setOptionIndex] = useState(0);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [visibleSecrets, setVisibleSecrets] = useState<Set<string>>(new Set());
  const [showOptional, setShowOptional] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);

  // 只展示当前弹窗条目对应的安装任务（避免上一个条目的进度串台）
  const activeTask = useMemo(
    () =>
      task && detail && task.key === `${detail.source}:${detail.id}` ? task : null,
    [task, detail],
  );
  const phase = activeTask?.phase;
  const phasePercent = phase ? INSTALL_PHASE_PERCENT[phase] : 0;
  const phaseLabel = phase
    ? phase === 'download'
      ? t('plugins.mcpInstallPhaseDownload')
      : phase === 'install'
        ? t('plugins.mcpInstallPhaseInstall')
        : t('plugins.mcpInstallConnecting')
    : '';

  useEffect(() => {
    if (!open || !detail) return;
    const first = detail.installOptions.find((option) => option.supported) ?? detail.installOptions[0];
    setOptionIndex(first?.index ?? 0);
    setEnvValues(defaultsFor(first));
    setName(installedName || detail.installName);
    setVisibleSecrets(new Set());
    setShowOptional(false);
    setBusy(false);
    setError(null);
    setMissing([]);
  }, [open, detail, installedName]);

  const option = useMemo(
    () =>
      detail?.installOptions.find((item) => item.index === optionIndex) ??
      detail?.installOptions.find((item) => item.supported) ??
      detail?.installOptions[0],
    [detail, optionIndex],
  );

  const editableFields = useMemo(
    () => (option?.env ?? []).filter((field) => field.fixedValue === undefined),
    [option],
  );
  const requiredFields = useMemo(() => editableFields.filter((field) => field.required), [editableFields]);
  const optionalFields = useMemo(
    () => editableFields.filter((field) => !field.required),
    [editableFields],
  );

  const updateEnv = useCallback((fieldName: string, value: string) => {
    setEnvValues((prev) => ({ ...prev, [fieldName]: value }));
    setMissing((prev) => prev.filter((name) => name !== fieldName));
  }, []);

  const toggleSecret = useCallback((fieldName: string) => {
    setVisibleSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(fieldName)) next.delete(fieldName);
      else next.add(fieldName);
      return next;
    });
  }, []);

  const handleOptionChange = useCallback(
    (value: string) => {
      const index = Number(value);
      const next = detail?.installOptions.find((item) => item.index === index);
      setOptionIndex(index);
      setEnvValues(defaultsFor(next));
      setMissing([]);
      setError(null);
    },
    [detail],
  );

  const preview = useMemo(() => buildPreview(option, name, envValues), [option, name, envValues]);

  const requiredMissing = requiredFields.some((field) => !(envValues[field.name] ?? '').trim());
  const nameValid = SERVER_NAME_RE.test(name);
  const disabled = busy || !option?.supported || requiredMissing || !nameValid;

  const copyPreview = useCallback(async (): Promise<void> => {
    if (await copyText(preview)) toast.success(t('plugins.mcpInstallCopied'));
    else toast.error(t('common.copyManualHint'));
  }, [preview, t]);

  const submit = useCallback(async (): Promise<void> => {
    if (!detail || !option || busy) return;
    const missingNow = requiredFields
      .filter((field) => !(envValues[field.name] ?? '').trim())
      .map((field) => field.name);
    if (missingNow.length > 0) {
      setMissing(missingNow);
      setError(t('plugins.mcpInstallMissingEnv'));
      return;
    }
    if (!SERVER_NAME_RE.test(name)) {
      setError(t('plugins.mcpInstallNameInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 安装任务由页面层托管：弹窗可随时关闭，后台继续安装/连接
      await onInstall(
        {
          source: detail.source,
          id: detail.id,
          optionIndex: option.index,
          env: envValues,
          name,
        },
        detail,
      );
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('MCP_MARKET_NAME_CONFLICT')) {
        setError(t('plugins.mcpInstallNameConflict'));
        if (!/-\d+$/.test(name)) setName(`${name}-2`);
      } else if (message.includes('MCP_MARKET_ENV_REQUIRED')) {
        setError(t('plugins.mcpInstallMissingEnv'));
      } else if (message.includes('MCP_MARKET_UNAVAILABLE') || message.startsWith('502')) {
        setError(t('plugins.mcpMarketLoadFailed'));
      } else {
        setError(message || t('plugins.mcpInstallFailed'));
      }
    } finally {
      setBusy(false);
    }
  }, [detail, option, busy, requiredFields, envValues, name, onInstall, onOpenChange, t]);

  const renderField = (field: McpMarketEnvField) => {
    const value = envValues[field.name] ?? '';
    const isMissing = missing.includes(field.name);
    const choices =
      field.choices && field.choices.length > 0
        ? field.choices
        : field.format === 'boolean'
          ? ['true', 'false']
          : undefined;
    return (
      <div key={field.name} className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label className="flex min-w-0 items-center gap-1 text-xs">
            {field.required && <span className="text-destructive">*</span>}
            <span className="truncate font-mono">{field.name}</span>
            {field.label && field.label !== field.name && (
              <span className="truncate font-normal text-muted-foreground">{field.label}</span>
            )}
            {field.description && (
              <span title={field.description} className="inline-flex shrink-0">
                <Info className="size-3.5 text-muted-foreground" aria-label={field.description} />
              </span>
            )}
          </Label>
          {detail?.obtainUrl && (
            <a
              href={detail.obtainUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 text-xs text-primary-strong hover:underline"
            >
              {t('plugins.mcpInstallObtain')}
            </a>
          )}
        </div>

        {choices ? (
          <Select value={value || undefined} onValueChange={(next) => updateEnv(field.name, next)}>
            <SelectTrigger className={cn(isMissing && 'border-destructive')}>
              <SelectValue placeholder={t('plugins.mcpInstallSelectPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {choices.map((choice) => (
                <SelectItem key={choice} value={choice}>
                  {choice}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : field.secret ? (
          <div className="relative">
            <Input
              type={visibleSecrets.has(field.name) ? 'text' : 'password'}
              value={value}
              placeholder={field.placeholder || field.name}
              className={cn('pr-9', isMissing && 'border-destructive')}
              onChange={(e) => updateEnv(field.name, e.target.value)}
            />
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              title={visibleSecrets.has(field.name) ? t('plugins.mcpInstallHideSecret') : t('plugins.mcpInstallShowSecret')}
              aria-label={visibleSecrets.has(field.name) ? t('plugins.mcpInstallHideSecret') : t('plugins.mcpInstallShowSecret')}
              onClick={() => toggleSecret(field.name)}
            >
              {visibleSecrets.has(field.name) ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        ) : (
          <Input
            type={field.format === 'number' ? 'number' : 'text'}
            value={value}
            placeholder={field.placeholder || field.default || field.name}
            className={cn(isMissing && 'border-destructive')}
            onChange={(e) => updateEnv(field.name, e.target.value)}
          />
        )}

        {field.description && (
          <p className="text-[11px] leading-snug text-muted-foreground">{field.description}</p>
        )}
        {isMissing && <p className="text-[11px] text-destructive">{t('plugins.mcpInstallFieldRequired')}</p>}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {installedName
              ? t('plugins.mcpReconfigureTitle', { name: installedName })
              : t('plugins.mcpInstallTitle', { name: detail?.name ?? '' })}
          </DialogTitle>
          <DialogDescription>
            {detail?.description || t('plugins.mcpInstallDesc')}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {detail && option ? (
            <div className="flex flex-col gap-4">
              {activeTask && (
                <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground">{phaseLabel}</span>
                    <span className="text-muted-foreground">{phasePercent}%</span>
                  </div>
                  <Progress value={phasePercent} />
                </div>
              )}

              <fieldset
                disabled={busy}
                className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
              >
              {detail.installOptions.length > 1 && (
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">{t('plugins.mcpInstallOption')}</Label>
                  <Select value={String(option.index)} onValueChange={handleOptionChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {detail.installOptions.map((item) => (
                        <SelectItem key={item.index} value={String(item.index)} disabled={!item.supported}>
                          {item.label}
                          {!item.supported && item.unsupportedReason ? `（${item.unsupportedReason}）` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {!option.supported && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                  {option.unsupportedReason || t('plugins.mcpInstallUnsupported')}
                </div>
              )}

              <section className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium text-foreground">
                    {t('plugins.mcpInstallRequiredEnv')}
                  </h4>
                  <span className="text-xs text-muted-foreground">{requiredFields.length}</span>
                </div>
                {requiredFields.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('plugins.mcpInstallNoEnv')}</p>
                ) : (
                  <div className="flex flex-col gap-3">{requiredFields.map(renderField)}</div>
                )}
              </section>

              {optionalFields.length > 0 && (
                <div className="rounded-lg border border-border px-3 py-2">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setShowOptional((prev) => !prev)}
                  >
                    <span>{t('plugins.mcpInstallOptionalEnv', { count: optionalFields.length })}</span>
                    <span>{showOptional ? '−' : '+'}</span>
                  </button>
                  {showOptional && (
                    <div className="mt-3 flex flex-col gap-3">{optionalFields.map(renderField)}</div>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-market-name" className="text-xs">
                  {t('plugins.mcpInstallServerName')}
                </Label>
                <Input
                  id="mcp-market-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={detail.installName}
                />
                <p className="text-[11px] text-muted-foreground">
                  {t('plugins.mcpInstallServerNameHint')}
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('plugins.mcpInstallJsonPreview')}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title={t('plugins.mcpInstallCopyJson')}
                    aria-label={t('plugins.mcpInstallCopyJson')}
                    onClick={() => void copyPreview()}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </div>
                <pre className="max-h-56 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">{preview}</pre>
              </div>
              </fieldset>

              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          ) : (
            <div className="flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={disabled}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy
              ? t('plugins.mcpInstalling')
              : installedName
                ? t('plugins.mcpMarketReconfigure')
                : t('plugins.mcpMarketInstall')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
