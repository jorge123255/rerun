'use client'

import { useEffect, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { CheckIcon, Loader2Icon } from '@/lib/icons'
import { DESKTOP_WORKSPACE_ICONS, desktopWorkspaceIconUrl, type DesktopWorkspaceIcon } from '@/lib/desktop/icon-catalog'
import { WORKSPACE_NAME_MAX } from '@/lib/naming/workspace-name'
import { cn } from '@/lib/utils'
import { ScrollFade } from '@rerun/ui/primitives'

const VISIBLE_ILLUSTRATIONS = 10

export type DesktopWorkspaceIconSaved = { name: string; iconCatalogId?: string | null }

type Props = {
    open: boolean
    onOpenChange: (open: boolean) => void
    // The saved workspace name, as the mounted surfaces show it.
    workspaceName: string
    // After both writes resolve: the saved name, and the persisted catalog ID when the saved icon
    // could be read. Null means the workspace has no icon; omitted means the icon state is
    // unknown, so mounted surfaces keep what they already show.
    onSaved: (saved: DesktopWorkspaceIconSaved) => void
}

// The original workspace settings dialog, carrying only its built-in illustration picker: the
// same preview, naming behavior, grid, selection treatment and Save/Cancel footer. Uploading,
// logo links, workspace switching and account or member features stay out of the Mac slice.
export function DesktopWorkspaceSettings({ open, onOpenChange, workspaceName, onSaved }: Props) {
    return <Dialog open={open} onOpenChange={onOpenChange} asSheet={false}>
        <DialogContent className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
            {open && <WorkspaceIconForm workspaceName={workspaceName} onSaved={onSaved} onCancel={() => onOpenChange(false)} />}
        </DialogContent>
    </Dialog>
}

function WorkspaceIconForm({ workspaceName, onSaved, onCancel }: { workspaceName: string; onSaved: Props['onSaved']; onCancel: () => void }) {
    const [name, setName] = useState(workspaceName)
    // Null keeps the workspace's current icon, like the original form's `current` draft.
    const [picked, setPicked] = useState<string | null>(null)
    const [savedIcon, setSavedIcon] = useState<string | null>(null)
    const [iconRead, setIconRead] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')

    useEffect(() => {
        const controller = new AbortController()
        void (async () => {
            try {
                const response = await fetch('/api/desktop/workspace/icon', { signal: controller.signal, cache: 'no-store' })
                if (!response.ok) throw new Error('Could not load the workspace icon. Try again.')
                const result = desktopIconSelection.parse(await response.json())
                if (!controller.signal.aborted) {
                    setSavedIcon(result.catalogId)
                    setIconRead(true)
                }
            } catch {
                if (!controller.signal.aborted) {
                    setIconRead(false)
                    setError('Could not load the workspace icon. Try again.')
                }
            }
        })()
        return () => controller.abort()
    }, [])

    const currentUrl = desktopWorkspaceIconUrl(savedIcon)
    const previewSrc = (picked ? desktopWorkspaceIconUrl(picked) : currentUrl) ?? ''
    const selectedUrl = picked ? desktopWorkspaceIconUrl(picked) ?? undefined : currentUrl ?? undefined

    const save = async () => {
        if (saving || !name.trim()) return
        setSaving(true)
        setError('')
        try {
            const saved = name.trim()
            const response = await fetch('/api/desktop/settings', {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'workspace', name: saved }),
            })
            if (!response.ok) throw new Error(await responseError(response, 'Could not save the workspace name. Try again.'))
            // Sending no illustration is what keeps the workspace's icon, exactly like the original
            // form; an unread icon stays unknown so mounted surfaces keep what they already show.
            let iconCatalogId: string | null | undefined = iconRead ? savedIcon : undefined
            try {
                if (picked) {
                    const iconResponse = await fetch('/api/desktop/workspace/icon', {
                        method: 'PUT',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ catalogId: picked }),
                    })
                    if (!iconResponse.ok) throw new Error(await responseError(iconResponse, 'Could not save the workspace icon. Try again.'))
                    iconCatalogId = picked
                    setSavedIcon(picked)
                    setIconRead(true)
                }
            } catch (cause) {
                // The name is durable either way: report it before surfacing the icon failure.
                onSaved({ name: saved, iconCatalogId })
                throw cause
            }
            onSaved({ name: saved, iconCatalogId })
            onOpenChange(false)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not save workspace settings. Try again.')
        } finally {
            setSaving(false)
        }
    }

    return (
        <form className="flex max-h-full min-h-0 flex-1 flex-col" onSubmit={event => { event.preventDefault(); void save() }}>
            <DialogHeader className="px-6 pt-6 pb-4">
                <DialogTitle>Workspace settings</DialogTitle>
                <p className="text-sm text-muted-foreground">Your workspace name and logo, as your team and your invitations see them.</p>
            </DialogHeader>
            <ScrollFade className="min-h-0 flex-1 px-6 pt-1 pb-6">
                <div className="space-y-6">
                    <div className="flex items-end gap-4">
                        <div aria-hidden className="relative block size-16 shrink-0 overflow-hidden rounded-2xl bg-muted">
                            <img src={previewSrc || undefined} alt="" className="size-full object-cover" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <Input id="workspace-settings-name" label="Name" required placeholder="e.g. Acme Inc."
                                maxLength={WORKSPACE_NAME_MAX} value={name} onChange={event => setName(event.target.value)} />
                        </div>
                    </div>
                    <Field label="Or pick an illustration">
                        <IllustrationGrid selectedUrl={selectedUrl} onPick={setPicked} />
                    </Field>
                    {error && <p className="text-sm text-destructive">{error}</p>}
                </div>
            </ScrollFade>
            <DialogFooter className="m-0 shrink-0 px-6 py-4">
                <Button type="button" variant="outline" onClick={onCancel}>
                    Cancel
                </Button>
                <Button type="submit" disabled={saving || !name.trim()}>
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

const desktopIconSelection = z.object({ catalogId: z.string().nullable() })

function IllustrationGrid({ selectedUrl, onPick }: { selectedUrl: string | undefined; onPick: (catalogId: string) => void }) {
    const [expanded, setExpanded] = useState(false)
    const icons: readonly DesktopWorkspaceIcon[] = expanded ? DESKTOP_WORKSPACE_ICONS : DESKTOP_WORKSPACE_ICONS.slice(0, VISIBLE_ILLUSTRATIONS)

    return (
        <div className="space-y-2">
            <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
                {icons.map(icon => {
                    const selected = icon.url === selectedUrl
                    return (
                        <button key={icon.id} type="button" onClick={() => onPick(icon.id)} aria-pressed={selected} className={cn('relative aspect-square overflow-hidden rounded-lg border transition-colors', selected ? 'border-foreground ring-1 ring-foreground' : 'border-border hover:border-foreground/40')}>
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
            <Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={() => setExpanded(value => !value)}>
                {expanded ? 'Show less' : `Show all ${DESKTOP_WORKSPACE_ICONS.length}`}
            </Button>
        </div>
    )
}
