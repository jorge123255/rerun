'use client'

import { useState, type ComponentProps, type MouseEvent, type ReactNode } from 'react'

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import type { Button } from '@/components/ui/button'

type ConfirmDialogBaseProps = {
    title: string
    description?: ReactNode
    confirmLabel?: string
    cancelLabel?: string
    confirmVariant?: ComponentProps<typeof Button>['variant']
    pending?: boolean
    onCloseAutoFocus?: ComponentProps<typeof AlertDialogContent>['onCloseAutoFocus']
    onConfirm: (event: MouseEvent<HTMLButtonElement>) => void
}

// Le mode contrôlé existe pour les triggers qui vivent dans un calque qui se ferme sur
// interact-outside (Popover, DropdownMenu) : la dialog doit alors être montée en dehors.
type ConfirmDialogProps = ConfirmDialogBaseProps &
    (
        | { children: ReactNode; open?: undefined; onOpenChange?: undefined }
        | { children?: undefined; open: boolean; onOpenChange: (open: boolean) => void }
    )

export function ConfirmDialog({
    title,
    description,
    confirmLabel = 'Delete',
    cancelLabel = 'Cancel',
    confirmVariant = 'destructive',
    pending = false,
    onCloseAutoFocus,
    onConfirm,
    children,
    open,
    onOpenChange,
}: ConfirmDialogProps) {
    const [selfOpen, setSelfOpen] = useState(false)
    const controlled = onOpenChange !== undefined

    return (
        <AlertDialog open={controlled ? open : selfOpen} onOpenChange={controlled ? onOpenChange : setSelfOpen}>
            {children && <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>}
            <AlertDialogContent size="sm" onCloseAutoFocus={onCloseAutoFocus}>
                <AlertDialogHeader>
                    <AlertDialogTitle>{title}</AlertDialogTitle>
                    {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
                    <AlertDialogAction variant={confirmVariant} disabled={pending} onClick={onConfirm}>
                        {confirmLabel}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    )
}
