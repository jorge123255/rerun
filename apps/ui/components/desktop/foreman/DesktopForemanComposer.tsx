'use client'

import { useDesktopLocale } from '../DesktopLocale'

import type { FormEvent, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Thin local composer shell. Root injects the real desktop composer / voice / model controls;
 * this keeps original spacing and stop/send affordances for wiring.
 */
export function DesktopForemanComposer({
    draft,
    onDraftChange,
    onSend,
    onStop,
    busy,
    disabled,
    placeholder,
    trailing,
    className,
}: {
    draft: string
    onDraftChange: (value: string) => void
    onSend: (text: string) => void
    onStop?: () => void
    busy?: boolean
    disabled?: boolean
    placeholder?: string
    trailing?: ReactNode
    className?: string
}) {
    const { t } = useDesktopLocale()
    const submit = (event: FormEvent) => {
        event.preventDefault()
        const text = draft.trim()
        if (!text || disabled || busy) return
        onSend(text)
    }

    return (
        <form onSubmit={submit} className={cn('flex shrink-0 flex-col gap-2 border-t border-border bg-background px-3 py-3', className)}>
            <textarea
                value={draft}
                onChange={event => onDraftChange(event.target.value)}
                placeholder={placeholder ?? t('foreman.placeholder')}
                rows={2}
                disabled={disabled}
                className="min-h-16 w-full resize-none rounded-xl border border-border bg-card px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-desktop-foreman-composer
                aria-label={t('foreman.message')}
            />
            <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">{trailing}</div>
                {busy && onStop ? (
                    <Button type="button" variant="secondary" size="sm" onClick={onStop}>
                        {t('foreman.stop')}
                    </Button>
                ) : (
                    <Button type="submit" size="sm" disabled={disabled || !draft.trim()}>
                        {t('foreman.send')}
                    </Button>
                )}
            </div>
        </form>
    )
}
