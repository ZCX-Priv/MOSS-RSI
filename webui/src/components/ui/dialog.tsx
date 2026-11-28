"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

/** 模态窗统一尺寸档位：桌面端（sm: 断点起）固定档位宽度，小屏回退接近全宽 calc(100%-2rem) */
export type DialogSize = "sm" | "md" | "lg" | "xl"

/** 档位 → 桌面端固定宽度映射（sm=400px / md=520px / lg=680px / xl=1024px(max-w-5xl)），供 AlertDialogContent 复用 */
export const dialogSizeClasses: Record<DialogSize, string> = {
  sm: "sm:max-w-[400px]",
  md: "sm:max-w-[520px]",
  lg: "sm:max-w-[680px]",
  xl: "sm:max-w-5xl",
}

/**
 * 档位 → 固定高度映射：内容类弹窗高度不随内容多少变化，正文区（DialogBody）滚动、头尾固定。
 * max-h-[90dvh] 仅用于超短视口兜底；调用方传入的 h-* 类可覆盖（如 SearchModal）。
 */
export const dialogHeightClasses: Record<DialogSize, string> = {
  sm: "h-[360px] max-h-[90dvh]",
  md: "h-[520px] max-h-[90dvh]",
  lg: "h-[640px] max-h-[90dvh]",
  xl: "h-[760px] max-h-[90dvh]",
}

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  size = "md",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  size?: DialogSize
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        // 三段式容器：按档位固定高度（不随内容伸缩），自身 overflow-hidden 不滚动，仅 DialogBody 滚动
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-popover text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          dialogSizeClasses[size],
          dialogHeightClasses[size],
          className
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

/** 中间内容区：弹窗内唯一滚动区。flex-1 min-h-0 吸收剩余高度，内容超出时仅本区域滚动，头尾固定不动 */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-2",
        className
      )}
      {...props}
    />
  )
}

function DialogHeader({
  className,
  showCloseButton = true,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div
      data-slot="dialog-header"
      // 固定头：shrink-0 不随内容滚动。X 与标题处于同一 flex 行（items-start），
      // -mt-1.5 使 X（size-7=28px）的垂直中心与标题行（text-base leading-none=16px）对齐
      className={cn(
        "flex shrink-0 items-start justify-between gap-2 px-4 pt-4 pb-3",
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
      {showCloseButton && (
        <DialogPrimitive.Close data-slot="dialog-close" asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="-mt-1.5 shrink-0"
          >
            <XIcon
            />
            <span className="sr-only">{t('ui.close')}</span>
          </Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div
      data-slot="dialog-footer"
      // 固定尾：容器为 overflow-hidden 的 flex 列，footer 作为最后一个 shrink-0 子项
      // 始终钉在弹窗底部，不随 DialogBody 滚动
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 px-4 py-3 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">{t('ui.close')}</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
