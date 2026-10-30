// webui/src/components/pages/settings/MigrationSettingsSection.tsx
// 数据迁移设置分区（/settings/migration）：
//   1. 从 AI Agent 导入 —— 扫描本机 Claude Code / Codex 会话，转换后写入 MOSS 任务体系；
//   2. 备份与恢复 —— 导出加密备份包（.mossbak），或从备份包合并恢复。
// 文件通道走「后端本机路径直读直写」，前端只传绝对路径（不受 HTTP 16MB 请求体上限约束）。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseBackup,
  Download,
  FileArchive,
  Loader2,
  RefreshCw,
  ScanSearch,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { api } from '@/api/http';
import type {
  MigrationSource,
  MigrationSourceId,
  ExternalSessionMeta,
  MigrationImportResult,
  BackupInspection,
  BackupManifest,
} from '@/types/api';

/** 字节格式化 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** ISO 时间 → 本地可读（解析失败原样返回） */
function formatTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString();
}

/** 统一错误提示 */
function toastError(err: unknown): void {
  toast.error(err instanceof Error ? err.message : String(err));
}

// ============================================================================
// 导入结果面板（外部导入与备份恢复共用）
// ============================================================================

function ImportResultPanel({ result }: { result: MigrationImportResult }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <CheckCircle2 className="size-4 text-emerald-600" />
          {t('settings.migration.importedCount', { count: result.imported })}
        </span>
        {result.skipped.length > 0 && (
          <Badge variant="secondary" className="font-normal">
            {t('settings.migration.skippedCount', { count: result.skipped.length })}
          </Badge>
        )}
        {result.warnings.length > 0 && (
          <Badge variant="secondary" className="gap-1 font-normal text-amber-600">
            <AlertTriangle className="size-3" />
            {t('settings.migration.warningsCount', { count: result.warnings.length })}
          </Badge>
        )}
      </div>

      {result.sessions.length > 0 && (
        <div className="flex max-h-40 flex-col gap-1 overflow-auto">
          {result.sessions.map((s, i) => (
            <div key={`${s.title}-${i}`} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate text-foreground/90">{s.title}</span>
              <span className="shrink-0">·</span>
              <span className="shrink-0">{s.groupName}</span>
              <span className="shrink-0">·</span>
              <span className="shrink-0">{t('settings.migration.messagesLabel', { count: s.messageCount })}</span>
            </div>
          ))}
        </div>
      )}

      {result.skipped.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">{t('settings.migration.skippedTitle')}</summary>
          <div className="mt-1.5 flex max-h-32 flex-col gap-1 overflow-auto">
            {result.skipped.map((s, i) => (
              <div key={`${s.name}-${i}`} className="flex items-center gap-2">
                <span className="truncate">{s.name}</span>
                <span className="shrink-0 text-muted-foreground/70">
                  {t(`settings.migration.skippedReason.${s.reason}`)}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      {result.warnings.length > 0 && (
        <details className="text-xs text-amber-600">
          <summary className="cursor-pointer select-none">{t('settings.migration.warningsTitle')}</summary>
          <div className="mt-1.5 flex max-h-32 flex-col gap-1 overflow-auto">
            {result.warnings.map((w, i) => (
              <div key={`${w}-${i}`} className="break-all">
                {w}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ============================================================================
// 外部 Agent 导入面板
// ============================================================================

function ExternalImportPanel() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<MigrationSource[] | null>(null);
  const [loadingSources, setLoadingSources] = useState(true);
  const [activeSource, setActiveSource] = useState<MigrationSourceId | null>(null);
  const [sessions, setSessions] = useState<ExternalSessionMeta[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState<MigrationSourceId | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<MigrationImportResult | null>(null);

  const loadSources = useCallback(async () => {
    setLoadingSources(true);
    try {
      const resp = await api.migration.listSources();
      setSources(resp.sources);
    } catch (err) {
      toastError(err);
    } finally {
      setLoadingSources(false);
    }
  }, []);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const scan = useCallback(async (source: MigrationSourceId) => {
    setScanning(source);
    setActiveSource(source);
    setSessions([]);
    setSelected(new Set());
    setResult(null);
    try {
      const resp = await api.migration.listExternal(source);
      setSessions(resp.sessions);
    } catch (err) {
      toastError(err);
    } finally {
      setScanning(null);
    }
  }, []);

  const allSelected = sessions.length > 0 && selected.size === sessions.length;
  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(sessions.map((s) => s.sourceId)));
  };
  const toggleOne = (sourceId: string, checked: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });
  };

  const doImport = async (): Promise<void> => {
    if (!activeSource || selected.size === 0) return;
    setImporting(true);
    setResult(null);
    try {
      const resp = await api.migration.importExternal(activeSource, Array.from(selected));
      setResult(resp);
      toast.success(t('settings.migration.importedCount', { count: resp.imported }));
      setSelected(new Set());
      // 刷新来源计数（会话数不随导入变化，但保持数据新鲜）
      void loadSources();
    } catch (err) {
      toastError(err);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* 数据源卡片 */}
      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">{t('settings.migration.sourcesTitle')}</div>
        <p className="text-xs text-muted-foreground">{t('settings.migration.sourcesDesc')}</p>
        {loadingSources && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('settings.migration.scanning')}
          </div>
        )}
        {!loadingSources && sources && (
          <div className="flex flex-col gap-2">
            {sources.map((source) => (
              <div
                key={source.id}
                className="flex flex-col gap-2 rounded-lg border border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{source.label}</span>
                    {source.available ? (
                      <Badge className="bg-emerald-600/15 text-emerald-600" variant="secondary">
                        {t('settings.migration.sourceAvailable')}
                      </Badge>
                    ) : (
                      <Badge variant="secondary">{t('settings.migration.sourceMissing')}</Badge>
                    )}
                    {source.available && (
                      <span className="text-xs text-muted-foreground">
                        {t('settings.migration.sessionsCount', { count: source.sessionCount })}
                      </span>
                    )}
                  </div>
                  <code className="truncate font-mono text-[11px] text-muted-foreground">{source.rootDir}</code>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5 self-start"
                  disabled={!source.available || scanning !== null}
                  onClick={() => void scan(source.id)}
                >
                  {scanning === source.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <ScanSearch className="size-3.5" />
                  )}
                  {t('settings.migration.scanButton')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 会话列表 */}
      {activeSource && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium text-foreground">
              {t('settings.migration.sessionListTitle')}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {t('settings.migration.sessionsCount', { count: sessions.length })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" className="h-7 gap-1.5" onClick={() => void scan(activeSource)}>
                <RefreshCw className={cn('size-3.5', scanning === activeSource && 'animate-spin')} />
                {t('settings.migration.rescan')}
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                disabled={selected.size === 0 || importing}
                onClick={() => void doImport()}
              >
                {importing ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                {t('settings.migration.importSelected', { count: selected.size })}
              </Button>
            </div>
          </div>

          {sessions.length === 0 ? (
            <div className="rounded-lg border border-border px-4 py-10 text-center text-sm text-muted-foreground">
              {scanning ? t('settings.migration.scanning') : t('settings.migration.empty')}
            </div>
          ) : (
            <div className="flex flex-col rounded-lg border border-border">
              <div className="flex items-center gap-3 border-b border-border px-3 py-2">
                <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label={t('settings.migration.selectAll')} />
                <span className="text-xs text-muted-foreground">{t('settings.migration.selectAll')}</span>
              </div>
              <div className="flex max-h-[420px] flex-col divide-y divide-border overflow-auto">
                {sessions.map((session) => (
                  <div key={session.sourceId} className="flex items-start gap-3 px-3 py-2.5">
                    <Checkbox
                      className="mt-0.5"
                      checked={selected.has(session.sourceId)}
                      onCheckedChange={(v) => toggleOne(session.sourceId, v === true)}
                      aria-label={session.title}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm text-foreground">{session.title}</span>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                        {session.cwd && <span className="truncate font-mono">{session.cwd}</span>}
                        <span>{formatTime(session.updatedAt)}</span>
                        <span>{t('settings.migration.messagesLabel', { count: session.messageCount })}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {result && <ImportResultPanel result={result} />}
    </div>
  );
}

// ============================================================================
// 备份与恢复面板
// ============================================================================

function BackupPanel() {
  const { t } = useTranslation();
  const [defaultPath, setDefaultPath] = useState('');
  const [targetPath, setTargetPath] = useState('');
  const [password, setPassword] = useState('');
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ path: string; bytes: number; counts: Record<string, number> } | null>(null);

  const [importPath, setImportPath] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState<BackupInspection | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<MigrationImportResult | null>(null);

  useEffect(() => {
    let alive = true;
    void api.migration
      .defaultBackupPath()
      .then((resp) => {
        if (!alive) return;
        setDefaultPath(resp.path);
        setTargetPath((prev) => prev || resp.path);
      })
      .catch(() => {
        // 后端未就绪：保留空路径，用户可手填
      });
    return () => {
      alive = false;
    };
  }, []);

  const secretPreview = useMemo(() => {
    const counts = exportResult?.counts ?? {};
    const parts = Object.entries(counts)
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .map(([k, v]) => `${k}: ${v}`);
    return parts.join(' · ');
  }, [exportResult]);

  const doExport = async (): Promise<void> => {
    const path = targetPath.trim() || defaultPath;
    if (!path) {
      toast.error(t('settings.migration.pathRequired'));
      return;
    }
    if (password.trim().length < 8) {
      toast.error(t('settings.migration.passwordHint'));
      return;
    }
    setExporting(true);
    setExportResult(null);
    try {
      const resp = await api.migration.exportBackup({
        targetPath: path,
        password: password.trim(),
        includeSecrets,
      });
      setExportResult(resp);
      setTargetPath(resp.path);
      toast.success(t('settings.migration.exportDone'));
    } catch (err) {
      toastError(err);
    } finally {
      setExporting(false);
    }
  };

  const downloadCopy = async (): Promise<void> => {
    if (!exportResult) return;
    try {
      const blob = await api.migration.downloadBackup(exportResult.path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportResult.path.split(/[\\/]/).pop() ?? 'moss-backup.mossbak';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toastError(err);
    }
  };

  const doInspect = async (): Promise<void> => {
    const path = importPath.trim();
    if (!path) {
      toast.error(t('settings.migration.pathRequired'));
      return;
    }
    setInspecting(true);
    setInspection(null);
    setImportResult(null);
    try {
      const resp = await api.migration.inspectBackup({
        path,
        ...(importPassword.trim() ? { password: importPassword.trim() } : {}),
      });
      setInspection(resp);
    } catch (err) {
      toastError(err);
    } finally {
      setInspecting(false);
    }
  };

  const doImport = async (): Promise<void> => {
    const path = importPath.trim();
    if (!path) {
      toast.error(t('settings.migration.pathRequired'));
      return;
    }
    setImporting(true);
    setImportResult(null);
    try {
      const resp = await api.migration.importBackup({
        path,
        ...(importPassword.trim() ? { password: importPassword.trim() } : {}),
      });
      setImportResult(resp);
      toast.success(t('settings.migration.importedCount', { count: resp.imported }));
    } catch (err) {
      toastError(err);
    } finally {
      setImporting(false);
    }
  };

  const manifestSummary = (manifest: BackupManifest | undefined): string => {
    if (!manifest) return '';
    const parts: string[] = [];
    if (manifest.createdAt) parts.push(`${t('settings.migration.createdAt')}: ${formatTime(manifest.createdAt)}`);
    if (manifest.platform) parts.push(manifest.platform);
    if (manifest.formatVersion) parts.push(`v${manifest.formatVersion}`);
    return parts.join(' · ');
  };

  return (
    <div className="flex flex-col gap-6">
      {/* 导出 */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <FileArchive className="size-4 text-muted-foreground" />
          <div className="text-sm font-medium text-foreground">{t('settings.migration.exportTitle')}</div>
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.migration.backupDesc')}</p>

        <div className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="migration-target">{t('settings.migration.targetPath')}</Label>
            <Input
              id="migration-target"
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
              placeholder={defaultPath || '~/.moss/backups/moss-backup-xxxx.mossbak'}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="migration-password">{t('settings.migration.password')}</Label>
            <Input
              id="migration-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('settings.migration.passwordPlaceholder')}
            />
            <span className="text-[11px] text-muted-foreground">{t('settings.migration.passwordHint')}</span>
          </div>
          <div className="flex items-center justify-between gap-4 py-1">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t('settings.migration.includeSecrets')}</span>
              <span className="text-xs text-muted-foreground">{t('settings.migration.includeSecretsDesc')}</span>
            </div>
            <Switch checked={includeSecrets} onCheckedChange={setIncludeSecrets} aria-label={t('settings.migration.includeSecrets')} />
          </div>
          <Button className="self-start gap-1.5" disabled={exporting} onClick={() => void doExport()}>
            {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <DatabaseBackup className="size-3.5" />}
            {exporting ? t('settings.migration.exporting') : t('settings.migration.exportButton')}
          </Button>
        </div>

        {exportResult && (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
              <CheckCircle2 className="size-4 text-emerald-600" />
              <span>{t('settings.migration.exportDone')}</span>
              <Badge variant="secondary" className="font-normal">
                {formatBytes(exportResult.bytes)}
              </Badge>
            </div>
            <code className="break-all font-mono text-[11px] text-muted-foreground">{exportResult.path}</code>
            {secretPreview && <span className="text-[11px] text-muted-foreground">{secretPreview}</span>}
            <Button variant="outline" size="sm" className="w-fit gap-1.5" onClick={() => void downloadCopy()}>
              <Download className="size-3.5" />
              {t('settings.migration.downloadCopy')}
            </Button>
          </div>
        )}
      </div>

      {/* 导入 */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Upload className="size-4 text-muted-foreground" />
          <div className="text-sm font-medium text-foreground">{t('settings.migration.importTitle')}</div>
        </div>
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t('settings.migration.mergeNotice')}
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="migration-import-path">{t('settings.migration.filePath')}</Label>
            <Input
              id="migration-import-path"
              value={importPath}
              onChange={(e) => {
                setImportPath(e.target.value);
                setInspection(null);
                setImportResult(null);
              }}
              placeholder={defaultPath || '~/.moss/backups/moss-backup-xxxx.mossbak'}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="migration-import-password">{t('settings.migration.password')}</Label>
            <Input
              id="migration-import-password"
              type="password"
              value={importPassword}
              onChange={(e) => {
                setImportPassword(e.target.value);
                setInspection(null);
              }}
              placeholder={t('settings.migration.passwordPlaceholder')}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" disabled={inspecting || importing} onClick={() => void doInspect()}>
              {inspecting ? <Loader2 className="size-3.5 animate-spin" /> : <ScanSearch className="size-3.5" />}
              {t('settings.migration.inspectButton')}
            </Button>
            <Button size="sm" className="gap-1.5" disabled={importing || inspecting} onClick={() => void doImport()}>
              {importing ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
              {importing ? t('settings.migration.importingBackup') : t('settings.migration.importButton')}
            </Button>
          </div>

          {inspection && (
            <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/20 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-foreground">
                <span>{t('settings.migration.inspectionTitle')}</span>
                <Badge variant="secondary" className="font-normal">
                  {inspection.encrypted ? t('settings.migration.encrypted') : t('settings.migration.notEncrypted')}
                </Badge>
                <span className="text-muted-foreground">
                  {t('settings.migration.sessionsCount', { count: inspection.sessions })}
                </span>
              </div>
              {manifestSummary(inspection.manifest) && (
                <span className="text-[11px] text-muted-foreground">{manifestSummary(inspection.manifest)}</span>
              )}
            </div>
          )}
        </div>

        {importResult && <ImportResultPanel result={importResult} />}
      </div>
    </div>
  );
}

// ============================================================================
// 页面容器
// ============================================================================

export function MigrationSettingsSection() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'external' | 'backup'>('external');

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-foreground">{t('settings.migration.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('settings.migration.subtitle')}</p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'external' | 'backup')}>
        <TabsList>
          <TabsTrigger value="external" className="gap-1.5">
            <ScanSearch className="size-3.5" />
            {t('settings.migration.tabs.external')}
          </TabsTrigger>
          <TabsTrigger value="backup" className="gap-1.5">
            <DatabaseBackup className="size-3.5" />
            {t('settings.migration.tabs.backup')}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'external' ? <ExternalImportPanel /> : <BackupPanel />}
    </div>
  );
}
