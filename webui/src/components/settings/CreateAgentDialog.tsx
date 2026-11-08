// webui/src/components/settings/CreateAgentDialog.tsx
// 创建/编辑 Agent 对话话框：名称/描述/系统提示词/模型。
// 创建走 useAgents().createAgent；编辑走 updateAgent（传入 agent 时为编辑模式）。

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '../../api/http';
import type { AgentDetail } from '../../types/api';

interface CreateAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 传入时为编辑模式 */
  editing?: AgentDetail | null;
  onSaved: () => void;
}

export function CreateAgentDialog({ open, onOpenChange, editing, onSaved }: CreateAgentDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [model, setModel] = useState('');
  const [toolsInput, setToolsInput] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const isEdit = Boolean(editing);

  // 打开时初始化表单 + 拉取可选模型列表
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setDescription(editing?.description ?? '');
    setSystemPrompt(editing?.systemPrompt ?? '');
    setModel(editing?.model ?? '');
    setToolsInput(editing?.tools?.join(', ') ?? '');
    setSubmitting(false);
    void (async () => {
      try {
        const res = await api.listProviders();
        const list: string[] = [];
        for (const p of res.providers ?? []) {
          for (const m of p.models ?? []) {
            list.push(m.id);
          }
        }
        setModels(list);
      } catch {
        setModels([]);
      }
    })();
  }, [open, editing]);

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error(t('settings.agent.nameRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        name: trimmedName,
        description: description.trim() || undefined,
        systemPrompt: systemPrompt.trim() || undefined,
        model: model.trim() || undefined,
        tools:
          toolsInput
            .split(',')
            .map((name) => name.trim())
            .filter((name) => name !== '') || undefined,
      };
      if (isEdit && editing) {
        await api.updateAgent(editing.id, payload);
        toast.success(t('settings.agent.updated'));
      } else {
        await api.createAgent(payload);
        toast.success(t('settings.agent.created'));
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(isEdit ? t('settings.agent.updateFailed') : t('settings.agent.createFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('settings.agent.editAgent') : t('settings.agent.createAgent')}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <div className="space-y-1.5">
            <Label htmlFor="agent-name">{t('settings.agent.name')}</Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings.agent.name')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agent-desc">{t('settings.agent.description')}</Label>
            <Input
              id="agent-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('settings.agent.description')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agent-model">{t('settings.agent.model')}</Label>
            <Input
              id="agent-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t('settings.agent.modelPlaceholder')}
              list="agent-model-list"
            />
            <datalist id="agent-model-list">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agent-tools">{t('settings.agent.tools')}</Label>
            <Input
              id="agent-tools"
              value={toolsInput}
              onChange={(e) => setToolsInput(e.target.value)}
              placeholder={t('settings.agent.toolsPlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agent-prompt">{t('settings.agent.systemPrompt')}</Label>
            <Textarea
              id="agent-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={8}
              placeholder={t('settings.agent.systemPromptPlaceholder')}
              className="font-mono text-xs"
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {isEdit ? t('common.save') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
