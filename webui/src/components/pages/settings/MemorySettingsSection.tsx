// webui/src/components/pages/settings/MemorySettingsSection.tsx
// 记忆引擎设置分区（嵌入 /settings/context/memory Tab）：
// 配置区（启停/蒸馏模型/召回参数/L1）+ 宫殿浏览（wing/room 过滤）+ 记忆卡片列表 + 新建/编辑/删除/置顶。

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, RefreshCw, Pencil, Trash2, Loader2, Pin, PinOff, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { useConfig } from '@/hooks/useConfig';
import { api } from '@/api/http';
import { useStore } from '@/store';
import type { MemoryHall, MemoryItem, MemoryPalaceTree, MemoryUpsertBody } from '@/types/api';

const MEMORY_HALLS: MemoryHall[] = ['decision', 'event', 'discovery', 'preference', 'suggestion'];

const HALL_LABEL_KEYS: Record<MemoryHall, string> = {
  decision: 'settings.memory.hallDecision',
  event: 'settings.memory.hallEvent',
  discovery: 'settings.memory.hallDiscovery',
  preference: 'settings.memory.hallPreference',
  suggestion: 'settings.memory.hallSuggestion',
};

interface MemoryForm {
  wing: string;
  room: string;
  hall: MemoryHall;
  verbatim: string;
  insight: string;
  tagsText: string;
  importance: number;
}

const EMPTY_FORM: MemoryForm = {
  wing: '',
  room: '',
  hall: 'discovery',
  verbatim: '',
  insight: '',
  tagsText: '',
  importance: 0.5,
};

export function MemorySettingsSection() {
  const { t } = useTranslation();
  const { appConfig, apiConfig, updateAppConfig } = useConfig();
  const context = appConfig?.context;
  const memoryConfig =
    context?.memory ?? {
      enabled: true,
      distillModel: 'inherit',
      distillMinMessages: 6,
      recallTopK: 5,
      recallTokenBudget: 2000,
      l1ImportanceThreshold: 0.75,
      l1MaxEntries: 20,
    };
  const models = apiConfig?.providers.flatMap(p => p.models) ?? [];
  // 当前工作目录：记忆按任务 cwd 分项目落盘，列表/宫殿树需带 cwd 才能读到项目翼记忆
  const cwd = useStore((s) => s.workingDirectory);

  const [loading, setLoading] = useState(true);
  const [tree, setTree] = useState<MemoryPalaceTree | null>(null);
  const [items, setItems] = useState<MemoryItem[]>([]);

  const [query, setQuery] = useState('');
  const [wingFilter, setWingFilter] = useState<string>('all');
  const [roomFilter, setRoomFilter] = useState<string>('all');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<MemoryForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [treeResult, listResult] = await Promise.all([
        api.getMemoryTree(cwd),
        api.listMemory({
          cwd,
          ...(wingFilter !== 'all' ? { wing: wingFilter } : {}),
          ...(roomFilter !== 'all' ? { room: roomFilter } : {}),
          ...(query.trim() ? { q: query.trim() } : {}),
          limit: 200,
        }),
      ]);
      setTree(treeResult);
      setItems(listResult.items);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.memory.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [wingFilter, roomFilter, query, t, cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const patchMemory = (patch: Partial<typeof memoryConfig>) => {
    if (!context) return;
    void updateAppConfig({ context: { ...context, memory: { ...memoryConfig, ...patch } } }).catch(() => {
      // toast 已在 useConfig 内处理
    });
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, wing: wingFilter !== 'all' ? wingFilter : '' });
    setDialogOpen(true);
  };

  const openEdit = (m: MemoryItem) => {
    setEditingId(m.id);
    setForm({
      wing: m.wing,
      room: m.room,
      hall: m.hall,
      verbatim: m.verbatim,
      insight: m.insight,
      tagsText: m.tags.join(', '),
      importance: m.importance,
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.room.trim() || !form.insight.trim() || saving) return;
    setSaving(true);
    try {
      const tags = form.tagsText
        .split(',')
        .map(t => t.trim())
        .filter(t => t !== '');
      const body: MemoryUpsertBody = {
        ...(form.wing.trim() ? { wing: form.wing.trim() } : {}),
        room: form.room.trim(),
        hall: form.hall,
        ...(form.verbatim.trim() ? { verbatim: form.verbatim } : {}),
        insight: form.insight.trim(),
        tags,
        importance: form.importance,
      };
      if (editingId) {
        await api.updateMemory(editingId, body);
        toast.success(t('settings.memory.updated'));
      } else {
        await api.createMemory(body);
        toast.success(t('settings.memory.created'));
      }
      setDialogOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.memory.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (m: MemoryItem) => {
    if (deleting) return;
    if (!window.confirm(t('settings.memory.deleteConfirm'))) return;
    setDeleting(m.id);
    try {
      await api.deleteMemory(m.id);
      toast.success(t('settings.memory.deleted'));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.memory.deleteFailed'));
    } finally {
      setDeleting(null);
    }
  };

  const togglePinned = async (m: MemoryItem, pinned: boolean) => {
    try {
      await api.updateMemory(m.id, { pinned });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.memory.saveFailed'));
    }
  };

  const rooms = tree?.wings.find(w => w.wing === wingFilter)?.rooms ?? [];
  const allRooms = [...new Set((tree?.wings ?? []).flatMap(w => w.rooms.map(r => r.room)))].sort();

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* 引擎配置 */}
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-foreground">{t('settings.memory.engineTitle')}</div>
        <div className="text-xs text-muted-foreground">{t('settings.memory.engineDesc')}</div>
        <div className="mt-2 flex flex-col rounded-lg border border-border px-4">
          <div className="flex flex-col gap-2 border-b border-border/60 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('common.enable')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.memory.enabledDesc')}</span>
            </div>
            <Switch checked={memoryConfig.enabled} onCheckedChange={(v) => patchMemory({ enabled: v })} />
          </div>
          <div className="flex flex-col gap-2 border-b border-border/60 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.memory.distillModel')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.memory.distillModelDesc')}</span>
            </div>
            <Select
              value={memoryConfig.distillModel}
              onValueChange={(v) => patchMemory({ distillModel: v })}
            >
              <SelectTrigger className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">{t('settings.memory.modelInherit')}</SelectItem>
                {models.map(m => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2 border-b border-border/60 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.memory.distillMinMessages')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.memory.distillMinMessagesDesc')}</span>
            </div>
            <Input
              type="number"
              min={1}
              max={100}
              className="w-24"
              value={memoryConfig.distillMinMessages}
              onChange={(e) => patchMemory({ distillMinMessages: Number(e.target.value) || 6 })}
            />
          </div>
          <div className="flex flex-col gap-2 border-b border-border/60 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.memory.recallTopK')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.memory.recallTopKDesc')}</span>
            </div>
            <Input
              type="number"
              min={1}
              max={50}
              className="w-24"
              value={memoryConfig.recallTopK}
              onChange={(e) => patchMemory({ recallTopK: Number(e.target.value) || 5 })}
            />
          </div>
          <div className="flex flex-col gap-2 border-b border-border/60 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.memory.recallTokenBudget')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.memory.recallTokenBudgetDesc')}</span>
            </div>
            <Input
              type="number"
              min={200}
              max={20000}
              className="w-28"
              value={memoryConfig.recallTokenBudget}
              onChange={(e) => patchMemory({ recallTokenBudget: Number(e.target.value) || 2000 })}
            />
          </div>
          <div className="flex flex-col gap-2 border-b border-border/60 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.memory.l1Threshold')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.memory.l1ThresholdDesc')}</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={memoryConfig.l1ImportanceThreshold}
                onChange={(e) => patchMemory({ l1ImportanceThreshold: Number(e.target.value) })}
                className="w-32"
              />
              <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
                {memoryConfig.l1ImportanceThreshold.toFixed(2)}
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.memory.l1MaxEntries')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.memory.l1MaxEntriesDesc')}</span>
            </div>
            <Input
              type="number"
              min={1}
              max={100}
              className="w-24"
              value={memoryConfig.l1MaxEntries}
              onChange={(e) => patchMemory({ l1MaxEntries: Number(e.target.value) || 20 })}
            />
          </div>
        </div>
      </div>

      {/* 记忆列表 */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm font-medium text-foreground">{t('settings.memory.listTitle')}</div>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon-sm" title={t('common.refresh')} onClick={() => void load()}>
              <RefreshCw className="size-3.5" />
            </Button>
            <Button className="gap-1.5" onClick={openCreate}>
              <Plus className="size-3.5" />
              <span className="hidden sm:inline">{t('settings.memory.create')}</span>
            </Button>
          </div>
        </div>

        {/* 过滤器：搜索 + wing + room */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder={t('settings.memory.searchPlaceholder')}
              className="pl-8"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Select value={wingFilter} onValueChange={(v) => { setWingFilter(v); setRoomFilter('all'); }}>
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('settings.memory.allWings')}</SelectItem>
              {(tree?.wings ?? []).map(w => (
                <SelectItem key={w.wing} value={w.wing}>
                  {w.wing}（{w.total}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={roomFilter} onValueChange={setRoomFilter}>
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('settings.memory.allRooms')}</SelectItem>
              {(wingFilter !== 'all' ? rooms.map(r => r.room) : allRooms).map(room => (
                <SelectItem key={room} value={room}>
                  {room}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-border px-4 py-8 text-center text-xs text-muted-foreground">
            {t('settings.memory.empty')}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {items.map(m => (
              <div key={m.id} className="flex flex-col gap-2 rounded-lg border border-border px-4 py-3">
                <div className="flex items-start gap-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary" className="text-[10px]">
                        {m.wing}/{m.room}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {t(HALL_LABEL_KEYS[m.hall])}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] tabular-nums">
                        ★{m.importance.toFixed(2)}
                      </Badge>
                      {m.tags.map(tag => (
                        <Badge key={tag} variant="outline" className="text-[10px] text-muted-foreground">
                          #{tag}
                        </Badge>
                      ))}
                    </div>
                    <span className="text-sm text-foreground">{m.insight}</span>
                    {m.verbatim ? (
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer select-none">
                          {t('settings.memory.verbatimToggle')}
                        </summary>
                        <p className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-2">
                          {m.verbatim}
                        </p>
                      </details>
                    ) : null}
                    <span className="text-[11px] text-muted-foreground">
                      {t('settings.memory.sourceAt')}: {new Date(m.source.at).toLocaleString()}
                      {m.source.sessionId ? ` · session ${m.source.sessionId.slice(0, 8)}` : ''}
                      {` · ${t('settings.memory.accessCount')}: ${m.accessCount}`}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={m.pinned ? t('settings.memory.unpin') : t('settings.memory.pin')}
                      onClick={() => void togglePinned(m, !m.pinned)}
                    >
                      {m.pinned ? (
                        <Pin className="size-3.5 text-primary" />
                      ) : (
                        <PinOff className="size-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={t('common.edit')}
                      onClick={() => openEdit(m)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={t('common.delete')}
                      disabled={deleting === m.id}
                      onClick={() => void remove(m)}
                    >
                      {deleting === m.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 新建/编辑弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={(o) => !saving && setDialogOpen(o)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {editingId ? t('settings.memory.editTitle') : t('settings.memory.createTitle')}
            </DialogTitle>
            <DialogDescription>{t('settings.memory.formDesc')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="mem-room">{t('settings.memory.roomLabel')}</Label>
                  <Input
                    id="mem-room"
                    value={form.room}
                    onChange={(e) => setForm(f => ({ ...f, room: e.target.value }))}
                    placeholder={t('settings.memory.roomPlaceholder')}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="mem-hall">{t('settings.memory.hallLabel')}</Label>
                  <Select
                    value={form.hall}
                    onValueChange={(v) => setForm(f => ({ ...f, hall: v as MemoryHall }))}
                  >
                    <SelectTrigger id="mem-hall">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MEMORY_HALLS.map(h => (
                        <SelectItem key={h} value={h}>
                          {t(HALL_LABEL_KEYS[h])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="mem-wing">{t('settings.memory.wingLabel')}</Label>
                  <Input
                    id="mem-wing"
                    value={form.wing}
                    onChange={(e) => setForm(f => ({ ...f, wing: e.target.value }))}
                    placeholder={t('settings.memory.wingPlaceholder')}
                    className="font-mono text-xs"
                  />
                  <span className="text-xs text-muted-foreground">{t('settings.memory.wingHint')}</span>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="mem-importance">{t('settings.memory.importanceLabel')}</Label>
                  <div className="flex items-center gap-2 pt-2">
                    <input
                      id="mem-importance"
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={form.importance}
                      onChange={(e) => setForm(f => ({ ...f, importance: Number(e.target.value) }))}
                      className="flex-1"
                    />
                    <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
                      {form.importance.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mem-insight">{t('settings.memory.insightLabel')}</Label>
                <Textarea
                  id="mem-insight"
                  rows={3}
                  value={form.insight}
                  onChange={(e) => setForm(f => ({ ...f, insight: e.target.value }))}
                  placeholder={t('settings.memory.insightPlaceholder')}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mem-verbatim">{t('settings.memory.verbatimLabel')}</Label>
                <Textarea
                  id="mem-verbatim"
                  rows={3}
                  value={form.verbatim}
                  onChange={(e) => setForm(f => ({ ...f, verbatim: e.target.value }))}
                  placeholder={t('settings.memory.verbatimPlaceholder')}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mem-tags">{t('settings.memory.tagsLabel')}</Label>
                <Input
                  id="mem-tags"
                  value={form.tagsText}
                  onChange={(e) => setForm(f => ({ ...f, tagsText: e.target.value }))}
                  placeholder={t('settings.memory.tagsPlaceholder')}
                />
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => void save()}
              disabled={saving || !form.room.trim() || !form.insight.trim()}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {editingId ? t('common.save') : t('settings.memory.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
