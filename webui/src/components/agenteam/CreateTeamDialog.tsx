// webui/src/components/agenteam/CreateTeamDialog.tsx
// 创建团队对话框：名称/目标 + 成员选择（注册表 agent，含内置模板）+
// 权限模式 + 自动执行开关。提交 POST /api/agenteams。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Trash2 } from 'lucide-react';
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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '../../api/http';
import { useStore } from '../../store';
import { buildMemberAvatarSeeds, fallbackAvatarSeed } from '../../lib/agenteam-avatars';
import { HumationAvatar } from './HumationAvatar';
import type { AgentItem, AgenteamProfile, CreateAgenteamInput } from '../../types/api';

interface CreateTeamDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (teamId: string) => void;
}

/** 预置任务模板（按 explorer→planner→coder→reviewer 流水线） */
const DEFAULT_TASKS: CreateAgenteamInput['tasks'] = [
  { subject: '探索代码库结构与相关模块', kind: 'work', dependencies: [], assignee: 'explorer' },
  { subject: '梳理需求与实现方案', kind: 'requirements', dependencies: ['t1'], assignee: 'planner' },
  { subject: '按方案实现改动', kind: 'implementation', dependencies: ['t2'], assignee: 'coder' },
  { subject: '对抗性审查实现', kind: 'review', dependencies: ['t3'], assignee: 'reviewer', reviewedTaskId: 't3' },
];

export function CreateTeamDialog({ open, onOpenChange, onCreated }: CreateTeamDialogProps) {
  const { t } = useTranslation();
  const workingDirectory = useStore((s) => s.workingDirectory);
  const activeTaskId = useStore((s) => s.activeTaskId);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [profiles, setProfiles] = useState<AgenteamProfile[]>([]);
  /** 可选队长会话（主 agent 即队长，人工建队必须绑定一个真实会话） */
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([]);
  const [captainSessionId, setCaptainSessionId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [permissionMode, setPermissionMode] = useState<'ask' | 'auto' | 'skip'>('auto');
  const [autoStart, setAutoStart] = useState(false);
  const [members, setMembers] = useState<Array<{ name: string; role?: string; agentId?: string; inlinePrompt?: string }>>([]);
  const [tasks, setTasks] = useState<CreateAgenteamInput['tasks']>([]);
  const [submitting, setSubmitting] = useState(false);
  // 成员头像唯一分配（模板固定 seed；自定义成员避开四模板且互不重复）
  const avatarSeeds = useMemo(() => buildMemberAvatarSeeds(members, 'draft'), [members]);

  // 加载 agent 注册表与团队模板
  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const [agentsRes, profilesRes] = await Promise.all([
          api.listAgents(),
          api.listAgenteamProfiles(),
        ]);
        setAgents(agentsRes.agents ?? []);
        setProfiles(profilesRes.profiles ?? []);
      } catch {
        setAgents([]);
        setProfiles([]);
      }
    })();
  }, [open]);

  // 加载可选队长会话（默认绑定当前活跃会话）
  useEffect(() => {
    if (!open) return;
    void api
      .listTasks()
      .then((resp) => {
        const list = (resp.tasks ?? []).map((tk) => ({ id: tk.id, title: tk.title }));
        setSessions(list);
        setCaptainSessionId(activeTaskId && list.some((s) => s.id === activeTaskId) ? activeTaskId : '');
      })
      .catch(() => {
        setSessions([]);
        setCaptainSessionId('');
      });
  }, [open, activeTaskId]);

  // 默认成员：四件套模板
  useEffect(() => {
    if (!open) return;
    setMembers([
      { name: 'explorer', role: 'explorer', agentId: 'agent_explorer' },
      { name: 'planner', role: 'planner', agentId: 'agent_planner' },
      { name: 'coder', role: 'engineer', agentId: 'agent_coder' },
      { name: 'reviewer', role: 'reviewer', agentId: 'agent_reviewer' },
    ]);
    setTasks(DEFAULT_TASKS.map((t) => ({ ...t })));
    setName('');
    setDescription('');
    setAutoStart(false);
  }, [open]);

  const applyProfile = useCallback((profile: AgenteamProfile) => {
    setMembers(
      profile.members.map((m) => ({
        name: m.name,
        role: m.role,
        agentId: m.agentId,
        inlinePrompt: m.inlinePrompt,
      })),
    );
    // seed 任务依赖重排为 t1..tN
    const seedIndex = new Map(profile.tasks.map((t, i) => [t.seedId, `t${i + 1}`]));
    setTasks(
      profile.tasks.map((t, i) => ({
        subject: t.subject,
        description: t.description,
        kind: t.kind,
        dependencies: (t.dependencies ?? []).map((d) => seedIndex.get(d) ?? d),
        assignee: t.assignee,
      })),
    );
    if (!name && profile.description) setDescription(profile.description);
  }, [name]);

  const updateMember = (index: number, patch: Partial<{ name: string; role?: string; agentId?: string; inlinePrompt?: string }>) => {
    setMembers((prev) => prev.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  };

  const addMemberRow = () => {
    setMembers((prev) => [...prev, { name: '', role: '', agentId: undefined, inlinePrompt: '' }]);
  };

  const removeMemberRow = (index: number) => {
    setMembers((prev) => prev.filter((_, i) => i !== index));
  };

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error(t('agenteam.teamName'));
      return;
    }
    const validMembers = members.filter((m) => m.name.trim() !== '' && (m.agentId || m.inlinePrompt?.trim()));
    if (validMembers.length === 0) {
      toast.error(t('agenteam.addMember'));
      return;
    }
    if (!captainSessionId) {
      toast.error(t('agenteam.captainSessionRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const team = await api.createAgenteam({
        name: trimmedName,
        description: description.trim() || undefined,
        cwd: workingDirectory,
        permissionMode,
        captainSessionId,
        members: validMembers.map((m) => ({
          name: m.name.trim(),
          role: m.role?.trim() || undefined,
          agentId: m.agentId,
          inlinePrompt: m.inlinePrompt?.trim() || undefined,
        })),
        tasks,
        approval: !autoStart,
      });
      toast.success(`${team.name} · ${t(`agenteam.phase.${team.phase}`)}`);
      onOpenChange(false);
      onCreated(team.id);
    } catch (err) {
      toast.error(t('agenteam.createFailed'), {
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
          <DialogTitle>{t('agenteam.createDialogTitle')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {/* 名称 / 目标 */}
          <div className="space-y-1.5">
            <Label htmlFor="team-name">{t('agenteam.teamName')}</Label>
            <Input
              id="team-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('agenteam.teamName')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="team-goal">{t('agenteam.teamGoal')}</Label>
            <Textarea
              id="team-goal"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder={t('agenteam.teamGoal')}
            />
          </div>

          {/* 队长会话：主 agent 即队长，人工建队必须绑定一个真实会话 */}
          <div className="space-y-1.5">
            <Label>{t('agenteam.captainSessionLabel')}</Label>
            <Select value={captainSessionId} onValueChange={setCaptainSessionId}>
              <SelectTrigger>
                <SelectValue placeholder={t('agenteam.captainSessionPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {sessions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.title || s.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!captainSessionId && (
              <p className="text-[11px] text-amber-600 dark:text-amber-500">
                {t('agenteam.captainSessionRequired')}
              </p>
            )}
          </div>

          {/* 团队模板 */}
          {profiles.length > 0 && (
            <div className="space-y-1.5">
              <Label>{t('agenteam.fromProfile')}</Label>
              <Select onValueChange={(v) => {
                const profile = profiles.find((p) => p.name === v);
                if (profile) applyProfile(profile);
              }}>
                <SelectTrigger>
                  <SelectValue placeholder={t('agenteam.fromProfile')} />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((p) => (
                    <SelectItem key={p.name} value={p.name}>
                      {p.description ? `${p.name} · ${p.description}` : p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* 成员 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>{t('agenteam.members')}（{members.length}）</Label>
              <Button variant="ghost" size="xs" onClick={addMemberRow}>
                <Plus className="size-3.5" />
                {t('agenteam.addMember')}
              </Button>
            </div>
            <div className="space-y-1.5">
              {members.map((member, index) => {
                const agent = agents.find((a) => a.id === member.agentId);
                const memberKey = member.name.trim() || `member-${index + 1}`;
                const avatarSeed =
                  avatarSeeds.get(memberKey) ?? fallbackAvatarSeed(member.agentId, member.name);
                return (
                  <div key={index} className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1.5">
                    <HumationAvatar seed={avatarSeed} size={28} />
                    <Input
                      value={member.name}
                      onChange={(e) => updateMember(index, { name: e.target.value })}
                      placeholder={t('agenteam.memberName')}
                      className="h-7 w-24 flex-none text-xs"
                    />
                    <Input
                      value={member.role ?? ''}
                      onChange={(e) => updateMember(index, { role: e.target.value })}
                      placeholder={t('agenteam.memberRole')}
                      className="h-7 w-24 flex-none text-xs"
                    />
                    <Select
                      value={member.agentId ?? ''}
                      onValueChange={(v) => updateMember(index, { agentId: v || undefined })}
                    >
                      <SelectTrigger className="h-7 flex-1 text-xs">
                        <SelectValue placeholder={t('agenteam.selectAgent')} />
                      </SelectTrigger>
                      <SelectContent>
                        {agents.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {!member.agentId && (
                      <Input
                        value={member.inlinePrompt ?? ''}
                        onChange={(e) => updateMember(index, { inlinePrompt: e.target.value })}
                        placeholder={t('agenteam.customPrompt')}
                        className="h-7 flex-1 text-xs"
                        title={t('agenteam.customPrompt')}
                      />
                    )}
                    {agent && (
                      <span className="flex-none text-[10px] text-muted-foreground">{agent.name}</span>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="flex-none"
                      onClick={() => removeMemberRow(index)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 权限模式 */}
          <div className="space-y-1.5">
            <Label>{t('agenteam.permissionMode')}</Label>
            <Select value={permissionMode} onValueChange={(v: 'ask' | 'auto' | 'skip') => setPermissionMode(v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask">Ask</SelectItem>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="skip">Skip</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* 自动执行 */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="auto-start"
              checked={autoStart}
              onCheckedChange={(v) => setAutoStart(v === true)}
            />
            <Label htmlFor="auto-start" className="cursor-pointer text-xs font-normal">
              {t('agenteam.autoStart')}
            </Label>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || !captainSessionId}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {submitting ? t('agenteam.creating') : t('agenteam.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
