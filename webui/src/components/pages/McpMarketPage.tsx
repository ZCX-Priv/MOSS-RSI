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
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useMcp } from '../../hooks/useMcp';
import { api } from '../../api/http';
import { wsClient } from '../../api/ws';
import { copyText } from '../../lib/clipboard';
import { RunningBar } from '../shared/RunningBar';
import { PluginIcon } from '../shared/PluginIcon';
import type {
  McpInstallPhase,
  McpInstallProgressEvent,
  McpMarketDetail,
  McpMarketEnvField,
  McpMarketInstallOption,
  McpMarketItem,
  McpMarketSource,
} from '../../types/api';

const PAGE_SIZE = 24;
const SOURCE_STORAGE_KEY = 'moss.mcpMarketSource';
const SERVER_NAME_RE = /^[a-zA-Z0-9_-]+$/;
/** 列表缓存时长（切换 tab / 源后立即恢复） */
const LIST_CACHE_MS = 60_000;

/** 安装阶段顺序（只允许前进；error 直接覆盖） */
const INSTALL_PHASE_RANK: Record<McpInstallPhase, number> = {
  prepare: 0,
  start: 1,
  download: 2,
  install: 3,
  connect: 4,
  done: 5,
  error: 99,
};

/** 阶段 → i18n key */
const INSTALL_PHASE_KEYS: Record<McpInstallPhase, string> = {
  prepare: 'plugins.mcpInstallPhasePrepare',
  start: 'plugins.mcpInstallPhaseStart',
  download: 'plugins.mcpInstallPhaseDownload',
  install: 'plugins.mcpInstallPhaseInstall',
  connect: 'plugins.mcpInstallConnecting',
  done: 'plugins.mcpInstallPhaseDone',
  error: 'plugins.mcpInstallPhaseError',
};

interface InstallTask {
  /** `${source}:${id}` */
  key: string;
  source: McpMarketSource;
  id: string;
  /** 写盘成功后返回的本地服务器名 */
  name?: string;
  marketName: string;
  phase: McpInstallPhase;
  detail?: string;
  log: string[];
  downloaded: number;
  startedAt: number;
  /** 重新配置：旧连接可能仍是 connected，需确认新连接已开始/完成 */
  reconfiguring: boolean;
}

/** 安装提交参数（自动配置 / 手动配置共用） */
interface InstallPayload {
  source: McpMarketSource;
  id: string;
  optionIndex?: number;
  env?: Record<string, string>;
  name?: string;
  /** 重新配置已安装的同源服务器 */
  reconfiguring?: boolean;
  manual?: {
    transport: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  };
}

/** 第一页列表缓存（模块级：切换 tab 后立即恢复） */
interface ListCacheEntry {
  items: McpMarketItem[];
  nextToken?: string;
  at: number;
}
const listCache = new Map<string, ListCacheEntry>();

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

/** 市场卡片图标：加载失败/超时回退 Cable */
function MarketIcon({ item }: { item: McpMarketItem }) {
  return (
    <PluginIcon
      src={item.iconUrl}
      fallback={<Cable className="size-5 text-muted-foreground" />}
    />
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

/** 手动配置：把市场声明的 env 变量预填为 KEY=默认值 */
function manualEnvSeed(option: McpMarketInstallOption | undefined): string {
  return (option?.env ?? [])
    .filter((field) => field.fixedValue === undefined)
    .map((field) => `${field.name}=${field.default ?? ''}`)
    .join('\n');
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

/** 替换 {VAR}：URL 场景对值做 URL 编码，未填写的变量保留 {VAR} */
function renderTemplate(
  text: string,
  values: Record<string, string>,
  encode = false,
): string {
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
    const value = values[key];
    if (!value) return match;
    return encode ? encodeURIComponent(value) : value;
  });
}

/** 生成与参考图一致的 mcpServers JSON 预览 */
function buildPreview(
  option: McpMarketInstallOption | undefined,
  name: string,
  envValues: Record<string, string>,
): string {
  if (!option) return '{}';
  const entry: Record<string, unknown> = {};
  // 固定值 + 用户输入：用于替换 args / URL / headers 中的 {VAR}
  const values: Record<string, string> = {};
  for (const field of option.env) {
    const value = field.fixedValue ?? envValues[field.name] ?? '';
    if (value) values[field.name] = value;
  }
  if (option.kind === 'stdio') {
    entry.command = option.command ?? '';
    if (option.args && option.args.length > 0) {
      entry.args = option.args.map((arg) => renderTemplate(arg, values));
    }
    if (Object.keys(values).length > 0) entry.env = values;
  } else {
    entry.type = option.transport === 'sse' ? 'sse' : 'http';
    entry.url = renderTemplate(option.url ?? '', values, true);
    const headers = renderHeaderTemplates(option.headerTemplates, values);
    if (Object.keys(headers).length > 0) entry.headers = headers;
  }
  return JSON.stringify({ mcpServers: { [name || 'server']: entry } }, null, 2);
}

/** 逐行解析 KEY=VALUE / Key: Value，返回合法值与非法行 */
function parseKeyValueLines(
  text: string,
  separator: '=' | ':',
  keyRe: RegExp,
): { values: Record<string, string>; invalid: string[] } {
  const values: Record<string, string> = {};
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf(separator);
    if (index <= 0) {
      invalid.push(line);
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!keyRe.test(key)) {
      invalid.push(line);
      continue;
    }
    values[key] = value;
  }
  return { values, invalid };
}

/** 手动配置的 JSON 预览 */
function buildManualPreview(params: {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string;
  argsText: string;
  url: string;
  envText: string;
  headersText: string;
}): string {
  const entry: Record<string, unknown> = {};
  if (params.transport === 'stdio') {
    entry.command = params.command.trim();
    const args = params.argsText.trim() ? params.argsText.trim().split(/\s+/).filter(Boolean) : [];
    if (args.length > 0) entry.args = args;
    const env = parseKeyValueLines(params.envText, '=', /^[A-Za-z_][A-Za-z0-9_]*$/).values;
    if (Object.keys(env).length > 0) entry.env = env;
  } else {
    entry.type = params.transport === 'sse' ? 'sse' : 'http';
    entry.url = params.url.trim();
    const headers = parseKeyValueLines(params.headersText, ':', /^[A-Za-z0-9-]+$/).values;
    if (Object.keys(headers).length > 0) entry.headers = headers;
  }
  return JSON.stringify({ mcpServers: { [params.name || 'server']: entry } }, null, 2);
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
  /** 详情请求序号：快速点击不同卡片时丢弃过期响应 */
  const detailSeqRef = useRef(0);
  /** 详情缓存：再次点击同一卡片直接打开 */
  const detailCacheRef = useRef(new Map<string, McpMarketDetail>());
  /** 已结束任务（避免 connected/error 重复 toast） */
  const handledTaskRef = useRef(new Set<string>());
  /** 重新配置时旧状态可能仍是 connected：必须观察到 connecting/disconnected 才接受新结果 */
  const sawNonConnectedRef = useRef(false);
  /** 日志批量刷新（避免每行日志触发整页重渲染） */
  const pendingLogsRef = useRef<string[]>([]);
  const pendingLogKeyRef = useRef('');
  const logFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    localStorage.setItem(SOURCE_STORAGE_KEY, source);
  }, [source]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword.trim()), 300);
    return () => clearTimeout(timer);
  }, [keyword]);

  /** 批量把缓冲日志追加到匹配的安装任务 */
  const flushPendingLogs = useCallback((): void => {
    logFlushTimerRef.current = null;
    const lines = pendingLogsRef.current.splice(0);
    if (lines.length === 0) return;
    const logKey = pendingLogKeyRef.current;
    setInstallTask((prev) => {
      if (!prev) return prev;
      const matches =
        (prev.name !== undefined && logKey === `server:${prev.name}`) ||
        logKey === `${prev.source}:${prev.id}`;
      if (!matches) return prev;
      return { ...prev, log: [...prev.log, ...lines].slice(-200) };
    });
  }, []);

  const scheduleLogFlush = useCallback((): void => {
    if (logFlushTimerRef.current) return;
    logFlushTimerRef.current = setTimeout(flushPendingLogs, 150);
  }, [flushPendingLogs]);

  useEffect(
    () => () => {
      if (logFlushTimerRef.current) clearTimeout(logFlushTimerRef.current);
    },
    [],
  );

  const load = useCallback(
    async (pageToken: string | undefined, append: boolean): Promise<void> => {
      const seq = ++seqRef.current;
      const cacheKey = `${source}|${debouncedKeyword}`;
      if (append) {
        setLoadingMore(true);
      } else {
        const cached = listCache.get(cacheKey);
        if (cached && Date.now() - cached.at < LIST_CACHE_MS) {
          // 命中缓存：立即渲染，同时后台静默刷新
          setItems(cached.items);
          setNextToken(cached.nextToken);
          setLoading(false);
        } else {
          setItems([]);
          setNextToken(undefined);
          setLoading(true);
        }
        scrollRef.current?.scrollTo({ top: 0 });
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
        if (!append) {
          listCache.set(cacheKey, {
            items: res.items,
            nextToken: res.nextPageToken,
            at: Date.now(),
          });
        }
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

  // 安装进度事件（后端真实阶段 + npm/uv 日志）
  useEffect(() => {
    const unsub = wsClient.onMessage((msg) => {
      if (msg.type !== 'mcp.install-progress') return;
      const payload = msg.payload as Partial<McpInstallProgressEvent> | undefined;
      if (!payload || typeof payload.phase !== 'string') return;
      const phase = payload.phase as McpInstallPhase;
      if (!(phase in INSTALL_PHASE_RANK)) return;

      setInstallTask((prev) => {
        if (!prev) return prev;
        const matches =
          (typeof payload.server === 'string' && prev.name === payload.server) ||
          (payload.source === prev.source && payload.id === prev.id);
        if (!matches) return prev;
        const nextPhase =
          phase === 'error' || INSTALL_PHASE_RANK[phase] >= INSTALL_PHASE_RANK[prev.phase]
            ? phase
            : prev.phase;
        return {
          ...prev,
          phase: nextPhase,
          ...(typeof payload.detail === 'string' && payload.detail
            ? { detail: payload.detail }
            : {}),
          ...(typeof payload.downloaded === 'number'
            ? { downloaded: payload.downloaded }
            : {}),
        };
      });

      if (typeof payload.log === 'string' && payload.log) {
        // 用 source/id 匹配：API 返回前任务还没有本地服务器名，但 source/id 一开始就有
        pendingLogKeyRef.current = `${payload.source ?? ''}:${payload.id ?? ''}`;
        pendingLogsRef.current.push(...payload.log.split(/\r?\n/));
        if (pendingLogsRef.current.length > 200) {
          pendingLogsRef.current = pendingLogsRef.current.slice(-200);
        }
        scheduleLogFlush();
      }
    });
    return unsub;
  }, [scheduleLogFlush]);

  // 连接成功/失败：关闭对应弹窗并清理任务（失败时配置已写入，MCP 管理页可重试）
  useEffect(() => {
    const task = installTask;
    if (!task?.name) return;
    const server = servers.find((item) => item.name === task.name);
    if (!server) return;
    const closeCurrentDialog = detail?.source === task.source && detail.id === task.id;
    if (server.status === 'connecting' || server.status === 'disconnected') {
      sawNonConnectedRef.current = true;
      return;
    }
    // 重新配置时旧状态可能仍是 connected/error：需新连接已开始/完成，或超过 3s 兜底
    const newConnectionStarted =
      sawNonConnectedRef.current || task.phase === 'done' || Date.now() - task.startedAt > 3000;
    if (server.status === 'connected') {
      if (task.reconfiguring && !newConnectionStarted) return;
      if (handledTaskRef.current.has(task.key)) return;
      handledTaskRef.current.add(task.key);
      toast.success(t('plugins.mcpInstallSuccess', { name: task.name }));
      if (closeCurrentDialog) setDetailOpen(false);
      setInstallTask(null);
      return;
    }
    const newConnectionFailed =
      task.phase === 'error' ||
      sawNonConnectedRef.current ||
      Date.now() - task.startedAt > 3000;
    if (server.status === 'error' && server.lastError && newConnectionFailed) {
      if (handledTaskRef.current.has(task.key)) return;
      handledTaskRef.current.add(task.key);
      toast.warning(
        t('plugins.mcpInstallConnectFailed', { error: server.lastError }),
        { duration: 8000 },
      );
      if (closeCurrentDialog) setDetailOpen(false);
      setInstallTask(null);
    }
  }, [servers, installTask, detail, t]);

  /** 发起安装：写盘后立即返回；后续下载/安装/连接进度由 WS 驱动 */
  const startInstall = useCallback(
    async (payload: InstallPayload, marketDetail: McpMarketDetail): Promise<void> => {
      const key = `${payload.source}:${payload.id}`;
      pendingLogsRef.current = [];
      pendingLogKeyRef.current = key;
      handledTaskRef.current.clear();
      sawNonConnectedRef.current = false;
      setInstallTask({
        key,
        source: payload.source,
        id: payload.id,
        marketName: marketDetail.name,
        phase: 'prepare',
        log: [],
        downloaded: 0,
        startedAt: Date.now(),
        reconfiguring: payload.reconfiguring === true,
      });
      try {
        const result = await api.marketMcpInstall(payload);
        setInstallTask((prev) =>
          prev && prev.key === key ? { ...prev, name: result.name } : prev,
        );
        await reload();
      } catch (err) {
        setInstallTask(null);
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`${t('plugins.mcpInstallFailed')}${message ? `: ${message}` : ''}`);
        throw err;
      }
    },
    [reload, t],
  );

  const openInstall = useCallback(
    async (item: McpMarketItem, existingName?: string): Promise<void> => {
      const seq = ++detailSeqRef.current;
      const cacheKey = `${item.source}:${item.id}`;
      const cached = detailCacheRef.current.get(cacheKey);
      if (cached) {
        setDetail(cached);
        setInstalledName(existingName);
        setDetailOpen(true);
        return;
      }
      // 先打开弹窗展示加载态，详情返回后再渲染表单（避免点击后无反馈）
      setDetail(null);
      setInstalledName(existingName);
      setDetailOpen(true);
      setDetailLoadingId(item.id);
      try {
        const result = await api.marketMcpDetail(item.source, item.id);
        if (seq !== detailSeqRef.current) return;
        detailCacheRef.current.set(cacheKey, result);
        setDetail(result);
      } catch (err) {
        if (seq !== detailSeqRef.current) return;
        setDetailOpen(false);
        toast.error(
          `${t('plugins.mcpMarketLoadFailed')}${err instanceof Error ? `: ${err.message}` : ''}`,
        );
      } finally {
        if (seq === detailSeqRef.current) setDetailLoadingId(null);
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
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Card key={index} className="flex flex-row items-start gap-3 p-3">
                <div className="size-10 shrink-0 animate-pulse rounded-lg bg-muted" />
                <div className="flex min-w-0 flex-1 flex-col gap-2 py-0.5">
                  <div className="h-3.5 w-1/2 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-full animate-pulse rounded bg-muted/70" />
                  <div className="h-3 w-2/3 animate-pulse rounded bg-muted/70" />
                </div>
              </Card>
            ))}
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
                  {installing && installTask && (
                    <div className="flex flex-col gap-1 pt-0.5">
                      <div className="relative h-1 w-full overflow-hidden rounded-full bg-muted">
                        <span className="absolute inset-y-0 w-1/3 animate-[moss-running-bar_1.2s_ease-in-out_infinite] rounded-full bg-primary" />
                      </div>
                      <p className="truncate text-[11px] text-primary-strong">
                        {t(INSTALL_PHASE_KEYS[installTask.phase])}
                        {installTask.detail ? ` · ${installTask.detail}` : ''}
                        {installTask.downloaded > 0
                          ? ` · ${t('plugins.mcpInstallDownloaded', { count: installTask.downloaded })}`
                          : ''}
                      </p>
                    </div>
                  )}
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
                  disabled={busy}
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
  onInstall: (payload: InstallPayload, detail: McpMarketDetail) => Promise<void>;
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
  // 手动配置
  const [manualTransport, setManualTransport] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const [manualCommand, setManualCommand] = useState('');
  const [manualArgsText, setManualArgsText] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [manualEnvText, setManualEnvText] = useState('');
  const [manualHeadersText, setManualHeadersText] = useState('');
  const [elapsed, setElapsed] = useState(0);

  // 只展示当前弹窗条目对应的安装任务（避免上一个条目的进度串台）
  const activeTask = useMemo(
    () =>
      task && detail && task.key === `${detail.source}:${detail.id}` ? task : null,
    [task, detail],
  );
  const phase = activeTask?.phase;
  const phaseLabel = phase ? t(INSTALL_PHASE_KEYS[phase]) : '';

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
    setManualTransport(first?.transport ?? 'stdio');
    setManualCommand(first?.command ?? '');
    setManualArgsText((first?.args ?? []).join(' '));
    setManualUrl(first?.url ?? '');
    setManualEnvText(first?.kind === 'manual' ? manualEnvSeed(first) : '');
    setManualHeadersText(
      first?.headerTemplates
        ? Object.entries(first.headerTemplates)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n')
        : '',
    );
    setElapsed(0);
  }, [open, detail, installedName]);

  const option = useMemo(
    () =>
      detail?.installOptions.find((item) => item.index === optionIndex) ??
      detail?.installOptions.find((item) => item.supported) ??
      detail?.installOptions[0],
    [detail, optionIndex],
  );
  const isManualOption = option?.kind === 'manual';

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
      if (next?.kind === 'manual') {
        setManualTransport(next.transport);
        setManualCommand(next.command ?? '');
        setManualArgsText((next.args ?? []).join(' '));
        setManualUrl(next.url ?? '');
        setManualEnvText(manualEnvSeed(next));
        setManualHeadersText(
          next.headerTemplates
            ? Object.entries(next.headerTemplates)
                .map(([key, value]) => `${key}: ${value}`)
                .join('\n')
            : '',
        );
      }
    },
    [detail],
  );

  const manualEnvParsed = useMemo(
    () => parseKeyValueLines(manualEnvText, '=', /^[A-Za-z_][A-Za-z0-9_]*$/),
    [manualEnvText],
  );
  const manualHeadersParsed = useMemo(
    () => parseKeyValueLines(manualHeadersText, ':', /^[A-Za-z0-9-]+$/),
    [manualHeadersText],
  );
  const manualLinesInvalid =
    isManualOption &&
    (manualTransport === 'stdio'
      ? manualEnvParsed.invalid.length > 0
      : manualHeadersParsed.invalid.length > 0);
  const manualRequiredMissing =
    isManualOption && manualTransport === 'stdio'
      ? (option?.env ?? [])
          .filter(
            (field) =>
              field.required &&
              field.fixedValue === undefined &&
              !(manualEnvParsed.values[field.name] ?? '').trim(),
          )
          .map((field) => field.name)
      : [];
  const manualValid =
    !isManualOption ||
    (manualTransport === 'stdio'
      ? manualCommand.trim().length > 0 && manualRequiredMissing.length === 0
      : /^https?:\/\//i.test(manualUrl.trim()));

  const preview = useMemo(() => {
    if (isManualOption) {
      return buildManualPreview({
        name,
        transport: manualTransport,
        command: manualCommand,
        argsText: manualArgsText,
        url: manualUrl,
        envText: manualEnvText,
        headersText: manualHeadersText,
      });
    }
    return buildPreview(option, name, envValues);
  }, [
    isManualOption,
    name,
    manualTransport,
    manualCommand,
    manualArgsText,
    manualUrl,
    manualEnvText,
    manualHeadersText,
    option,
    envValues,
  ]);

  const requiredMissing = !isManualOption &&
    requiredFields.some((field) => !(envValues[field.name] ?? '').trim());
  const nameValid = SERVER_NAME_RE.test(name);
  const disabled =
    busy ||
    !option?.supported ||
    requiredMissing ||
    !nameValid ||
    Boolean(activeTask) ||
    !manualValid ||
    manualLinesInvalid;

  // 安装中每秒刷新用时（阶段结束即停止）
  useEffect(() => {
    if (!activeTask || activeTask.phase === 'done' || activeTask.phase === 'error') {
      setElapsed(0);
      return;
    }
    const update = (): void =>
      setElapsed(Math.max(0, Math.floor((Date.now() - activeTask.startedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [activeTask?.key, activeTask?.startedAt, activeTask?.phase]);

  // 日志自动滚到底
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeTask?.log]);

  const copyPreview = useCallback(async (): Promise<void> => {
    if (await copyText(preview)) toast.success(t('plugins.mcpInstallCopied'));
    else toast.error(t('common.copyManualHint'));
  }, [preview, t]);

  const submit = useCallback(async (): Promise<void> => {
    if (!detail || !option || busy || activeTask) return;
    if (isManualOption) {
      if (!manualValid || manualLinesInvalid) {
        setError(t('plugins.mcpInstallManualInvalid'));
        return;
      }
    } else {
      const missingNow = requiredFields
        .filter((field) => !(envValues[field.name] ?? '').trim())
        .map((field) => field.name);
      if (missingNow.length > 0) {
        setMissing(missingNow);
        setError(t('plugins.mcpInstallMissingEnv'));
        return;
      }
    }
    if (!SERVER_NAME_RE.test(name)) {
      setError(t('plugins.mcpInstallNameInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload: InstallPayload = isManualOption
        ? {
            source: detail.source,
            id: detail.id,
            optionIndex: option.index,
            name,
            reconfiguring: Boolean(installedName),
            manual: {
              transport: manualTransport,
              ...(manualTransport === 'stdio'
                ? {
                    command: manualCommand.trim(),
                    ...(manualArgsText.trim()
                      ? { args: manualArgsText.trim().split(/\s+/).filter(Boolean) }
                      : {}),
                    ...(Object.keys(manualEnvParsed.values).length > 0
                      ? { env: manualEnvParsed.values }
                      : {}),
                  }
                : {
                    url: manualUrl.trim(),
                    ...(Object.keys(manualHeadersParsed.values).length > 0
                      ? { headers: manualHeadersParsed.values }
                      : {}),
                  }),
            },
          }
        : {
            source: detail.source,
            id: detail.id,
            optionIndex: option.index,
            env: envValues,
            name,
            reconfiguring: Boolean(installedName),
          };
      // 安装任务由页面层托管：弹窗保持打开展示真实进度，可随时关闭
      await onInstall(payload, detail);
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
  }, [
    detail,
    option,
    busy,
    activeTask,
    isManualOption,
    manualValid,
    manualLinesInvalid,
    requiredFields,
    envValues,
    name,
    manualTransport,
    manualCommand,
    manualArgsText,
    manualEnvParsed,
    manualUrl,
    manualHeadersParsed,
    installedName,
    onInstall,
    t,
  ]);

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
                <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate font-medium text-foreground">
                      {phaseLabel}
                      {activeTask.detail ? ` · ${activeTask.detail}` : ''}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {t('plugins.mcpInstallElapsed', { seconds: elapsed })}
                    </span>
                  </div>
                  <div className="relative h-1 w-full overflow-hidden rounded-full bg-muted">
                    {phase === 'done' ? (
                      <span className="absolute inset-0 rounded-full bg-success" />
                    ) : (
                      <span
                        className={cn(
                          'absolute inset-y-0 w-1/3 animate-[moss-running-bar_1.2s_ease-in-out_infinite] rounded-full',
                          phase === 'error' ? 'bg-destructive' : 'bg-primary',
                        )}
                      />
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    {activeTask.downloaded > 0 && (
                      <span>
                        {t('plugins.mcpInstallDownloaded', { count: activeTask.downloaded })}
                      </span>
                    )}
                    <span>{t('plugins.mcpInstallBackgroundHint')}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-foreground">
                      {t('plugins.mcpInstallLog')}
                    </span>
                    <div
                      ref={logRef}
                      className="max-h-40 overflow-auto rounded-md border border-border bg-background/60 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground"
                    >
                      {activeTask.log.length === 0 ? (
                        <span>{t('plugins.mcpInstallLogWaiting')}</span>
                      ) : (
                        activeTask.log.map((line, index) => (
                          <div key={index} className="whitespace-pre-wrap break-all">
                            {line}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
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

              {isManualOption ? (
                <section className="flex flex-col gap-3">
                  <h4 className="text-sm font-medium text-foreground">
                    {t('plugins.mcpInstallManual')}
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    {t('plugins.mcpInstallManualHint')}
                  </p>
                  {detail.readme && (
                    <details className="rounded-lg border border-border px-3 py-2">
                      <summary className="cursor-pointer text-xs font-medium text-foreground">
                        {t('plugins.mcpInstallReadme')}
                      </summary>
                      <div className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                        {detail.readme}
                      </div>
                    </details>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs">{t('plugins.mcpInstallManualTransport')}</Label>
                    <Select
                      value={manualTransport}
                      onValueChange={(value) =>
                        setManualTransport(value as 'stdio' | 'http' | 'sse')
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="stdio">stdio</SelectItem>
                        <SelectItem value="http">http</SelectItem>
                        <SelectItem value="sse">sse</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {manualTransport === 'stdio' ? (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="mcp-manual-command" className="text-xs">
                          {t('plugins.mcpInstallManualCommand')}
                        </Label>
                        <Input
                          id="mcp-manual-command"
                          value={manualCommand}
                          onChange={(e) => setManualCommand(e.target.value)}
                          placeholder="npx"
                          className="font-mono text-xs"
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="mcp-manual-args" className="text-xs">
                          {t('plugins.mcpInstallManualArgs')}
                        </Label>
                        <Input
                          id="mcp-manual-args"
                          value={manualArgsText}
                          onChange={(e) => setManualArgsText(e.target.value)}
                          placeholder="-y @scope/mcp-server@1.0.0"
                          className="font-mono text-xs"
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="mcp-manual-env" className="text-xs">
                          {t('plugins.mcpInstallManualEnv')}
                        </Label>
                        <Textarea
                          id="mcp-manual-env"
                          value={manualEnvText}
                          onChange={(e) => setManualEnvText(e.target.value)}
                          placeholder={'API_KEY=...\nLOG_LEVEL=info'}
                          className="min-h-24 font-mono text-xs"
                        />
                        {manualEnvParsed.invalid.length > 0 && (
                          <p className="text-[11px] text-destructive">
                            {t('plugins.mcpInstallManualInvalid')}：{manualEnvParsed.invalid.join('; ')}
                          </p>
                        )}
                        {manualRequiredMissing.length > 0 && (
                          <p className="text-[11px] text-destructive">
                            {t('plugins.mcpInstallMissingEnv')}：{manualRequiredMissing.join(', ')}
                          </p>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="mcp-manual-url" className="text-xs">
                          {t('plugins.mcpInstallManualUrl')}
                        </Label>
                        <Input
                          id="mcp-manual-url"
                          value={manualUrl}
                          onChange={(e) => setManualUrl(e.target.value)}
                          placeholder="https://mcp.example.com/mcp"
                          className="font-mono text-xs"
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="mcp-manual-headers" className="text-xs">
                          {t('plugins.mcpInstallManualHeaders')}
                        </Label>
                        <Textarea
                          id="mcp-manual-headers"
                          value={manualHeadersText}
                          onChange={(e) => setManualHeadersText(e.target.value)}
                          placeholder={'Authorization: Bearer ...'}
                          className="min-h-24 font-mono text-xs"
                        />
                        {manualHeadersParsed.invalid.length > 0 && (
                          <p className="text-[11px] text-destructive">
                            {t('plugins.mcpInstallManualInvalid')}：{manualHeadersParsed.invalid.join('; ')}
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </section>
              ) : (
                <>
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
                </>
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
            {(busy || activeTask) && <Loader2 className="size-3.5 animate-spin" />}
            {busy || activeTask
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
