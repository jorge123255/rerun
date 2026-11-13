'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { DesktopWorkspaceClient } from '@/lib/desktop/workspaces'
import type { DesktopWorkspaceRecord } from '@rerun/contracts'
import { DESKTOP_WORKSPACE_ICONS } from '@/lib/desktop/icon-catalog'
import { WORKSPACE_NAME_MAX } from '@/lib/naming/workspace-name'
import { cn } from '@/lib/utils'
import { CheckIcon, Loader2Icon } from '@/lib/icons'
import { useEffect, useRef, useState } from 'react'
import { useDesktopLocale } from '../DesktopLocale'

type Step = 0 | 1

/**
 * Local adaptation of CreateWorkspaceDialog: Name + Icon only.
 * Team invites / billing / hosted sandbox steps are unsupported on Mac local W1.
 */
export function CreateDesktopWorkspaceDialog({
    open,
    onOpenChange,
    client,
    onCreated,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    client: DesktopWorkspaceClient
    onCreated: (workspace: DesktopWorkspaceRecord) => void
}) {
    const { t } = useDesktopLocale()
    const icons = DESKTOP_WORKSPACE_ICONS
    const [step, setStep] = useState<Step>(0)
    const [name, setName] = useState('')
    const [iconCatalogId, setIconCatalogId] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const attempt = useRef<{ requestId: string; name: string; iconCatalogId: string | null } | null>(null)

    useEffect(() => {
        if (!open) return
        setStep(attempt.current ? 1 : 0)
        setName(attempt.current?.name ?? '')
        setError(null)
        setBusy(false)
        setIconCatalogId(attempt.current ? attempt.current.iconCatalogId : icons[0]?.id ?? null)
    }, [open, icons])

    const close = () => {
        if (busy) return
        onOpenChange(false)
    }

    const submit = async () => {
        if (busy) return
        const trimmed = name.trim()
        if (!trimmed) { setError(t('newWorkspace.nameRequired')); return }
        if (trimmed.length > WORKSPACE_NAME_MAX) {
            setError(t('workspaceForm.nameTooLong', { max: WORKSPACE_NAME_MAX }))
            return
        }
        if (step === 0) {
            setStep(1)
            setError(null)
            return
        }
        setBusy(true)
        setError(null)
        try {
            if (attempt.current && (attempt.current.name !== trimmed || attempt.current.iconCatalogId !== iconCatalogId)) throw new Error('Confirm the previous workspace before creating another.')
            attempt.current ??= { requestId: crypto.randomUUID(), name: trimmed, iconCatalogId }
            const result = await client.create(attempt.current)
            if (!result.ok) {
                setError(result.message)
                setBusy(false)
                return
            }
            attempt.current = null
            onOpenChange(false)
            onCreated(result.workspace)
        } catch {
            setError('The workspace could not be confirmed. Retry with the same name and icon to check it.')
            setBusy(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={next => { if (!next) close() }}>
            <DialogContent closeLabel={t('workspaceForm.close')} className="flex max-h-[min(100dvh-2rem,40rem)] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
                <form className="flex min-h-0 flex-1 flex-col p-6" onSubmit={event => { event.preventDefault(); void submit() }}>
                    <div className="mb-6 flex gap-1.5" aria-hidden>
                        {[0, 1].map(index => (
                            <span key={index} className={cn('h-1 flex-1 rounded-full', index <= step ? 'bg-foreground' : 'bg-border')} />
                        ))}
                    </div>
                    <DialogHeader className="mb-4">
                        <DialogTitle>{t(step === 0 ? 'newWorkspace.steps.name.title' : 'newWorkspace.steps.icon.title')}</DialogTitle>
                        <DialogDescription>
                            {t(step === 0 ? 'newWorkspace.steps.name.description' : 'newWorkspace.steps.icon.description')}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="min-h-0 flex-1 overflow-y-auto pb-4">
                        {step === 0 && (
                            <Input
                                label={t('newWorkspace.name')}
                                required
                                placeholder={t('newWorkspace.namePlaceholder')}
                                maxLength={WORKSPACE_NAME_MAX}
                                value={name}
                                disabled={busy}
                                onChange={event => setName(event.target.value)}
                            />
                        )}
                        {step === 1 && (
                            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                                {icons.map(icon => {
                                    const selected = iconCatalogId === icon.id
                                    return (
                                        <button
                                            key={icon.id}
                                            type="button"
                                            disabled={busy}
                                            aria-pressed={selected}
                                            onClick={() => setIconCatalogId(icon.id)}
                                            className={cn(
                                                'relative aspect-square overflow-hidden rounded-lg border transition-colors',
                                                selected ? 'border-foreground ring-1 ring-foreground' : 'border-border hover:border-foreground/40',
                                            )}
                                        >
                                            <img src={icon.url} alt={icon.desc} className="size-full object-cover" />
                                            {selected && (
                                                <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-foreground">
                                                    <CheckIcon className="size-2.5 text-background" />
                                                </span>
                                            )}
                                        </button>
                                    )
                                })}
                            </div>
                        )}
                        {error && <p className="mt-4 text-sm text-destructive" role="alert">{error}</p>}
                    </div>
                    <DialogFooter className="mt-auto -mx-6 -mb-6 flex flex-wrap gap-2 border-t bg-muted/50 px-6 py-4">
                        {step === 0 ? (
                            <Button type="button" variant="outline" disabled={busy} onClick={close}>{t('workspaceForm.cancel')}</Button>
                        ) : (
                            <Button type="button" variant="outline" disabled={busy} onClick={() => setStep(0)}>{t('newWorkspace.back')}</Button>
                        )}
                        <Button type="submit" disabled={busy || !name.trim()}>
                            {busy && <Loader2Icon className="animate-spin" />}
                            {t(step === 0 ? 'newWorkspace.continue' : busy ? 'newWorkspace.creating' : 'newWorkspace.create')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}
