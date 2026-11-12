// webui/src/components/pages/settings/RebindProgressDialog.tsx
// 热重绑进度弹窗：远程开关切换时展示真实阶段进度，完成后自动刷新页面。
// 阶段：提交变更 → 服务重启 → 健康检查 → 完成（自动 reload，SPA 状态全量重建：
// session 列表、任务状态、WS 重连、运行中任务恢复实时流——任务本体在后端不受影响）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type RebindStage = 'switching' | 'restarting' | 'checking' | 'done' | 'timeout';

const STAGE_PROGRESS: Record<RebindStage, number> = {
  switching: 30,
  restarting: 65,
  checking: 88,
  done: 100,
  timeout: 100,
};

/** 健康检查轮询间隔 */
const POLL_INTERVAL_MS = 500;
/** 总超时 */
const TOTAL_TIMEOUT_MS = 30_000;

export interface RebindProgressDialogProps {
  open: boolean;
  /** 弹窗打开即开始轮询；关闭后重置（无 onClose——过程不可中断，防半途关闭丢状态） */
  onCompleteReload?: boolean;
}

export function RebindProgressDialog({ open, onCompleteReload = true }: RebindProgressDialogProps) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<RebindStage>('switching');
  const [elapsed, setElapsed] = useState(0);
  const aliveRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopTimers = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    if (!open) {
      stopTimers();
      setStage('switching');
      setElapsed(0);
      return;
    }

    const startedAt = Date.now();

    const pollHealth = async (): Promise<void> => {
      if (!aliveRef.current) return;
      const elapsedMs = Date.now() - startedAt;
      setElapsed(Math.floor(elapsedMs / 1000));
      if (elapsedMs > TOTAL_TIMEOUT_MS) {
        setStage('timeout');
        return;
      }
      try {
        // 直接 fetch（不经 api.http 封装）：health 无需鉴权，避免统一错误处理干扰
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) {
          if (!aliveRef.current) return;
          setStage('done');
          if (onCompleteReload) {
            // 短暂展示完成态后自动刷新（重建 SPA 全部状态）
            setTimeout(() => {
              if (aliveRef.current) window.location.reload();
            }, 600);
          }
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      } catch {
        // 服务重启中（连接拒绝/中断）→ 正常阶段推进
        if (!aliveRef.current) return;
        setStage(prev => (prev === 'switching' ? 'restarting' : prev === 'restarting' ? 'checking' : prev));
      }
      if (aliveRef.current) {
        timerRef.current = setTimeout(pollHealth, POLL_INTERVAL_MS);
      }
    };

    // 首个延迟给后端留出发响应与执行 rebind 的时间（后端延迟 300ms 才 stop）
    timerRef.current = setTimeout(pollHealth, 800);

    return () => {
      aliveRef.current = false;
      stopTimers();
    };
  }, [open, onCompleteReload, stopTimers]);

  const stageTextKey: Record<RebindStage, string> = {
    switching: 'settings.remote.rebind.switching',
    restarting: 'settings.remote.rebind.restarting',
    checking: 'settings.remote.rebind.checking',
    done: 'settings.remote.rebind.done',
    timeout: 'settings.remote.rebind.timeout',
  };

  return (
    <Dialog open={open}>
      <DialogContent
        className="max-w-sm"
        onPointerDownOutside={e => e.preventDefault()}
        onEscapeKeyDown={e => e.preventDefault()}
        aria-describedby="rebind-progress-desc"
      >
        <DialogHeader showCloseButton={false}>
          <DialogTitle className="flex items-center gap-2">
            {stage === 'done' ? (
              <CheckCircle2 className="h-5 w-5 text-success" />
            ) : stage === 'timeout' ? (
              <AlertTriangle className="h-5 w-5 text-warning" />
            ) : (
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            )}
            {t('settings.remote.rebind.title')}
          </DialogTitle>
          <DialogDescription id="rebind-progress-desc">
            {t('settings.remote.rebind.desc')}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="gap-4">
          <Progress value={STAGE_PROGRESS[stage]} className="h-2" />
          <div className="flex items-center justify-between text-sm">
            <span className={stage === 'timeout' ? 'text-warning' : 'text-muted-foreground'}>
              {t(stageTextKey[stage])}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {elapsed}s / 30s
            </span>
          </div>
          {stage === 'timeout' && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t('settings.remote.rebind.timeoutHint')}
              </p>
              <Button variant="outline" className="w-full" onClick={() => window.location.reload()}>
                <RefreshCw className="h-4 w-4 mr-2" />
                {t('settings.remote.rebind.manualReload')}
              </Button>
            </div>
          )}
          {stage !== 'timeout' && stage !== 'done' && (
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t('settings.remote.rebind.taskSafe')}
            </p>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
