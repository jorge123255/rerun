'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { Input } from '@/components/ui/input'
import type { DesktopWorkspaceClient } from '@/lib/desktop/workspaces'
import type { DesktopWorkspaceCreateInput, DesktopWorkspaceRecord } from '@rerun/contracts'
import { DESKTOP_WORKSPACE_ICONS } from '@/lib/desktop/icon-catalog'
import { WORKSPACE_NAME_MAX } from '@/lib/naming/workspace-name'
import { cn } from '@/lib/utils'
import { CheckIcon, Loader2Icon, CirclePlusIcon } from '@/lib/icons'
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
    const [checking, setChecking] = useState(false)
    const attempt = useRef<DesktopWorkspaceCreateInput | null>(null)
    const submitting = useRef(false)

    useEffect(() => {
        if (!open) return
        setStep(attempt.current ? 1 : 0)
        setName(attempt.current?.name ?? '')
        setError(null)
        setChecking(attempt.current !== null)
        setBusy(false)
        setIconCatalogId(attempt.current ? attempt.current.iconCatalogId : icons[0]?.id ?? null)
    }, [open, icons])

    const close = () => {
        if (submitting.current) return
        onOpenChange(false)
    }

    const submit = async () => {
        if (submitting.current) return
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
        submitting.current = true
        setBusy(true)
        setError(null)
        const previous = attempt.current
        const request = previous ?? { requestId: crypto.randomUUID(), name: trimmed, iconCatalogId }
        attempt.current = request
        try {
            const result = await client.create(request)
            if (!result.ok) {
                // Busy is returned before creating anything. If an earlier reply was lost,
                // it still cannot tell us whether that earlier request succeeded.
                if (!previous && result.code === 'busy') attempt.current = null
                setChecking(attempt.current !== null)
                setError(result.message)
                return
            }
            attempt.current = null
            setChecking(false)
            onOpenChange(false)
            onCreated(result.workspace)
        } catch {
            setChecking(true)
            setError(t('newWorkspace.unconfirmed'))
        } finally {
            submitting.current = false
            setBusy(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={next => { if (!next) close() }}>
            <DialogContent closeLabel={t('workspaceForm.close')} className="flex max-h-[min(100dvh-2rem,40rem)] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
                <form className="flex min-h-0 flex-1 flex-col" onSubmit={event => { event.preventDefault(); void submit() }}>
                    {/* The shared header with the two-step progress under the title, as upstream's wizard header draws it. */}
                    <DialogHeaderBar icon={CirclePlusIcon} title={t(step === 0 ? 'newWorkspace.steps.name.title' : 'newWorkspace.steps.icon.title')}
                        description={t(step === 0 ? 'newWorkspace.steps.name.description' : 'newWorkspace.steps.icon.description')}>
                        <div className="flex gap-1.5" aria-hidden>
                            {[0, 1].map(index => (
                                <span key={index} className={cn('h-1 flex-1 rounded-full', index <= step ? 'bg-foreground' : 'bg-border')} />
                            ))}
                        </div>
                    </DialogHeaderBar>
                    <div className="min-h-0 flex-1 overflow-y-auto p-4">
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
                                            disabled={busy || checking}
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
                        {checking && error !== t('newWorkspace.unconfirmed') && <p className="mt-4 text-sm text-muted-foreground">{t('newWorkspace.unconfirmed')}</p>}
                    </div>
                    <DialogFooter className="mx-0 mt-auto mb-0 flex flex-wrap gap-2">
                        {step === 0 || checking ? (
                            <Button type="button" variant="outline" disabled={busy} onClick={close}>{t('workspaceForm.cancel')}</Button>
                        ) : (
                            <Button type="button" variant="outline" disabled={busy} onClick={() => setStep(0)}>{t('newWorkspace.back')}</Button>
                        )}
                        <Button type="submit" disabled={busy || !name.trim()}>
                            {busy && <Loader2Icon className="animate-spin" />}
                            {t(step === 0 ? 'newWorkspace.continue' : busy ? 'newWorkspace.creating' : checking ? 'newWorkspace.checkCreation' : 'newWorkspace.create')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}
