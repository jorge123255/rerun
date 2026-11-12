'use client'

import { useId, useRef, type FormEvent, type ReactNode } from 'react'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { ComposerLinkMirror } from '@/components/chat/ComposerLinkMirror'
import { CornerDownLeftIcon, SquareIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useDesktopLocale } from '../DesktopLocale'
import type { useDesktopMentionAutocomplete } from '../mentions/useDesktopMentionAutocomplete'

export function DesktopForemanComposer({
    draft,
    onDraftChange,
    onSend,
    onStop,
    busy,
    disabled,
    sendDisabled,
    placeholder,
    maxLength = 20_000,
    trailing,
    controls,
    attachments,
    hasAttachments,
    onFiles,
    mentions,
    className,
}: {
    draft: string
    onDraftChange: (value: string) => void
    onSend: (text: string) => void
    onStop?: () => void
    busy?: boolean
    disabled?: boolean
    sendDisabled?: boolean
    placeholder?: string
    maxLength?: number
    trailing?: ReactNode
    controls?: ReactNode
    attachments?: ReactNode
    hasAttachments?: boolean
    onFiles?: (files: File[]) => void
    mentions?: Pick<ReturnType<typeof useDesktopMentionAutocomplete>, 'inputRef' | 'textareaProps' | 'menu' | 'linkMirror'>
    className?: string
}) {
    const { language: { locale }, t } = useDesktopLocale()
    const limitId = useId()
    const composing = useRef(false)
    const text = draft.trim()
    const overLimit = draft.length > maxLength
    const canSend = (!!text || !!hasAttachments) && !overLimit && !disabled && !sendDisabled && !busy
    const submit = (event: FormEvent) => {
        event.preventDefault()
        if (canSend) onSend(text)
    }

    return (
        <form onSubmit={submit} className={cn('relative shrink-0 px-3 py-3', className)}
            onDragOver={event => { if (onFiles && event.dataTransfer.types.includes('Files')) event.preventDefault() }}
            onDrop={event => {
                if (!onFiles || event.defaultPrevented || !event.dataTransfer.files.length) return
                event.preventDefault()
                onFiles(Array.from(event.dataTransfer.files))
            }}
            onPaste={event => {
                if (!onFiles || event.defaultPrevented || !event.clipboardData.files.length) return
                event.preventDefault()
                onFiles(Array.from(event.clipboardData.files))
            }}>
            <InputGroup className="rounded-xl bg-card">
                {attachments && <InputGroupAddon align="block-start" className="min-w-0">{attachments}</InputGroupAddon>}
                <div className="relative w-full min-w-0">
                    <InputGroupTextarea
                        {...mentions?.textareaProps}
                        ref={mentions?.inputRef}
                        value={mentions?.textareaProps.value ?? draft}
                        onChange={mentions?.textareaProps.onChange ?? (event => onDraftChange(event.target.value))}
                        onCompositionStart={() => { composing.current = true }}
                        onCompositionEnd={() => { composing.current = false }}
                        onPaste={event => { if (!event.clipboardData.files.length) mentions?.textareaProps.onPaste(event) }}
                        onKeyDown={event => {
                            if (composing.current || event.nativeEvent.isComposing) return
                            mentions?.textareaProps.onKeyDown(event)
                            if (event.key !== 'Enter' || event.shiftKey || event.defaultPrevented) return
                            event.preventDefault()
                            if (canSend) event.currentTarget.form?.requestSubmit()
                        }}
                        placeholder={placeholder ?? t('foreman.placeholder')}
                        rows={2}
                        maxLength={maxLength}
                        disabled={disabled}
                        className={cn('max-h-48 min-h-16 w-full text-sm', mentions?.linkMirror && 'text-transparent caret-foreground [scrollbar-gutter:stable]')}
                        data-desktop-foreman-composer
                        aria-label={t('foreman.message')}
                        aria-invalid={overLimit || undefined}
                        aria-describedby={overLimit ? limitId : undefined}
                    />
                    {mentions?.linkMirror && <ComposerLinkMirror {...mentions.linkMirror}
                        className="px-2.5 py-2 text-sm text-foreground [scrollbar-gutter:stable]"
                        labels={{ open: t('composerLink.open'), unlink: t('composerLink.unlink') }} editable={!disabled} />}
                </div>
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
            {mentions?.menu}
        </form>
    )
}
