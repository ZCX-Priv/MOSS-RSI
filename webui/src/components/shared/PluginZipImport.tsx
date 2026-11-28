// webui/src/components/shared/PluginZipImport.tsx
// 插件 zip 批量导入：自动发现技能 / MCP（可混合），确认后逐项导入并显示进度。
// 技能写入 ~/.moss/skills/<name>/；MCP 写入 ~/.moss/mcps/<name>.json（后端自动托管并连接）。
// 同名项跳过并标记，不覆盖用户数据。

import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { CheckCircle2, CircleSlash, FileUp, Loader2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/http';
import { useStore } from '../../store';
import { scanPluginZip, type ZipScanResult } from '../../lib/plugin-zip';

type RowStatus = 'pending' | 'running' | 'installed' | 'skipped' | 'failed';

interface ImportRow {
  key: string;
  kind: 'skill' | 'mcp';
  name: string;
  detail: string;
  sourcePath: string;
  status: RowStatus;
  error?: string;
}

function rowsOf(result: ZipScanResult): ImportRow[] {
  return [
    ...result.skills.map((item) => ({
      key: `skill:${item.name}`,
      kind: 'skill' as const,
      name: item.name,
      detail: item.description,
      sourcePath: item.sourcePath,
      status: 'pending' as const,
    })),
    ...result.mcps.map((item) => ({
      key: `mcp:${item.name}`,
      kind: 'mcp' as const,
      name: item.name,
      detail:
        item.transport === 'stdio'
          ? `${item.transport} · ${[item.command, ...(item.args ?? [])].filter(Boolean).join(' ')}`
          : `${item.transport} · ${item.url ?? ''}`,
      sourcePath: item.sourcePath,
      status: 'pending' as const,
    })),
  ];
}

export function PluginZipImport({
  onDone,
  onFinish,
  onBusyChange,
}: {
  onDone: () => void;
  onFinish?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const skills = useStore((s) => s.skills);
  const servers = useStore((s) => s.mcpServers);
  const [zipName, setZipName] = useState('');
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ZipScanResult | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });

  useEffect(() => {
    onBusyChange?.(importing || scanning);
  }, [importing, scanning, onBusyChange]);

  const onFileChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      setZipName(file.name);
      setScanning(true);
      setError(null);
      setEmpty(false);
      setResult(null);
      setRows([]);
      setDone(false);
      try {
        const scanned = await scanPluginZip(file);
        setResult(scanned);
        setRows(rowsOf(scanned));
        setProgress({ done: 0, total: scanned.skills.length + scanned.mcps.length, current: '' });
        setEmpty(scanned.skills.length === 0 && scanned.mcps.length === 0);
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        setError(message === 'ZIP_TOO_LARGE' ? t('plugins.zipTooLarge') : t('plugins.zipInvalid'));
      } finally {
        setScanning(false);
      }
    },
    [t],
  );

  const patchRow = useCallback((key: string, patch: Partial<ImportRow>) => {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }, []);

  const runImport = useCallback(async () => {
    if (!result || importing) return;
    const existingSkills = new Set(skills.map((item) => item.name));
    const existingMcps = new Set(servers.map((item) => item.name));
    const total = result.skills.length + result.mcps.length;
    const rowOf = new Map(rows.map((row) => [row.key, row] as const));
    setImporting(true);
    setDone(false);
    let installed = 0;
    let skipped = 0;
    let failed = 0;
    let cursor = 0;

    const step = async (key: string, name: string, task: () => Promise<unknown>): Promise<void> => {
      cursor += 1;
      setProgress({ done: cursor, total, current: name });
      patchRow(key, { status: 'running' });
      try {
        await task();
        installed += 1;
        patchRow(key, { status: 'installed' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/ALREADY_EXISTS|already exists|已存在/i.test(message)) {
          skipped += 1;
          patchRow(key, { status: 'skipped' });
        } else {
          failed += 1;
          patchRow(key, { status: 'failed', error: message });
        }
      }
    };

    for (const skill of result.skills) {
      const key = `skill:${skill.name}`;
      if (!rowOf.has(key)) continue;
      // 同名跳过：不覆盖用户数据（用户已确认）
      if (existingSkills.has(skill.name)) {
        cursor += 1;
        skipped += 1;
        setProgress({ done: cursor, total, current: skill.name });
        patchRow(key, { status: 'skipped' });
        continue;
      }
      await step(key, skill.name, () => api.importSkill({ name: skill.name, files: skill.files }));
    }

    for (const mcp of result.mcps) {
      const key = `mcp:${mcp.name}`;
      if (!rowOf.has(key)) continue;
      if (existingMcps.has(mcp.name)) {
        cursor += 1;
        skipped += 1;
        setProgress({ done: cursor, total, current: mcp.name });
        patchRow(key, { status: 'skipped' });
        continue;
      }
      await step(key, mcp.name, async () => {
        await api.createMcpServer({
          name: mcp.name,
          transport: mcp.transport,
          ...(mcp.command ? { command: mcp.command } : {}),
          ...(mcp.args && mcp.args.length > 0 ? { args: mcp.args } : {}),
          ...(mcp.env && Object.keys(mcp.env).length > 0 ? { env: mcp.env } : {}),
          ...(mcp.url ? { url: mcp.url } : {}),
          ...(mcp.headers && Object.keys(mcp.headers).length > 0 ? { headers: mcp.headers } : {}),
        });
      });
    }

    setImporting(false);
    setDone(true);
    setProgress({ done: total, total, current: '' });
    toast.success(t('plugins.zipDone', { installed, skipped, failed }));
    onDone();
  }, [result, importing, skills, servers, patchRow, t, onDone, rows]);

  const scanned = result;
  const total = rows.length;
  const hasItems = scanned !== null && total > 0;
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      <label
        htmlFor="plugin-zip"
        className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground transition-colors hover:bg-muted/40"
      >
        {scanning ? <Loader2 className="size-5 animate-spin" /> : <FileUp className="size-5" />}
        {zipName ? (
          <span className="max-w-full truncate text-foreground">{zipName}</span>
        ) : (
          <span>{t('plugins.zipPick')}</span>
        )}
        {scanning && <span className="text-xs">{t('plugins.zipScanning')}</span>}
      </label>
      <input
        id="plugin-zip"
        type="file"
        accept=".zip"
        className="hidden"
        disabled={scanning || importing}
        onChange={(e) => void onFileChange(e)}
      />

      {error !== null && <p className="text-sm text-destructive">{error}</p>}
      {empty && <p className="text-sm text-muted-foreground">{t('plugins.zipNothingFound')}</p>}

      {scanned !== null && hasItems && (
        <>
          <p className="text-xs text-muted-foreground">
            {t('plugins.zipFound', { skills: scanned.skills.length, mcps: scanned.mcps.length })}
          </p>
          {scanned.warnings.length > 0 && (
            <div className="max-h-24 overflow-auto rounded-md bg-muted/40 px-2.5 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
              {scanned.warnings.map((warning, index) => (
                <div key={index}>{warning}</div>
              ))}
            </div>
          )}
          <div className="flex max-h-64 flex-col gap-1 overflow-auto rounded-lg border border-border p-2">
            {rows.map((row) => (
              <div key={row.key} className="flex items-start gap-2 rounded-md px-1.5 py-1">
                <span className="mt-0.5 shrink-0">
                  {row.status === 'installed' ? (
                    <CheckCircle2 className="size-4 text-success" />
                  ) : row.status === 'skipped' ? (
                    <CircleSlash className="size-4 text-warning" />
                  ) : row.status === 'failed' ? (
                    <XCircle className="size-4 text-destructive" />
                  ) : row.status === 'running' ? (
                    <Loader2 className="size-4 animate-spin text-primary" />
                  ) : (
                    <span className="block size-4 rounded-full border border-border" />
                  )}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-foreground">{row.name}</span>
                    <Badge variant="outline" className="px-1 py-0 text-[10px] font-normal">
                      {row.kind === 'skill' ? t('plugins.detailSkillType') : t('plugins.detailMcpType')}
                    </Badge>
                    {row.status === 'skipped' && (
                      <span className="text-[10px] text-warning">{t('plugins.zipItemSkipped')}</span>
                    )}
                    {row.status === 'failed' && (
                      <span className="text-[10px] text-destructive">
                        {t('plugins.zipItemFailed')}
                        {row.error ? `：${row.error}` : ''}
                      </span>
                    )}
                  </div>
                  <p className="truncate text-[11px] text-muted-foreground">{row.detail}</p>
                  <p className="truncate text-[10px] text-muted-foreground/60">{row.sourcePath}</p>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {(importing || done) && (
        <div className="flex flex-col gap-1.5">
          <Progress value={percent} />
          <p className={cn('text-[11px] text-muted-foreground', importing && 'text-primary-strong')}>
            {importing
              ? `${t('plugins.zipImporting')} ${progress.done}/${progress.total}${
                  progress.current ? ` · ${progress.current}` : ''
                }`
              : t('plugins.zipDone', {
                  installed: rows.filter((row) => row.status === 'installed').length,
                  skipped: rows.filter((row) => row.status === 'skipped').length,
                  failed: rows.filter((row) => row.status === 'failed').length,
                })}
          </p>
        </div>
      )}

      {hasItems && !done && (
        <Button onClick={() => void runImport()} disabled={importing || scanning}>
          {importing && <Loader2 className="size-3.5 animate-spin" />}
          {importing ? t('plugins.zipImporting') : t('plugins.zipConfirmImport')}
        </Button>
      )}
      {hasItems && done && onFinish && (
        <Button variant="outline" onClick={onFinish}>
          {t('plugins.done')}
        </Button>
      )}
    </div>
  );
}
