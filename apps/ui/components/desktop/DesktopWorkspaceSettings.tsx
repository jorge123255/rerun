'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { FileDropzone } from '@rerun/ui/forms'
import { Input } from '@/components/ui/input'
import { CheckIcon, Loader2Icon, UploadIcon } from '@/lib/icons'
import { DESKTOP_WORKSPACE_ICONS, DESKTOP_WORKSPACE_LOGO_ACCEPT, desktopWorkspaceIconSelectionUrl, desktopWorkspaceIconUrl, type DesktopWorkspaceIcon, type DesktopWorkspaceSavedIcon } from '@/lib/desktop/icon-catalog'
import { WORKSPACE_NAME_MAX } from '@/lib/naming/workspace-name'
import { holdDraftAdmission, isDesktopQuitting, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'
import { cn } from '@/lib/utils'
import { ScrollFade } from '@rerun/ui/primitives'

const VISIBLE_ILLUSTRATIONS = 10

// The saved-icon descriptor keeps the illustration slice's shape and adds the uploaded raster's
// opaque identity, so existing readers keep working.
export type DesktopWorkspaceIconSaved = {
    name: string
    iconCatalogId: string | null
    iconUploadId?: string | null
}

type Props = {
    open: boolean
    onOpenChange: (open: boolean) => void
    // The saved workspace name, as the mounted surfaces show it.
    workspaceName: string
    // The single atomic write returns both durable values, even after a failed initial icon read.
    onSaved: (saved: DesktopWorkspaceIconSaved) => void
}

// The original workspace settings dialog, carrying its built-in illustration picker and its
// choose/drop logo upload: the same preview, naming behavior, grid, selection treatment and
// Save/Cancel footer. Website-logo links, workspace switching and account or member features
// stay out of the Mac slice.
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

// The original form's logo draft: the workspace's current icon, a catalog illustration or the
// chosen upload with its local object URL.
type LogoDraft = { kind: 'current' } | { kind: 'catalog'; catalogId: string } | { kind: 'upload'; file: File; previewUrl: string }

function WorkspaceIconForm({ workspaceName, onSaved, onCancel, onSaving, quitting }: { workspaceName: string; onSaved: Props['onSaved']; onCancel: () => void; onSaving: (saving: boolean) => void; quitting: boolean }) {
    const [name, setName] = useState(workspaceName)
    // Null keeps the workspace's current icon, like the original form's `current` draft.
    const [draft, setDraft] = useState<LogoDraft>({ kind: 'current' })
    const [savedIcon, setSavedIcon] = useState<DesktopWorkspaceSavedIcon>({ iconCatalogId: null, iconUploadId: null })
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
                    setSavedIcon({ iconCatalogId: result.catalogId, iconUploadId: result.uploadId ?? null })
                }
            } catch {
                if (mounted.current && !controller.signal.aborted && !savingRef.current) { readFinished.current = true; setReadError(true) }
            }
        })()
        return () => controller.abort()
    }, [readAttempt])

    // The original's logoDraftSrc: the draft's own preview, else the workspace's current icon.
    const currentUrl = desktopWorkspaceIconSelectionUrl(savedIcon)
    const previewSrc = draft.kind === 'upload' ? draft.previewUrl
        : draft.kind === 'catalog' ? desktopWorkspaceIconUrl(draft.catalogId)
        : currentUrl ?? ''
    const selectedUrl = draft.kind === 'catalog' ? desktopWorkspaceIconUrl(draft.catalogId) ?? undefined
        : draft.kind === 'current' ? currentUrl ?? undefined
        : undefined

    const uploadPreviewUrl = draft.kind === 'upload' ? draft.previewUrl : null
    useEffect(() => {
        if (!uploadPreviewUrl) return
        return () => URL.revokeObjectURL(uploadPreviewUrl)
    }, [uploadPreviewUrl])

    const upload = (file: File | undefined) => {
        if (!file || savingRef.current || isDesktopQuitting()) return
        setDraft({ kind: 'upload', file, previewUrl: URL.createObjectURL(file) })
    }

    const pickIllustration = (catalogId: string) => {
        if (savingRef.current || isDesktopQuitting()) return
        setDraft({ kind: 'catalog', catalogId })
    }

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
            // One original workspace-settings save: the name rides with the selected icon, whether
            // that is an illustration or the chosen upload's raster.
            const response = draft.kind === 'upload'
                ? await saveLogoUpload(name.trim(), draft.file)
                : await saveCatalogSelection(name.trim(), draft)
            if (!response.ok) throw new Error(await responseError(response, 'Could not save workspace settings. Try again.'))
            const saved = desktopIconSaved.parse(await response.json())
            if (mounted.current) {
                onSaving(false)
                onSaved({ name: saved.name, iconCatalogId: saved.catalogId, ...(saved.uploadId ? { iconUploadId: saved.uploadId } : {}) })
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
                <DialogDescription>Choose a name and logo for your workspace.</DialogDescription>
            </DialogHeader>
            <ScrollFade className="min-h-0 flex-1 px-6 pt-1 pb-6">
                <div className="space-y-6">
                    <div className="flex items-end gap-4">
                        <FileDropzone onFiles={files => upload(files[0])} accept={DESKTOP_WORKSPACE_LOGO_ACCEPT} overlayLabel="" disabled={saving || quitting} className="shrink-0">
                            {({ inputId }) => (
                                <label htmlFor={inputId} aria-label="Upload a logo" className="group relative block size-16 cursor-pointer">
                                    <img src={previewSrc || undefined} alt="" className="size-full rounded-2xl bg-muted object-cover" />
                                    <span className="absolute -right-1 -bottom-1 flex size-6 items-center justify-center rounded-full border bg-background shadow-sm transition-colors group-hover:bg-muted">
                                        <UploadIcon className="size-3.5" />
                                    </span>
                                </label>
                            )}
                        </FileDropzone>
                        <div className="min-w-0 flex-1">
                            <Input id="workspace-settings-name" label="Name" required placeholder="e.g. Acme Inc."
                                maxLength={WORKSPACE_NAME_MAX} value={name} disabled={saving || quitting} onChange={event => setName(event.target.value)} />
                        </div>
                    </div>
                    <Field label="Or pick an illustration">
                        <IllustrationGrid selectedUrl={selectedUrl} onPick={pickIllustration} disabled={saving || quitting} />
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

async function saveCatalogSelection(name: string, draft: LogoDraft): Promise<Response> {
    return fetch('/api/desktop/workspace/icon', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, ...(draft.kind === 'catalog' ? { catalogId: draft.catalogId } : {}) }),
        cache: 'no-store',
    })
}

async function saveLogoUpload(name: string, file: File): Promise<Response> {
    // The original uploads the chosen file with the name in one form submission.
    const formData = new FormData()
    formData.set('name', name)
    formData.set('logoFile', file)
    return fetch('/api/desktop/workspace/icon', { method: 'PUT', body: formData, cache: 'no-store' })
}

async function responseError(response: Response, fallback: string): Promise<string> {
    const body = await response.json().catch(() => null) as { error?: string } | null
    return typeof body?.error === 'string' ? body.error : fallback
}

const desktopIconSelection = z.object({
    catalogId: z.string().refine(id => desktopWorkspaceIconUrl(id) !== null).nullable(),
    uploadId: z.string().min(1).optional(),
})

const desktopIconSaved = desktopIconSelection.extend({ name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX) })

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
