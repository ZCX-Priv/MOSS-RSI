// webui/src/components/pages/PluginDetailPage.tsx
// 插件详情页：已安装技能 / 已安装 MCP / 市场技能 / 市场 MCP（统一路由 + query 区分）。
//   /plugins/detail?type=skill|mcp&from=installed|market&id=...
// 市场 MCP 内嵌安装表单（与市场列表的快速安装共用 useMcpInstallTask）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft, Cable, ChevronRight, Copy, Download, ExternalLink, Folder, Loader2, PlugZap, Trash2, Unplug,
  WandSparkles, Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { FileTypeIcon } from '../shared/FileTypeIcon';
import { PluginIcon } from '../shared/PluginIcon';
import { McpInstallForm } from '../shared/McpInstallForm';
import { SKILL_ICON_MAP } from './PluginMarketPage';
import { MarkdownRenderer } from '@/render';
import { cn, formatFileSize } from '@/lib/utils';
import { useSkills } from '../../hooks/useSkills';
import { useMcp } from '../../hooks/useMcp';
import { useMcpInstallTask } from '../../hooks/useMcpInstallTask';
import { useStore } from '../../store';
import { api } from '../../api/http';
import { wsClient } from '../../api/ws';
import { copyText } from '../../lib/clipboard';
import type {
  MarketSkillContent,
  MarketSkillItem,
  McpMarketDetail,
  McpMarketItem,
  McpMarketSource,
  McpServer,
  McpTool,
  SkillDetail,
} from '../../types/api';

/** 市场 MCP 来源白名单 */
function readSource(raw: string | null): McpMarketSource {
  return raw === 'official' || raw === 'modelscope' ? raw : 'mcpmarket';
}

function CopyLine({ text, label }: { text: string; label?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5">
      {label && <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>}
      <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-foreground">{text}</code>
      <Button
        variant="ghost"
        size="icon-xs"
        title={t('plugins.detailCopyConfig')}
        aria-label={t('plugins.detailCopyConfig')}
        onClick={() => {
          void copyText(text).then((ok) => {
            if (ok) toast.success(t('plugins.detailConfigCopied'));
            else toast.error(t('common.copyManualHint'));
          });
        }}
      >
        <Copy className="size-3.5" />
      </Button>
    </div>
  );
}

function DetailLoading() {
  return (
    <div className="flex justify-center py-16">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  );
}

function DetailNotFound({ backTo }: { backTo: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-sm text-muted-foreground">
      <span>{t('plugins.detailNotFound')}</span>
      <Button variant="outline" size="sm" onClick={() => navigate(backTo)}>
        {t('plugins.detailBack')}
      </Button>
    </div>
  );
}

/* ===== 技能内容：文件树 / Markdown 预览 / 错误与加载态（已安装与市场共用） ===== */

/** 文件树节点（由相对路径构建） */
interface SkillFileNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  size: number;
  children: SkillFileNode[];
}

/** 相对路径列表 → 目录树（目录优先，同级按名称升序） */
function buildSkillFileTree(files: Array<{ path: string; size: number }>): SkillFileNode[] {
  const root: SkillFileNode = { name: '', path: '', kind: 'dir', size: 0, children: [] };
  for (const file of files) {
    const segments = file.path
      .replace(/\\/g, '/')
      .split('/')
      .filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0) continue;
    let cursor = root;
    segments.forEach((segment, index) => {
      const nodePath = segments.slice(0, index + 1).join('/');
      if (index === segments.length - 1) {
        cursor.children.push({ name: segment, path: nodePath, kind: 'file', size: file.size, children: [] });
        return;
      }
      let dir = cursor.children.find((child) => child.kind === 'dir' && child.name === segment);
      if (!dir) {
        dir = { name: segment, path: nodePath, kind: 'dir', size: 0, children: [] };
        cursor.children.push(dir);
      }
      cursor = dir;
    });
  }
  const sortNodes = (nodes: SkillFileNode[]): void => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((node) => sortNodes(node.children));
  };
  sortNodes(root.children);
  return root.children;
}

/** 文件树单行：目录可展开/折叠，文件按扩展名显示图标 */
function SkillFileTreeNode({
  node,
  depth,
  collapsed,
  onToggle,
}: {
  node: SkillFileNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
}) {
  if (node.kind === 'dir') {
    const open = !collapsed.has(node.path);
    return (
      <div>
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          className="flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors hover:bg-muted/60"
          style={{ paddingLeft: depth * 14 + 8 }}
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
          <Folder className="size-4 shrink-0 text-primary-strong" />
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">{node.name}</span>
        </button>
        {open &&
          node.children.map((child) => (
            <SkillFileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 py-1 pr-2" style={{ paddingLeft: depth * 14 + 8 }}>
      <span className="size-3.5 shrink-0" aria-hidden />
      <FileTypeIcon fileName={node.name} size={16} className="shrink-0" />
      <span
        className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
        title={node.path}
      >
        {node.name}
      </span>
      {node.size > 0 && (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          {formatFileSize(node.size)}
        </span>
      )}
    </div>
  );
}

/** 技能文件树：默认全部展开，点击目录切换折叠 */
function SkillFilesList({
  files,
  emptyLabel,
}: {
  files: Array<{ path: string; size: number }>;
  emptyLabel: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => buildSkillFileTree(files), [files]);
  const toggle = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (files.length === 0) {
    return <p className="py-8 text-center text-xs text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="overflow-hidden rounded-md border border-border py-1">
      {tree.map((node) => (
        <SkillFileTreeNode
          key={node.path}
          node={node}
          depth={0}
          collapsed={collapsed}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}

/** 渲染预览时剥离 YAML frontmatter（源码模式仍展示完整原文） */
function stripFrontMatter(markdown: string): string {
  const matched = /^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/.exec(markdown);
  return matched ? markdown.slice(matched[0].length) : markdown;
}

/** SKILL.md 预览：默认渲染 Markdown，可切换源码 */
function SkillPreviewPane({
  content,
  emptyLabel,
}: {
  content: string | null | undefined;
  emptyLabel: string;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered');

  if (!content || content.trim() === '') {
    return <p className="py-8 text-center text-xs text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">SKILL.md</span>
        <div className="flex items-center gap-1">
          <Button
            variant={mode === 'rendered' ? 'secondary' : 'ghost'}
            size="xs"
            className="h-6 px-2 text-[11px]"
            onClick={() => setMode('rendered')}
          >
            {t('plugins.skillPreviewRendered')}
          </Button>
          <Button
            variant={mode === 'source' ? 'secondary' : 'ghost'}
            size="xs"
            className="h-6 px-2 text-[11px]"
            onClick={() => setMode('source')}
          >
            {t('plugins.skillPreviewSource')}
          </Button>
        </div>
      </div>
      {mode === 'rendered' ? (
        <div className="rounded-lg border border-border bg-muted/20 p-3">
          <MarkdownRenderer text={stripFrontMatter(content)} />
        </div>
      ) : (
        <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed text-foreground">
          {content}
        </pre>
      )}
    </div>
  );
}

function SkillContentError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      <span className="min-w-0 break-all">{message || t('plugins.skillContentFailed')}</span>
      <Button variant="outline" size="xs" className="h-6 shrink-0" onClick={onRetry}>
        {t('plugins.skillContentRetry')}
      </Button>
    </div>
  );
}

function SkillContentLoading() {
  return (
    <div className="flex justify-center py-6">
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
    </div>
  );
}

/* ===== 已安装技能 ===== */
function InstalledSkillDetail({ name, backTo }: { name: string; backTo: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { skills, toggleSkill, reload } = useSkills();
  const cached = skills.find((item) => item.name === name);
  /** 兜底数据：列表先到时不因详情请求失败而误判不存在 */
  const cachedRef = useRef(cached);
  cachedRef.current = cached;

  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setNotFound(false);
    api
      .getSkill(name)
      .then(({ skill }) => {
        if (alive) setDetail(skill);
      })
      .catch(() => {
        if (alive && !cachedRef.current) setNotFound(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [name]);

  const skill = detail ?? cached;
  const Icon = SKILL_ICON_MAP[skill?.icon ?? ''] ?? WandSparkles;
  const enabled = skill?.enabled !== false;

  const useIt = useCallback(() => {
    if (!skill) return;
    useStore.getState().injectComposer(
      `/${skill.name}`,
      undefined,
      [{ kind: 'command', source: 'skill', name: skill.name }],
      '',
    );
    navigate('/task');
  }, [navigate, skill]);

  const doDelete = useCallback(async () => {
    if (!skill) return;
    setDeleting(true);
    try {
      await api.deleteSkill(skill.name);
      toast.success(t('plugins.detailDeleted', { name: skill.name }));
      navigate(backTo);
      void reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('plugins.detailDeleteFailed'));
    } finally {
      setDeleting(false);
      setConfirmOpen(false);
    }
  }, [backTo, navigate, reload, skill, t]);

  if (loading && !skill) return <DetailLoading />;
  if (!skill) return notFound ? <DetailNotFound backTo={backTo} /> : <DetailLoading />;

  const sourcePath = skill.dir ?? detail?.sourceFile ?? '';
  // 「文件」板块：优先使用后端带 size 的清单；旧数据回退纯路径列表
  const fileEntries = detail?.fileEntries ?? (skill.files ?? []).map((path) => ({ path, size: 0 }));
  // 「预览」板块：完整 SKILL.md 原文；后端超限时回退 registry 的 body
  const previewMarkdown = detail?.markdown ?? skill.prompt ?? '';

  return (
    <>
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-start gap-3">
            <PluginIcon src={skill.iconUrl} fallback={<Icon className="size-5" />} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-foreground">{skill.name}</h2>
                <Badge variant="outline" className="font-normal">{t('plugins.detailSkillType')}</Badge>
                {skill.builtin && (
                  <Badge variant="secondary" className="font-normal">{t('plugins.builtinBadge')}</Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{skill.description}</p>
              <p className="text-[11px] text-muted-foreground/70">
                {t('plugins.detailUsageHint', { name: skill.name })}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" className="h-8 gap-1" onClick={useIt}>
                <WandSparkles className="size-3.5" />
                {t('plugins.detailUse')}
              </Button>
              <Switch
                checked={enabled}
                onCheckedChange={(checked) =>
                  void toggleSkill(skill.name, checked).catch(() => toast.error(t('plugins.detailToggleFailed')))
                }
                aria-label={enabled ? t('common.close') : t('common.open')}
              />
              {!skill.builtin && (
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="text-destructive hover:text-destructive"
                  title={t('plugins.detailDelete')}
                  aria-label={t('plugins.detailDelete')}
                  onClick={() => setConfirmOpen(true)}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          </div>

          {sourcePath !== '' && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{t('plugins.detailSource')}</span>
              <CopyLine text={sourcePath} />
            </div>
          )}

          {skill.allowedTools && skill.allowedTools.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t('plugins.detailConfig')}</span>
              {skill.allowedTools.map((tool) => (
                <Badge key={tool} variant="outline" className="font-mono text-[10px] font-normal">
                  {tool}
                </Badge>
              ))}
            </div>
          )}
        </Card>

        {/* 内容板块：已安装技能仅本地「预览 / 文件」，不联网 */}
        <Card className="flex flex-col gap-3 p-4">
          <Tabs defaultValue="preview" className="gap-3">
            <TabsList>
              <TabsTrigger value="preview">{t('plugins.skillTabPreview')}</TabsTrigger>
              <TabsTrigger value="files">{t('plugins.skillTabFiles')}</TabsTrigger>
            </TabsList>
            <TabsContent value="preview">
              <SkillPreviewPane content={previewMarkdown} emptyLabel={t('plugins.skillNoPreview')} />
            </TabsContent>
            <TabsContent value="files">
              <SkillFilesList files={fileEntries} emptyLabel={t('plugins.skillNoFiles')} />
            </TabsContent>
          </Tabs>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={t('common.confirmDelete')}
        description={t('plugins.skillDeleteConfirm', { name: skill.name })}
        destructive
        loading={deleting}
        onConfirm={() => void doDelete()}
        onOpenChange={(open) => !deleting && setConfirmOpen(open)}
      />
    </>
  );
}

/* ===== 已安装 MCP ===== */
function InstalledMcpDetail({ name, backTo }: { name: string; backTo: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [server, setServer] = useState<McpServer | null>(null);
  const [serverTools, setServerTools] = useState<McpTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ servers }, { tools }] = await Promise.all([
        api.listMcpServers(),
        api.listMcpTools(),
      ]);
      setServer(servers.find((item) => item.name === name) ?? null);
      setServerTools(tools.filter((tool) => tool.server === name));
    } catch {
      setServer(null);
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  // 连接状态变化由 WS 推送 → 重新拉取
  useEffect(() => {
    const unsub = wsClient.onMessage((msg) => {
      if (msg.type === 'mcp.status' || msg.type === 'resources.changed') void load();
    });
    return unsub;
  }, [load]);

  const statusColor = useCallback((status: McpServer['status']): string => {
    if (status === 'connected') return 'bg-success';
    if (status === 'error') return 'bg-danger';
    if (status === 'connecting') return 'bg-warning animate-pulse';
    return 'bg-muted-foreground/40';
  }, []);

  const configJson = useMemo(() => {
    if (!server) return '';
    return JSON.stringify(
      {
        name: server.name,
        transport: server.transport ?? 'stdio',
        ...(server.command ? { command: server.command } : {}),
        ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
        ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
        ...(server.url ? { url: server.url } : {}),
        ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
        enabled: server.enabled !== false,
      },
      null,
      2,
    );
  }, [server]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>, failMessage: string): Promise<void> => {
      setBusy(true);
      try {
        await action();
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : failMessage);
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const doDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await api.deleteMcpServer(name);
      toast.success(t('plugins.detailDeleted', { name }));
      navigate(backTo);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('plugins.detailDeleteFailed'));
    } finally {
      setDeleting(false);
      setConfirmOpen(false);
    }
  }, [backTo, name, navigate, t]);

  if (loading) return <DetailLoading />;
  if (!server) return <DetailNotFound backTo={backTo} />;

  const enabled = server.enabled !== false;
  const endpoint =
    server.transport === 'http' || server.transport === 'sse'
      ? server.url ?? ''
      : [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');

  return (
    <>
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="relative">
              <PluginIcon src={server.market?.iconUrl} fallback={<Cable className="size-5" />} />
              <span
                className={statusColor(server.status)}
                title={server.status}
                aria-label={server.status}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-foreground">{server.name}</h2>
                <Badge variant="outline" className="font-normal">{t('plugins.detailMcpType')}</Badge>
                <Badge variant="outline" className="font-normal">{server.transport ?? 'stdio'}</Badge>
                <Badge variant="secondary" className="font-normal">
                  {t('plugins.mcpToolCount', { count: server.toolCount })}
                </Badge>
              </div>
              <p className="break-all text-xs text-muted-foreground">{endpoint}</p>
              {server.market && (
                <p className="text-[11px] text-muted-foreground/70">
                  {t('plugins.detailMarketInfo')}：{server.market.source} · {server.market.id}
                </p>
              )}
              {server.lastError && (
                <p className="break-all text-xs text-destructive">
                  {t('plugins.detailLastError')}：{server.lastError}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {server.status === 'connected' ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1"
                  disabled={busy}
                  onClick={() => void runAction(() => api.disconnectMcpServer(name), t('plugins.detailDisconnect'))}
                >
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Unplug className="size-3.5" />}
                  {t('plugins.detailDisconnect')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="h-8 gap-1"
                  disabled={busy}
                  onClick={() => void runAction(() => api.connectMcpServer(name), t('plugins.detailConnect'))}
                >
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
                  {t('plugins.detailConnect')}
                </Button>
              )}
              <Switch
                checked={enabled}
                onCheckedChange={(checked) =>
                  void runAction(
                    () => api.updateMcpServer(name, { enabled: checked }),
                    t('plugins.detailToggleFailed'),
                  )
                }
                aria-label={enabled ? t('common.close') : t('common.open')}
              />
              <Button
                variant="outline"
                size="icon-sm"
                className="text-destructive hover:text-destructive"
                title={t('plugins.detailDelete')}
                aria-label={t('plugins.detailDelete')}
                onClick={() => setConfirmOpen(true)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>

          {server.env && Object.keys(server.env).length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">ENV</span>
              <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/30 p-2.5 font-mono text-[11px] leading-relaxed text-foreground">
                {Object.entries(server.env).map(([key, value]) => `${key}=${value}`).join('\n')}
              </pre>
            </div>
          )}

          {server.headers && Object.keys(server.headers).length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Headers</span>
              <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/30 p-2.5 font-mono text-[11px] leading-relaxed text-foreground">
                {Object.entries(server.headers).map(([key, value]) => `${key}: ${value}`).join('\n')}
              </pre>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{t('plugins.detailConfig')}</span>
            <CopyLine text={configJson} />
          </div>
        </Card>

        <Card className="flex flex-col gap-2 p-4">
          <div className="flex items-center gap-2">
            <Wrench className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">
              {t('plugins.detailTools', { count: serverTools.length })}
            </span>
          </div>
          {serverTools.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">{t('plugins.detailNoTools')}</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {serverTools.map((tool) => (
                <details key={tool.name} className="rounded-md border border-border px-3 py-2">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-mono font-medium text-foreground">{tool.name}</span>
                    {tool.annotations?.readOnlyHint && (
                      <Badge variant="outline" className="px-1 py-0 text-[10px] font-normal">RO</Badge>
                    )}
                    {tool.annotations?.destructiveHint && (
                      <Badge variant="secondary" className="px-1 py-0 text-[10px] font-normal text-warning">
                        {t('plugins.destructive')}
                      </Badge>
                    )}
                    {tool.description && (
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{tool.description}</span>
                    )}
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                    {JSON.stringify(tool.inputSchema ?? {}, null, 2)}
                  </pre>
                </details>
              ))}
            </div>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={t('common.confirmDelete')}
        description={t('plugins.mcpDeleteConfirm', { name })}
        destructive
        loading={deleting}
        onConfirm={() => void doDelete()}
        onOpenChange={(open) => !deleting && setConfirmOpen(open)}
      />
    </>
  );
}

/* ===== 市场技能 ===== */
function MarketSkillDetail({
  canonicalName,
  stateItem,
  backTo,
}: {
  canonicalName: string;
  stateItem: MarketSkillItem | null;
  backTo: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { skills, reload } = useSkills();
  const [item, setItem] = useState<MarketSkillItem | null>(stateItem);
  const [content, setContent] = useState<MarketSkillContent | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [installing, setInstalling] = useState(false);
  /** 内容重试令牌：自增触发重新请求 */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setContentError(null);
    api
      .marketSkillDetail(canonicalName)
      .then(({ skill, content: nextContent, contentError: nextError }) => {
        if (!alive) return;
        setItem(skill);
        setContent(nextContent);
        setContentError(nextError ?? null);
        setNotFound(false);
      })
      .catch((err) => {
        if (!alive) return;
        setContentError(err instanceof Error ? err.message : '');
        // 有导航态元数据时仍可展示基础信息与安装能力
        if (!stateItem) setNotFound(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [canonicalName, reloadToken, stateItem]);

  const retryContent = useCallback(() => setReloadToken((value) => value + 1), []);

  const installed = item !== null && skills.some((skill) => skill.name === item.installName);
  const canUse = item !== null && installed;

  const useIt = useCallback(() => {
    if (!item) return;
    useStore.getState().injectComposer(
      `/${item.installName}`,
      undefined,
      [{ kind: 'command', source: 'skill', name: item.installName }],
      '',
    );
    navigate('/task');
  }, [item, navigate]);

  const install = useCallback(async () => {
    if (!item || installing) return;
    setInstalling(true);
    try {
      await api.installMarketSkill({
        canonicalName: item.canonicalName,
        ...(item.iconUrl ? { iconUrl: item.iconUrl } : {}),
      });
      toast.success(t('plugins.marketInstallSuccess', { name: item.name }));
      await reload();
    } catch (err) {
      toast.error(
        `${t('plugins.marketInstallFailed')}${err instanceof Error ? `：${err.message}` : ''}`,
      );
    } finally {
      setInstalling(false);
    }
  }, [installing, item, reload, t]);

  if (loading && !item) return <DetailLoading />;
  if (!item) return notFound ? <DetailNotFound backTo={backTo} /> : <DetailLoading />;

  /** 简介：优先详情接口摘要，内容未到位时回退市场列表描述 */
  const summaryText = content?.summaryMarkdown?.trim() || item.description;
  const contentPending = loading && content === null;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-start gap-3">
          <PluginIcon
            src={item.iconUrl}
            fallback={<span className="text-sm font-medium text-muted-foreground">{item.name.slice(0, 1)}</span>}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-foreground">{item.name}</h2>
              <Badge variant="outline" className="font-normal">{t('plugins.detailSkillType')}</Badge>
              {item.verified && <Badge variant="secondary" className="font-normal">✓</Badge>}
              <Badge variant={installed ? 'secondary' : 'outline'} className="font-normal">
                {installed ? t('plugins.detailInstalled') : t('plugins.detailNotInstalled')}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {item.category && <span>{item.category}</span>}
              {item.subCategory && <span>/ {item.subCategory}</span>}
              {item.version && <span>v{item.version}</span>}
              <span>{t('plugins.detailDownloads')}：{item.downloads}</span>
              <span>{t('plugins.detailStars')}：{item.stars}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {canUse ? (
              <Button size="sm" className="h-8 gap-1" onClick={useIt}>
                <WandSparkles className="size-3.5" />
                {t('plugins.detailUse')}
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-8 gap-1"
                disabled={installing}
                onClick={() => void install()}
              >
                {installing ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                {installing ? t('plugins.marketInstalling') : t('plugins.marketInstall')}
              </Button>
            )}
            {item.homepage && (
              <Button variant="outline" size="icon-sm" asChild title={t('plugins.detailHomepage')}>
                <a href={item.homepage} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-4" />
                </a>
              </Button>
            )}
          </div>
        </div>
        {/* 来源 + 简介合并为一张卡片：来源行（可复制）在上，简介行在下 */}
        <div className="overflow-hidden rounded-md border border-border bg-muted/30">
          <div
            className={cn(
              'flex items-start gap-2 px-2.5 py-1.5',
              summaryText !== '' && 'border-b border-border/60',
            )}
          >
            <span className="shrink-0 text-[11px] text-muted-foreground">{t('plugins.detailSource')}</span>
            <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-foreground">{item.canonicalName}</code>
            <Button
              variant="ghost"
              size="icon-xs"
              title={t('plugins.detailCopyConfig')}
              aria-label={t('plugins.detailCopyConfig')}
              onClick={() => {
                void copyText(item.canonicalName).then((ok) => {
                  if (ok) toast.success(t('plugins.detailConfigCopied'));
                  else toast.error(t('common.copyManualHint'));
                });
              }}
            >
              <Copy className="size-3.5" />
            </Button>
          </div>
          {summaryText !== '' && (
            <div className="flex items-start gap-2 px-2.5 py-1.5">
              <span className="shrink-0 text-[11px] text-muted-foreground">{t('plugins.detailSummary')}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground">
                {summaryText}
              </span>
            </div>
          )}
        </div>
      </Card>

      {/* 内容板块：预览 / 文件（内容来自逆向的 SkillHub 公开接口） */}
      <Card className="flex flex-col gap-3 p-4">
        <Tabs defaultValue="preview" className="gap-3">
          <TabsList>
            <TabsTrigger value="preview">{t('plugins.skillTabPreview')}</TabsTrigger>
            <TabsTrigger value="files">{t('plugins.skillTabFiles')}</TabsTrigger>
          </TabsList>

          <TabsContent value="preview" className="flex flex-col gap-3">
            {contentError !== null && (
              <SkillContentError message={contentError} onRetry={retryContent} />
            )}
            {contentPending ? (
              <SkillContentLoading />
            ) : (
              <SkillPreviewPane
                content={content?.preview?.content ?? null}
                emptyLabel={t('plugins.skillNoPreview')}
              />
            )}
          </TabsContent>

          <TabsContent value="files" className="flex flex-col gap-3">
            {contentError !== null && (
              <SkillContentError message={contentError} onRetry={retryContent} />
            )}
            {contentPending ? (
              <SkillContentLoading />
            ) : (
              <SkillFilesList files={content?.files ?? []} emptyLabel={t('plugins.skillNoFiles')} />
            )}
          </TabsContent>
        </Tabs>
      </Card>
    </div>
  );
}

/* ===== 市场 MCP ===== */
function MarketMcpDetail({
  source,
  marketId,
  stateItem,
  backTo,
}: {
  source: McpMarketSource;
  marketId: string;
  stateItem: McpMarketItem | null;
  backTo: string;
}) {
  const { t } = useTranslation();
  const { servers, reload } = useMcp();
  const { installTask, startInstall } = useMcpInstallTask({
    servers,
    reload,
    onFinished: () => {
      void reload();
    },
  });

  const [detail, setDetail] = useState<McpMarketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setNotFound(false);
    api
      .marketMcpDetail(source, marketId)
      .then((value) => {
        if (alive) setDetail(value);
      })
      .catch(() => {
        if (alive) setNotFound(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [marketId, source]);

  const installed = servers.find(
    (server) => server.market?.source === source && server.market.id === marketId,
  );
  const item = detail ?? stateItem;

  if (loading && !item && detail === null) {
    // 有导航态数据时先渲染骨架头部，详情返回后补齐安装表单
    if (!stateItem) return <DetailLoading />;
  }
  if (!item) return notFound ? <DetailNotFound backTo={backTo} /> : <DetailLoading />;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start gap-3">
          <PluginIcon src={item.iconUrl} fallback={<Cable className="size-5" />} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-foreground">{item.name}</h2>
              <Badge variant="outline" className="font-normal">{t('plugins.detailMcpType')}</Badge>
              {item.version && <Badge variant="outline" className="font-normal">{item.version}</Badge>}
              {item.hosted && <Badge variant="secondary" className="font-normal">{t('plugins.mcpMarketHosted')}</Badge>}
              <Badge variant={installed ? 'secondary' : 'outline'} className="font-normal">
                {installed ? t('plugins.detailInstalled') : t('plugins.detailNotInstalled')}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{item.description || t('plugins.mcpMarketNoDescription')}</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>{item.source}</span>
              {item.stars !== undefined && <span>{t('plugins.detailStars')}：{item.stars}</span>}
              {item.views !== undefined && <span>{item.views}</span>}
              {installed && <span className="font-mono">{installed.name}</span>}
            </div>
          </div>
          {item.homepage && (
            <Button variant="outline" size="icon-sm" asChild title={t('plugins.detailHomepage')}>
              <a href={item.homepage} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" />
              </a>
            </Button>
          )}
        </div>
        {detail?.readme && (
          <details className="rounded-lg border border-border px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-foreground">
              {t('plugins.mcpInstallReadme')}
            </summary>
            <div className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
              {detail.readme}
            </div>
          </details>
        )}
      </Card>

      {detail !== null ? (
        <McpInstallForm
          detail={detail}
          installedName={installed?.name}
          task={installTask}
          onInstall={startInstall}
          variant="page"
        />
      ) : (
        <DetailLoading />
      )}
    </div>
  );
}

/* ===== 页面入口 ===== */
export function PluginDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();

  const type = params.get('type') === 'mcp' ? 'mcp' : 'skill';
  const from = params.get('from') === 'market' ? 'market' : 'installed';
  const id = params.get('id') ?? '';
  const source = readSource(params.get('source'));

  const stateItem = useMemo(() => {
    const state = location.state as { marketItem?: MarketSkillItem | McpMarketItem } | null;
    return state?.marketItem ?? null;
  }, [location.state]);

  const backTo = from === 'market'
    ? type === 'mcp' ? '/plugins?tab=mcp' : '/plugins'
    : type === 'mcp' ? '/plugins/mcp' : '/plugins/skills';

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="hidden items-center justify-between gap-4 px-6 py-4 md:flex">
        <div className="flex flex-col gap-1">
          <Button
            variant="ghost"
            size="xs"
            className="-ml-1.5 w-fit gap-1 px-1.5 text-xs text-muted-foreground"
            onClick={() => navigate(backTo)}
          >
            <ArrowLeft className="size-3" />
            {t('plugins.detailBack')}
          </Button>
          <h1 className="text-xl font-semibold text-foreground">{t('plugins.detailTitle')}</h1>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 pb-8 pt-2 md:pt-0">
        {id === '' ? (
          <DetailNotFound backTo={backTo} />
        ) : from === 'market' ? (
          type === 'mcp' ? (
            <MarketMcpDetail
              source={source}
              marketId={id}
              stateItem={stateItem as McpMarketItem | null}
              backTo={backTo}
            />
          ) : (
            <MarketSkillDetail
              canonicalName={id}
              stateItem={stateItem as MarketSkillItem | null}
              backTo={backTo}
            />
          )
        ) : type === 'mcp' ? (
          <InstalledMcpDetail name={id} backTo={backTo} />
        ) : (
          <InstalledSkillDetail name={id} backTo={backTo} />
        )}
      </div>
    </div>
  );
}
