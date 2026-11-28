// webui/src/components/pages/McpMarketPage.tsx
// MCP 市场：源切换（mcpmarket / official / modelscope）+ 搜索 + 无限滚动。
// 点击卡片进入市场详情页；「安装 / 重新配置」按钮打开弹窗快速安装。

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Cable, Download, Eye, Loader2, RefreshCw, Settings2, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useMcp } from '../../hooks/useMcp';
import { useMcpInstallTask } from '../../hooks/useMcpInstallTask';
import { api } from '../../api/http';
import { RunningBar } from '../shared/RunningBar';
import { PluginIcon } from '../shared/PluginIcon';
import { INSTALL_PHASE_KEYS, McpInstallDialog } from '../shared/McpInstallForm';
import type { McpMarketDetail, McpMarketItem, McpMarketSource } from '../../types/api';

const PAGE_SIZE = 24;
const SOURCE_STORAGE_KEY = 'moss.mcpMarketSource';
/** 列表缓存时长（切换 tab / 源后立即恢复） */
const LIST_CACHE_MS = 60_000;

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

export function McpMarketPage({
  keyword,
  onKeywordChange,
}: {
  keyword: string;
  onKeywordChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
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

  // 安装任务：成功/失败后关闭快速安装弹窗（详情页使用同一 hook 的独立实例）
  const { installTask, startInstall } = useMcpInstallTask({
    servers,
    reload,
    onFinished: () => setDetailOpen(false),
  });

  /** 请求序号：源/关键词快速切换时丢弃过期响应 */
  const seqRef = useRef(0);
  /** 详情请求序号：快速点击不同卡片时丢弃过期响应 */
  const detailSeqRef = useRef(0);
  /** 详情缓存：再次点击同一卡片直接打开 */
  const detailCacheRef = useRef(new Map<string, McpMarketDetail>());

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

  const openDetailPage = useCallback(
    (item: McpMarketItem): void => {
      const params = new URLSearchParams({
        type: 'mcp',
        from: 'market',
        source: item.source,
        id: item.id,
      });
      navigate(`/plugins/detail?${params.toString()}`, { state: { marketItem: item } });
    },
    [navigate],
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
              <Card
                key={`${item.source}:${item.id}`}
                role="button"
                tabIndex={0}
                className="flex cursor-pointer flex-row items-start gap-3 p-3 transition-colors hover:bg-muted/40"
                onClick={() => openDetailPage(item)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  openDetailPage(item);
                }}
              >
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
                <div onClick={(e) => e.stopPropagation()}>
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
                </div>
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
