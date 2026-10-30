// webui/src/components/pages/SkillMarketPage.tsx
// 插件库主页：SkillHub 技能市场
// 分类筛选 + 关键词搜索 + 分页加载 + 一键安装（后端下载 zip 写入本地并启用）
// 已安装技能显示“使用”：跳转任务页并把 /skill:<name> 填入输入框

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, Download, Loader2, Search, SlidersHorizontal, WandSparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useSkills } from '../../hooks/useSkills';
import { useStore } from '../../store';
import { api } from '../../api/http';
import type { MarketCategoryItem, MarketSkillItem } from '../../types/api';

const PAGE_SIZE = 24;

/** 卡片图标：SkillHub iconUrl，缺失或加载失败时回退技能名首字符 */
function SkillIcon({ item }: { item: MarketSkillItem }) {
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
        <span className="text-sm font-medium text-muted-foreground">{item.name.slice(0, 1)}</span>
      )}
    </div>
  );
}

export function SkillMarketPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { skills, reload: reloadSkills } = useSkills();

  const [categories, setCategories] = useState<MarketCategoryItem[]>([]);
  const [category, setCategory] = useState('');
  const [keyword, setKeyword] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [items, setItems] = useState<MarketSkillItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  // 安装成功后的本地乐观集合（WS 热重载刷新前也能立刻显示“使用”）
  const [installedLocal, setInstalledLocal] = useState<Set<string>>(new Set());
  /** 请求序号：筛选条件快速切换时丢弃过期响应 */
  const seqRef = useRef(0);
  /** 已展示的技能指纹（跨页去重交给后端过滤） */
  const excludeRef = useRef<Set<string>>(new Set());

  // 分类（失败静默：仍可只看“全部”）
  useEffect(() => {
    api
      .marketCategories()
      .then((res) => setCategories(res.categories))
      .catch(() => {});
  }, []);

  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword.trim()), 300);
    return () => clearTimeout(timer);
  }, [keyword]);

  const load = useCallback(
    async (nextPage: number): Promise<void> => {
      const seq = ++seqRef.current;
      // 新筛选条件从第一页开始：已展示名单同时重置
      if (nextPage === 1) excludeRef.current = new Set();
      setLoading(true);
      setError(false);
      try {
        const res = await api.marketSkills({
          page: nextPage,
          pageSize: PAGE_SIZE,
          keyword: debouncedKeyword,
          category: category,
          exclude: Array.from(excludeRef.current),
        });
        if (seq !== seqRef.current) return;
        for (const item of res.skills) excludeRef.current.add(item.dedupeKey);
        setItems((prev) => (nextPage === 1 ? res.skills : [...prev, ...res.skills]));
        setTotal(res.total);
        setPage(nextPage);
      } catch {
        if (seq === seqRef.current) setError(true);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [debouncedKeyword, category],
  );

  // 分类/关键词变化 → 回到第一页重新加载
  useEffect(() => {
    void load(1);
  }, [load]);

  /** 列表滚动容器：距底部 300px 内自动加载下一页 */
  const scrollRef = useRef<HTMLDivElement>(null);
  const handleScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el || loading || items.length >= total) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) void load(page + 1);
  }, [loading, items.length, total, page, load]);

  // 内容不足一屏时自动补齐（否则无法滚动，也就无法触发下一页）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || loading || items.length >= total) return;
    if (el.scrollHeight - el.clientHeight < 300) void load(page + 1);
  }, [items.length, loading, total, page, load]);

  const installedNames = useMemo(() => {
    const set = new Set(skills.map((s) => s.name));
    installedLocal.forEach((n) => set.add(n));
    return set;
  }, [skills, installedLocal]);

  const install = useCallback(
    async (item: MarketSkillItem): Promise<void> => {
      setInstalling(item.canonicalName);
      try {
        const res = await api.installMarketSkill(item.canonicalName);
        setInstalledLocal((prev) => new Set(prev).add(res.name));
        toast.success(t('plugins.marketInstallSuccess', { name: item.name }));
        void reloadSkills();
      } catch (err) {
        toast.error(
          `${t('plugins.marketInstallFailed')}${err instanceof Error ? `：${err.message}` : ''}`,
        );
      } finally {
        setInstalling(null);
      }
    },
    [reloadSkills, t],
  );

  const useSkill = useCallback(
    (item: MarketSkillItem): void => {
      // 与发送框 / 菜单线格式一致：/<技能名>（/skill:<name> 不会被菜单识别）
      useStore.getState().injectComposer(`/${item.installName}`);
      navigate('/task');
    },
    [navigate],
  );

  // 按分类顺序分组（未知分类归“其他”，排最后）
  const groups = useMemo(() => {
    const order = new Map(categories.map((c, i) => [c.key, i]));
    const names = new Map(categories.map((c) => [c.key, c.name]));
    const buckets = new Map<string, MarketSkillItem[]>();
    for (const item of items) {
      const list = buckets.get(item.category);
      if (list) list.push(item);
      else buckets.set(item.category, [item]);
    }
    return Array.from(buckets.entries())
      .sort(([a], [b]) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER))
      .map(([key, list]) => ({
        key,
        title: names.get(key) ?? t('plugins.marketGroupOther'),
        list,
      }));
  }, [items, categories, t]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 桌面标题区（移动端由全局 header 承载标题与管理入口） */}
      <div className="hidden items-center justify-between gap-4 px-6 py-4 md:flex">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">{t('plugins.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('plugins.marketSubtitle')}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1"
          onClick={() => navigate('/plugins/skills')}
        >
          <SlidersHorizontal className="size-3.5" />
          {t('plugins.manage')}
        </Button>
      </div>

      {/* 技能标签 + 搜索（不含“上传技能”） */}
      <div className="flex flex-col gap-3 px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1.5 text-sm font-medium text-foreground">
            <WandSparkles className="size-3.5" />
            {t('plugins.marketSkillsTab')}
          </span>
        </div>
        <div className="relative w-full sm:w-80 sm:shrink-0">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder={t('plugins.marketSearchPlaceholder')}
            className="pl-8"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
      </div>

      {/* 分类 Chips（SkillHub 场景分类） */}
      <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
        <Button
          variant={category === '' ? 'secondary' : 'outline'}
          size="sm"
          className="h-7 rounded-lg px-2.5 text-xs"
          onClick={() => setCategory('')}
        >
          {t('plugins.marketAll')}
        </Button>
        {categories.map((c) => (
          <Button
            key={c.key}
            variant={category === c.key ? 'secondary' : 'outline'}
            size="sm"
            className="h-7 rounded-lg px-2.5 text-xs"
            onClick={() => setCategory(c.key)}
          >
            {c.name}
          </Button>
        ))}
      </div>

      {/* 列表（滚动到底自动加载下一页） */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-auto px-6 pb-6">
        {loading && items.length === 0 && (
          <div className="flex justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && items.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-12 text-sm text-muted-foreground">
            <span>{t('plugins.marketLoadFailed')}</span>
            <Button variant="outline" size="sm" onClick={() => void load(1)}>
              {t('plugins.marketRetry')}
            </Button>
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t('plugins.marketEmpty')}
          </div>
        )}

        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.key} className="flex flex-col gap-2">
              <h2 className="text-sm font-medium text-foreground">{group.title}</h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {group.list.map((item) => {
                  const installed = installedNames.has(item.installName);
                  const busy = installing === item.canonicalName;
                  return (
                    <Card key={item.canonicalName} className="flex flex-row items-center gap-3 p-3">
                      <SkillIcon item={item} />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <h3 className="truncate text-sm font-medium text-foreground">{item.name}</h3>
                        <p className="line-clamp-2 text-xs text-muted-foreground">
                          {item.description || item.subCategory}
                        </p>
                      </div>
                      {installed ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0 gap-1"
                          onClick={() => useSkill(item)}
                        >
                          <ArrowRight className="size-3.5" />
                          {t('plugins.marketUse')}
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0 gap-1"
                          disabled={busy}
                          onClick={() => void install(item)}
                        >
                          {busy ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Download className="size-3.5" />
                          )}
                          {busy ? t('plugins.marketInstalling') : t('plugins.marketInstall')}
                        </Button>
                      )}
                    </Card>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        {loading && items.length > 0 && (
          <div className="flex justify-center py-4">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    </div>
  );
}
