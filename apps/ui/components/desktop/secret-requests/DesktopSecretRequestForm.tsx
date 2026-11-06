'use client'

import { BorderBeam } from '@rerun/ui'
import { Input } from '@rerun/ui/forms'
import { Button, Icon, ScrollFade } from '@rerun/ui/primitives'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { ExternalLinkIcon, LockIcon, XIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DesktopSecretRequestViewField } from '@rerun/contracts'

export function DesktopSecretRequestForm({ fields, reason, ownerKey, onSubmit, onSkip, onDismiss, disabled, inline, className }: {
    fields: DesktopSecretRequestViewField[]
    reason?: string
    ownerKey: string
    onSubmit: (values: Record<string, string>) => Promise<void>
    onSkip?: () => Promise<void>
    onDismiss?: () => Promise<void>
    disabled?: boolean
    inline?: boolean
    className?: string
}) {
    const blankValues = useMemo(() => Object.fromEntries(fields.map(field => [field.key, ''])), [ownerKey])
    const form = useForm<Record<string, string>>({ defaultValues: blankValues })
    const values = form.watch()
    const [pending, setPending] = useState<'save' | 'skip' | 'dismiss' | null>(null)
    const [submitted, setSubmitted] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const busyRef = useRef(false)
    const current = useRef({ ownerKey, generation: 0, mounted: true, disabled })
    if (current.current.ownerKey !== ownerKey || current.current.disabled !== disabled) {
        current.current = { ownerKey, generation: current.current.generation + 1, mounted: true, disabled }
    }
    useEffect(() => {
        current.current.mounted = true
        return () => { current.current.mounted = false; current.current.generation += 1 }
    }, [])

    useEffect(() => {
        busyRef.current = false
        setPending(null)
        setSubmitted(false)
        setError(null)
        form.reset(blankValues)
        return () => { form.reset(blankValues) }
    }, [ownerKey, form, blankValues, disabled])

    const locked = disabled || pending !== null || submitted
    const filled = fields.filter(field => (values[field.key] ?? '').length > 0)

    const save = async () => {
        if (disabled || busyRef.current || !filled.length) return
        busyRef.current = true
        const generation = ++current.current.generation
        const isCurrent = () => current.current.mounted && current.current.ownerKey === ownerKey && current.current.generation === generation && !current.current.disabled
        setPending('save')
        setError(null)
        try {
            await onSubmit(Object.fromEntries(filled.map(field => [field.key, values[field.key]])))
            if (!isCurrent()) return
            form.reset(blankValues)
            setSubmitted(true)
        } catch (cause) {
            if (!isCurrent()) return
            busyRef.current = false
            setError(cause instanceof Error ? cause.message : 'Could not save the credentials. Retry the same decision.')
        } finally {
            if (isCurrent()) setPending(null)
        }
    }

    const close = async (operation: 'skip' | 'dismiss', handler?: () => Promise<void>) => {
        if (!handler || disabled || busyRef.current) return
        busyRef.current = true
        const generation = ++current.current.generation
        const isCurrent = () => current.current.mounted && current.current.ownerKey === ownerKey && current.current.generation === generation && !current.current.disabled
        setPending(operation)
        setError(null)
        try {
            await handler()
            if (!isCurrent()) return
            form.reset(blankValues)
            setSubmitted(true)
        } catch (cause) {
            if (!isCurrent()) return
            busyRef.current = false
            setError(cause instanceof Error ? cause.message : 'Could not confirm this decision. Retry it.')
        } finally {
            if (isCurrent()) setPending(null)
        }
    }

    if (!fields.length) return null
    return <div className={cn('relative space-y-3 overflow-hidden rounded-lg border border-border bg-muted/30 p-3', !inline && 'mb-2', className)}>
        <BorderBeam animated pattern="arcs" tone="brand" glow width={1} duration={7} />
        <div className="flex items-start gap-2.5">
            <Icon size="sm" icon={LockIcon} className="bg-background text-foreground" />
            <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-medium leading-snug">{fields.length > 1 ? 'Credentials needed' : 'Credential needed'}</p>
                {reason && <p className="break-words text-xs leading-snug text-muted-foreground">{reason}</p>}
            </div>
            {(onDismiss || onSkip) && <Button type="button" size="icon-sm" variant="ghost" disabled={locked} onClick={() => { void close('dismiss', onDismiss ?? onSkip) }} aria-label="Dismiss credential request" data-hitl="dismiss" className="-my-1 shrink-0 text-muted-foreground">
                <XIcon className="size-4" />
            </Button>}
        </div>
        <ScrollFade className="max-h-[48vh]">
            <div className="space-y-3 px-px">
                {fields.map(field => <div key={field.key} className="space-y-1">
                    <Input
                        {...form.register(field.key)}
                        type="password"
                        label={field.label}
                        helperText={[field.help, `Stored as ${field.key}`].filter(Boolean).join(' · ')}
                        placeholder={field.existing ? 'Already saved. Enter a value to replace it' : 'Paste the value'}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={locked}
                        data-hitl={`secret-${field.key}`}
                    />
                    {field.docsUrl && <a href={field.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline">
                        Where to find it
                        <ExternalLinkIcon className="size-3" />
                    </a>}
                </div>)}
            </div>
        </ScrollFade>
        {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 flex-1 text-xs leading-snug text-muted-foreground/70">Stored encrypted for this coworker. Never sent to the model.</p>
            <div className="flex shrink-0 items-center gap-2">
                {onSkip && <Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => { void close('skip', onSkip) }} data-hitl="skip">Skip</Button>}
                <Button type="button" size="sm" disabled={locked || !filled.length} onClick={() => { void save() }} data-hitl="save">{pending === 'save' ? 'Saving…' : 'Save'}</Button>
            </div>
        </div>
    </div>
}
