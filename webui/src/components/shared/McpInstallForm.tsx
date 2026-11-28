// webui/src/components/shared/McpInstallForm.tsx
// MCP 市场安装表单：安装方式 / 环境变量 / 手动配置 / JSON 预览 / 真实进度与日志。
// 同时支持弹窗（市场列表快速安装）与页面内嵌（市场 MCP 详情页）两种形态。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Eye, EyeOff, Info, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { copyText } from '../../lib/clipboard';
import type {
  McpInstallPhase,
  McpMarketDetail,
  McpMarketEnvField,
  McpMarketInstallOption,
} from '../../types/api';
import type { InstallPayload, InstallTask } from '../../hooks/useMcpInstallTask';

/** MCP 服务器名合法字符（与后端 createServer 一致） */
const SERVER_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** 阶段 → i18n key */
export const INSTALL_PHASE_KEYS: Record<McpInstallPhase, string> = {
  prepare: 'plugins.mcpInstallPhasePrepare',
  start: 'plugins.mcpInstallPhaseStart',
  download: 'plugins.mcpInstallPhaseDownload',
  install: 'plugins.mcpInstallPhaseInstall',
  connect: 'plugins.mcpInstallConnecting',
  done: 'plugins.mcpInstallPhaseDone',
  error: 'plugins.mcpInstallPhaseError',
};

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

/** 生成 mcpServers JSON 预览 */
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

interface McpInstallFormProps {
  detail: McpMarketDetail | null;
  installedName?: string;
  task?: InstallTask | null;
  onInstall: (payload: InstallPayload, detail: McpMarketDetail) => Promise<void>;
  /** dialog：弹窗形态；page：详情页内嵌形态 */
  variant?: 'dialog' | 'page';
  /** dialog 形态的取消/关闭 */
  onCancel?: () => void;
}

/** 安装表单主体（两种形态共用） */
export function McpInstallForm({
  detail,
  installedName,
  task,
  onInstall,
  variant = 'page',
  onCancel,
}: McpInstallFormProps) {
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

  // 只展示当前条目的安装任务（避免上一个条目的进度串台）
  const activeTask = useMemo(
    () =>
      task && detail && task.key === `${detail.source}:${detail.id}` ? task : null,
    [task, detail],
  );
  const phase = activeTask?.phase;
  const phaseLabel = phase ? t(INSTALL_PHASE_KEYS[phase]) : '';

  useEffect(() => {
    if (!detail) return;
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
  }, [detail, installedName]);

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
      // 安装任务由页面层托管：表单保持展示真实进度
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

  const submitButton = (
    <Button onClick={() => void submit()} disabled={disabled}>
      {(busy || activeTask) && <Loader2 className="size-3.5 animate-spin" />}
      {busy || activeTask
        ? t('plugins.mcpInstalling')
        : installedName
          ? t('plugins.mcpMarketReconfigure')
          : t('plugins.mcpMarketInstall')}
    </Button>
  );

  const body = detail && option ? (
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

      {variant === 'page' && <div className="flex justify-end">{submitButton}</div>}
    </div>
  ) : (
    <div className="flex justify-center py-10">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  );

  if (variant === 'dialog') {
    return (
      <>
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
        <DialogBody>{body}</DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          {submitButton}
        </DialogFooter>
      </>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-foreground">
          {installedName
            ? t('plugins.mcpReconfigureTitle', { name: installedName })
            : t('plugins.mcpInstallTitle', { name: detail?.name ?? '' })}
        </h3>
        <p className="text-xs text-muted-foreground">
          {detail?.description || t('plugins.mcpInstallDesc')}
        </p>
      </div>
      {body}
    </Card>
  );
}

/** 弹窗形态：市场列表快速安装入口 */
export function McpInstallDialog({
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <McpInstallForm
          detail={detail}
          installedName={installedName}
          task={task}
          onInstall={onInstall}
          variant="dialog"
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
