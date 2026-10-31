// webui/src/components/pages/settings/im/ImBotDialog.tsx
// 新增/编辑机器人对话框：字段由后端渠道描述符驱动（fields），选项为 MOSS 侧运行参数。

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/api/http';
import { SYSTEM_WORKING_DIRECTORY } from '@/store';
import type { ImBotStatus, ImChannelDescriptor } from '@/types/api';

interface Props {
  channel: ImChannelDescriptor | null;
  editing: ImBotStatus | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void> | void;
}

export function ImBotDialog({ channel, editing, onOpenChange, onSaved }: Props) {
  const { t } = useTranslation();
  const open = channel !== null;
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('MOSS');
  const [values, setValues] = useState<Record<string, string>>({});
  const [cwd, setCwd] = useState(SYSTEM_WORKING_DIRECTORY);
  const [permissionMode, setPermissionMode] = useState<'unset' | 'auto' | 'skip' | 'ask'>('unset');
  const [groupTrigger, setGroupTrigger] = useState<'mention' | 'all'>('mention');
  const [progress, setProgress] = useState(true);

  // 打开或切换机器人时重置表单，避免把上一次编辑的值带入下一次（尤其是 AppID/Secret）
  useEffect(() => {
    if (!open || !channel) return;
    setName(editing?.name ?? 'MOSS');
    const initial: Record<string, string> = {};
    for (const field of channel.fields) {
      initial[field.key] = editing && field.type !== 'password'
        ? (editing.credentialPreview[field.key] ?? field.defaultValue ?? '')
        : (field.defaultValue ?? '');
    }
    setValues(initial);
    setCwd(editing?.options.cwd || SYSTEM_WORKING_DIRECTORY);
    setPermissionMode(editing?.options.permissionMode ?? 'unset');
    setGroupTrigger(editing?.options.groupTrigger ?? 'mention');
    setProgress(editing?.options.progress ?? true);
  }, [open, channel?.id, editing?.botId]);

  if (!open || !channel) return null;

  const visibleFields = channel.fields;

  const submit = async (): Promise<void> => {
    if (saving) return;
    const credentials: Record<string, string> = {};
    for (const field of channel.fields) {
      const value = (values[field.key] ?? '').trim();
      // 编辑时密码留空 = 保留旧值；新增时留空交给后端报「缺少必填项」
      if (value) credentials[field.key] = value;
      else if (field.type !== 'password') credentials[field.key] = '';
    }
    setSaving(true);
    try {
      await api.saveImBot({
        ...(editing ? { botId: editing.botId } : {}),
        channel: channel.id,
        name: name.trim() || undefined,
        credentials,
        options: { cwd: cwd.trim(), permissionMode, groupTrigger, progress },
      });
      toast.success(t('settings.im.saved'));
      await onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={value => !saving && onOpenChange(value)}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? t('settings.im.dialogTitleEdit') : t('settings.im.dialogTitleAdd')} · {channel.label}
          </DialogTitle>
          <DialogDescription>{channel.guide}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="im-bot-name">{t('settings.im.name')}</Label>
              <Input
                id="im-bot-name"
                value={name}
                placeholder="MOSS"
                onChange={event => setName(event.target.value)}
              />
            </div>

            {channel.fields.length > 0 && (
              <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                <div className="text-sm font-medium text-foreground">{t('settings.im.credentialsTitle')}</div>
                {visibleFields.map(field => (
                  <div key={field.key} className="flex flex-col gap-1.5">
                    <Label htmlFor={`im-${field.key}`}>
                      {field.label}
                      {field.required ? <span className="ml-1 text-red-500">*</span> : null}
                    </Label>
                    {field.type === 'select' ? (
                      <Select
                        value={values[field.key] ?? field.defaultValue ?? ''}
                        onValueChange={value => setValues(prev => ({ ...prev, [field.key]: value }))}
                      >
                        <SelectTrigger id={`im-${field.key}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(field.options ?? []).map(option => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id={`im-${field.key}`}
                        type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                        value={values[field.key] ?? ''}
                        placeholder={field.placeholder}
                        onChange={event => setValues(prev => ({ ...prev, [field.key]: event.target.value }))}
                        autoComplete="off"
                      />
                    )}
                    {field.type === 'password' && editing ? (
                      <span className="text-xs text-muted-foreground">{t('settings.im.editSecretHint')}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
              <div className="text-sm font-medium text-foreground">{t('settings.im.optionsTitle')}</div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="im-cwd">{t('settings.im.cwd')}</Label>
                <Input
                  id="im-cwd"
                  value={cwd}
                  placeholder={t('settings.im.cwdPlaceholder')}
                  onChange={event => setCwd(event.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{t('settings.im.permissionMode')}</Label>
                <Select
                  value={permissionMode}
                  onValueChange={value => setPermissionMode(value as 'unset' | 'auto' | 'skip' | 'ask')}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unset">{t('settings.im.permissionUnset')}</SelectItem>
                    <SelectItem value="auto">{t('settings.im.permissionAuto')}</SelectItem>
                    <SelectItem value="skip">{t('settings.im.permissionSkip')}</SelectItem>
                    <SelectItem value="ask">{t('settings.im.permissionAsk')}</SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">{t('settings.im.permissionHint')}</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{t('settings.im.groupTrigger')}</Label>
                <Select
                  value={groupTrigger}
                  onValueChange={value => setGroupTrigger(value as 'mention' | 'all')}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mention">{t('settings.im.groupMention')}</SelectItem>
                    <SelectItem value="all">{t('settings.im.groupAll')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor="im-progress">{t('settings.im.progress')}</Label>
                  <span className="text-xs text-muted-foreground">{t('settings.im.progressHint')}</span>
                </div>
                <Switch id="im-progress" checked={progress} onCheckedChange={setProgress} />
              </div>
            </div>

          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={saving}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
