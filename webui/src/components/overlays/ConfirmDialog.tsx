// UI/src/components/overlays/ConfirmDialog.tsx
// 可复用确认弹窗：基于 AlertDialog，预设 danger / warning / info 三种 variant。
// 受控使用：open + onOpenChange + onConfirm。

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlertIcon, InfoIcon, CircleAlertIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export type ConfirmDialogVariant = 'danger' | 'warning' | 'info';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: ConfirmDialogVariant;
  /** 勾选确认文案；提供时确认按钮在未勾选前禁用（高风险操作二次确认） */
  requireAcknowledge?: string;
  acknowledgeChecked?: boolean;
  onAcknowledgeChange?: (checked: boolean) => void;
  onConfirm: () => void | Promise<void>;
}

const variantConfig: Record<
  ConfirmDialogVariant,
  { icon: typeof TriangleAlertIcon; iconClass: string; actionClass: string }
> = {
  danger: {
    icon: CircleAlertIcon,
    iconClass: 'text-destructive',
    actionClass:
      'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20',
  },
  warning: {
    icon: TriangleAlertIcon,
    iconClass: 'text-warning',
    actionClass: '',
  },
  info: {
    icon: InfoIcon,
    iconClass: 'text-primary-strong',
    actionClass: '',
  },
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  cancelText,
  variant = 'info',
  requireAcknowledge,
  acknowledgeChecked = false,
  onAcknowledgeChange,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const cfg = variantConfig[variant];
  const Icon = cfg.icon;
  const confirmDisabled = loading || (!!requireAcknowledge && !acknowledgeChecked);

  const handleConfirm = async () => {
    try {
      setLoading(true);
      await onConfirm();
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="md">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <Icon className={cn('size-5 shrink-0 translate-y-0.5', cfg.iconClass)} />
            <div className="flex flex-col gap-1">
              <AlertDialogTitle>{title}</AlertDialogTitle>
              {description && (
                <AlertDialogDescription>{description}</AlertDialogDescription>
              )}
            </div>
          </div>
        </AlertDialogHeader>
        {requireAcknowledge && (
          <div className="px-4 pb-3">
            <Label
              htmlFor="confirm-dialog-acknowledge"
              className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-sm font-normal leading-snug"
            >
              <Checkbox
                id="confirm-dialog-acknowledge"
                checked={acknowledgeChecked}
                onCheckedChange={(checked) => onAcknowledgeChange?.(checked === true)}
                className="mt-0.5"
              />
              <span>{requireAcknowledge}</span>
            </Label>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>{cancelText ?? t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handleConfirm();
            }}
            disabled={confirmDisabled}
            className={cn(variant === 'danger' && cfg.actionClass)}
          >
            {confirmText ?? t('common.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
