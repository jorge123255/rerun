'use client'

import { useId, useRef, type FormEvent, type ReactNode } from 'react'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { CornerDownLeftIcon, SquareIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useDesktopLocale } from '../DesktopLocale'

export function DesktopForemanComposer({
    draft,
    onDraftChange,
    onSend,
    onStop,
    busy,
    disabled,
    placeholder,
    maxLength = 20_000,
    trailing,
    controls,
    className,
}: {
    draft: string
    onDraftChange: (value: string) => void
    onSend: (text: string) => void
    onStop?: () => void
    busy?: boolean
    disabled?: boolean
    placeholder?: string
    maxLength?: number
    trailing?: ReactNode
    controls?: ReactNode
    className?: string
}) {
    const { language: { locale }, t } = useDesktopLocale()
    const limitId = useId()
    const composing = useRef(false)
    const text = draft.trim()
    const overLimit = draft.length > maxLength
    const canSend = !!text && !overLimit && !disabled && !busy
    const submit = (event: FormEvent) => {
        event.preventDefault()
        if (canSend) onSend(text)
    }

    return (
        <form onSubmit={submit} className={cn('shrink-0 px-3 py-3', className)}>
            <InputGroup className="rounded-xl bg-card">
                <InputGroupTextarea
                    value={draft}
                    onChange={event => onDraftChange(event.target.value)}
                    onCompositionStart={() => { composing.current = true }}
                    onCompositionEnd={() => { composing.current = false }}
                    onKeyDown={event => {
                        if (event.key !== 'Enter' || event.shiftKey || event.defaultPrevented || composing.current || event.nativeEvent.isComposing) return
                        event.preventDefault()
                        if (canSend) event.currentTarget.form?.requestSubmit()
                    }}
                    placeholder={placeholder ?? t('foreman.placeholder')}
                    rows={2}
                    maxLength={maxLength}
                    disabled={disabled}
                    className="max-h-48 min-h-16 w-full text-sm"
                    data-desktop-foreman-composer
                    aria-label={t('foreman.message')}
                    aria-invalid={overLimit || undefined}
                    aria-describedby={overLimit ? limitId : undefined}
                />
                <InputGroupAddon align="block-end">
                    <div className="min-w-0 flex-1">{trailing}</div>
                    {overLimit && <span id={limitId} role="status" className="whitespace-nowrap text-xs text-destructive">
                        {draft.length.toLocaleString(locale)} / {maxLength.toLocaleString(locale)}
                    </span>}
                    {controls}
                    {busy && onStop ? (
                        <InputGroupButton type="button" variant="default" size="icon-sm" title={t('foreman.stop')} onClick={onStop}>
                            <SquareIcon aria-hidden="true" className="size-4" />
                            <span className="sr-only">{t('foreman.stop')}</span>
                        </InputGroupButton>
                    ) : (
                        <InputGroupButton type="submit" variant="default" size="icon-sm" title={t('foreman.send')} disabled={!canSend}>
                            <CornerDownLeftIcon aria-hidden="true" className="size-4 rotate-90" />
                            <span className="sr-only">{t('foreman.send')}</span>
                        </InputGroupButton>
                    )}
                </InputGroupAddon>
            </InputGroup>
        </form>
    )
}
