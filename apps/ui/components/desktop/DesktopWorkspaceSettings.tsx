'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { CheckIcon, Loader2Icon } from '@/lib/icons'
import { DESKTOP_WORKSPACE_ICONS, desktopWorkspaceIconUrl, type DesktopWorkspaceIcon } from '@/lib/desktop/icon-catalog'
import { WORKSPACE_NAME_MAX } from '@/lib/naming/workspace-name'
import { holdDraftAdmission, isDesktopQuitting, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'
import { cn } from '@/lib/utils'
import { ScrollFade } from '@rerun/ui/primitives'

const VISIBLE_ILLUSTRATIONS = 10

export type DesktopWorkspaceIconSaved = { name: string; iconCatalogId: string | null }

type Props = {
    open: boolean
    onOpenChange: (open: boolean) => void
    // The saved workspace name, as the mounted surfaces show it.
    workspaceName: string
    // The single atomic write returns both durable values, even after a failed initial icon read.
    onSaved: (saved: DesktopWorkspaceIconSaved) => void
}

// The original workspace settings dialog, carrying only its built-in illustration picker: the
// same preview, naming behavior, grid, selection treatment and Save/Cancel footer. Uploading,
// logo links, workspace switching and account or member features stay out of the Mac slice.
export function DesktopWorkspaceSettings({ open, onOpenChange, workspaceName, onSaved }: Props) {
    const [saving, setSaving] = useState(false)
    const quitting = useSyncExternalStore(subscribeDraftShutdown, isDesktopQuitting, () => false)
    const lifetime = useRef({ open, generation: 0, saving: false })
    if (lifetime.current.open !== open) lifetime.current = { open, generation: lifetime.current.generation + 1, saving: false }
    const generation = lifetime.current.generation
    const current = () => lifetime.current.open && lifetime.current.generation === generation
    const change = (next: boolean) => {
        if (!current() || lifetime.current.saving || isDesktopQuitting()) return
        onOpenChange(next)
    }
    useEffect(() => { setSaving(false) }, [generation])
    return <Dialog open={open} onOpenChange={change} asSheet={false} dismissible={!saving && !quitting}>
        <DialogContent className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-lg" showCloseButton={!saving && !quitting}
            onEscapeKeyDown={event => { if (lifetime.current.saving || isDesktopQuitting()) event.preventDefault() }}
            onCloseAutoFocus={event => {
                event.preventDefault()
                if (!lifetime.current.open && !isDesktopQuitting()) document.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]')?.focus({ preventScroll: true })
            }}
            onInteractOutside={event => { if (lifetime.current.saving || isDesktopQuitting()) event.preventDefault() }}>
            {open && <WorkspaceIconForm key={generation} workspaceName={workspaceName} quitting={quitting}
                onSaving={next => { if (current()) { lifetime.current.saving = next; setSaving(next) } }}
                onSaved={saved => { if (current()) onSaved(saved) }}
                onCancel={() => { if (current() && !lifetime.current.saving) onOpenChange(false) }} />}
        </DialogContent>
    </Dialog>
}

function WorkspaceIconForm({ workspaceName, onSaved, onCancel, onSaving, quitting }: { workspaceName: string; onSaved: Props['onSaved']; onCancel: () => void; onSaving: (saving: boolean) => void; quitting: boolean }) {
    const [name, setName] = useState(workspaceName)
    // Null keeps the workspace's current icon, like the original form's `current` draft.
    const [picked, setPicked] = useState<string | null>(null)
    const [savedIcon, setSavedIcon] = useState<string | null>(null)
    const [readAttempt, setReadAttempt] = useState(0)
    const [readError, setReadError] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    const mounted = useRef(true)
    const savingRef = useRef(false)
    const readController = useRef<AbortController | null>(null)
    const readFinished = useRef(false)

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; readController.current?.abort() }
    }, [])

    useEffect(() => {
        const controller = new AbortController()
        readController.current = controller
        readFinished.current = false
        setReadError(false)
        void (async () => {
            try {
                const response = await fetch('/api/desktop/workspace/icon', { signal: controller.signal, cache: 'no-store' })
                if (!response.ok) throw new Error('Could not load the workspace icon. Try again.')
                const result = desktopIconSelection.parse(await response.json())
                if (mounted.current && !controller.signal.aborted && !savingRef.current) {
                    readFinished.current = true
                    setSavedIcon(result.catalogId)
                }
            } catch {
                if (mounted.current && !controller.signal.aborted && !savingRef.current) { readFinished.current = true; setReadError(true) }
            }
        })()
        return () => controller.abort()
    }, [readAttempt])

    const currentUrl = desktopWorkspaceIconUrl(savedIcon)
    const previewSrc = (picked ? desktopWorkspaceIconUrl(picked) : currentUrl) ?? ''
    const selectedUrl = picked ? desktopWorkspaceIconUrl(picked) ?? undefined : currentUrl ?? undefined

    const save = async () => {
        if (!mounted.current || savingRef.current || isDesktopQuitting() || !name.trim()) return
        if (name.trim().length > WORKSPACE_NAME_MAX) { setError(`Use ${WORKSPACE_NAME_MAX} characters or fewer for the workspace name.`); return }
        savingRef.current = true
        onSaving(true)
        setSaving(true)
        setError('')
        // Hold the existing shutdown barrier until the response and mounted-surface bookkeeping
        // settle. Closing/reopening cannot redirect an old form's response into the new form.
        const release = holdDraftAdmission()
        readController.current?.abort()
        try {
            const response = await fetch('/api/desktop/workspace/icon', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), ...(picked ? { catalogId: picked } : {}) }),
                cache: 'no-store',
            })
            if (!response.ok) throw new Error(await responseError(response, 'Could not save workspace settings. Try again.'))
            const saved = desktopIconSelection.extend({ name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX) }).parse(await response.json())
            if (mounted.current) {
                onSaving(false)
                onSaved({ name: saved.name, iconCatalogId: saved.catalogId })
                onCancel()
            }
        } catch (cause) {
            if (mounted.current) {
                setError(cause instanceof Error ? cause.message : 'Could not save workspace settings. Try again.')
                if (!readFinished.current) setReadError(true)
            }
        } finally {
            savingRef.current = false
            if (mounted.current) { setSaving(false); onSaving(false) }
            release()
        }
    }

    return (
        <form className="flex max-h-full min-h-0 flex-1 flex-col" onSubmit={event => { event.preventDefault(); void save() }}>
            <DialogHeader className="px-6 pt-6 pb-4">
                <DialogTitle>Workspace settings</DialogTitle>
                <DialogDescription>Choose a name and illustration for your workspace.</DialogDescription>
            </DialogHeader>
            <ScrollFade className="min-h-0 flex-1 px-6 pt-1 pb-6">
                <div className="space-y-6">
                    <div className="flex items-end gap-4">
                        <div aria-hidden className="relative block size-16 shrink-0 overflow-hidden rounded-2xl bg-muted">
                            <img src={previewSrc || undefined} alt="" className="size-full object-cover" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <Input id="workspace-settings-name" label="Name" required placeholder="e.g. Acme Inc."
                                maxLength={WORKSPACE_NAME_MAX} value={name} disabled={saving || quitting} onChange={event => setName(event.target.value)} />
                        </div>
                    </div>
                    <Field label="Or pick an illustration">
                        <IllustrationGrid selectedUrl={selectedUrl} onPick={setPicked} disabled={saving || quitting} />
                    </Field>
                    {readError && <div role="alert" className="space-y-2 text-sm text-destructive">
                        <p>Could not load the workspace icon. You can still save the name or pick an illustration.</p>
                        <Button type="button" variant="outline" size="sm" disabled={saving || quitting} onClick={() => setReadAttempt(value => value + 1)}>Retry</Button>
                    </div>}
                    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                </div>
            </ScrollFade>
            <DialogFooter className="m-0 shrink-0 px-6 py-4">
                <Button type="button" variant="outline" disabled={saving || quitting} onClick={() => { if (!savingRef.current && !isDesktopQuitting()) onCancel() }}>
                    Cancel
                </Button>
                <Button type="submit" disabled={saving || quitting || !name.trim()}>
                    {saving && <Loader2Icon className="animate-spin" />}
                    {saving ? 'Saving' : 'Save'}
                </Button>
            </DialogFooter>
        </form>
    )
}

async function responseError(response: Response, fallback: string): Promise<string> {
    const body = await response.json().catch(() => null) as { error?: string } | null
    return typeof body?.error === 'string' ? body.error : fallback
}

const desktopIconSelection = z.object({ catalogId: z.string().refine(id => desktopWorkspaceIconUrl(id) !== null).nullable() })

function IllustrationGrid({ selectedUrl, onPick, disabled }: { selectedUrl: string | undefined; onPick: (catalogId: string) => void; disabled: boolean }) {
    const [expanded, setExpanded] = useState(false)
    const icons: readonly DesktopWorkspaceIcon[] = expanded ? DESKTOP_WORKSPACE_ICONS : DESKTOP_WORKSPACE_ICONS.slice(0, VISIBLE_ILLUSTRATIONS)

    return (
        <div className="space-y-2">
            <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
                {icons.map(icon => {
                    const selected = icon.url === selectedUrl
                    return (
                        <button key={icon.id} type="button" disabled={disabled} onClick={() => onPick(icon.id)} aria-pressed={selected} className={cn('relative aspect-square overflow-hidden rounded-lg border transition-colors', selected ? 'border-foreground ring-1 ring-foreground' : 'border-border hover:border-foreground/40')}>
                            <img src={icon.url} alt={icon.desc} className="size-full object-cover" />
                            {selected && (
                                <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-foreground">
                                    <CheckIcon className="size-2.5 text-background" />
                                </span>
                            )}
                        </button>
                    )
                })}
            </div>
            <Button type="button" variant="ghost" size="sm" disabled={disabled} className="-ml-2 text-muted-foreground" onClick={() => setExpanded(value => !value)}>
                {expanded ? 'Show less' : `Show all ${DESKTOP_WORKSPACE_ICONS.length}`}
            </Button>
        </div>
    )
}
