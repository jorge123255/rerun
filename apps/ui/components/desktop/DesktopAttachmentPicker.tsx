'use client'

import { DESKTOP_ATTACHMENT_MAX_BYTES, isDesktopAttachmentPath } from '@rerun/contracts'
import { useCallback, useState } from 'react'
import { useFileNavigation } from '@/components/files/useFileNavigation'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { ArrowLeftIcon, FileTextIcon, FolderIcon, PaperclipIcon, XIcon } from '@/lib/icons'
import type { DesktopAgentView } from './DesktopApp'

type Entry = { name: string; type: 'file' | 'dir'; size: number }

export function AttachmentChip({ path, onRemove, disabled }: { path: string; onRemove?: () => void; disabled?: boolean }) {
    const name = path.split('/').pop()
    return <span title={path} className="inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
        <FileTextIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="sr-only">Attached file: </span><span className="truncate">{name}</span>
        {onRemove && <Button type="button" size="icon-sm" variant="ghost" disabled={disabled} aria-label={`Remove attachment ${name}`} onClick={onRemove}><XIcon className="size-3" /></Button>}
    </span>
}

function FolderPicker({ agent, onSelect }: { agent: DesktopAgentView; onSelect: (path: string) => void }) {
    const list = useCallback(async (path: string, hidden: boolean): Promise<Entry[]> => {
        const query = new URLSearchParams({ path })
        if (hidden) query.set('hidden', '1')
        const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agent.id)}/files?${query}`, { cache: 'no-store' })
        const body = await response.json().catch(() => null)
        if (!response.ok || !Array.isArray(body?.entries)) throw new Error(body?.error || 'Could not load workspace files.')
        return body.entries
    }, [agent.id])
    const { currentPath, entries, loading, busy, error, enter, goUp, showHidden, setShowHidden, reload } = useFileNavigation({ list })

    return <>
        <div className="flex items-center gap-2 border-b pb-2">
            <Button size="icon-sm" type="button" variant="ghost" aria-label="Up one folder" disabled={!currentPath || busy} onClick={goUp}><ArrowLeftIcon /></Button>
            <span className="min-w-0 flex-1 break-words text-sm">{currentPath || 'Workspace'}</span>
            <Button type="button" size="sm" variant="ghost" onClick={() => setShowHidden(value => !value)}>{showHidden ? 'Hide hidden files' : 'Show hidden files'}</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={loading || busy}>
            {loading || busy ? <p role="status" className="text-sm text-muted-foreground">Loading files…</p>
                : error ? <div className="space-y-2"><p role="alert">{error}</p><Button type="button" size="sm" variant="outline" onClick={reload}>Retry files</Button></div>
                : entries.length ? <ul className="space-y-1">{entries.map(entry => {
                    const path = currentPath ? `${currentPath}/${entry.name}` : entry.name
                    const folder = entry.type === 'dir'
                    const reason = folder ? '' : !isDesktopAttachmentPath(path) ? 'Text or Markdown only'
                        : entry.size > DESKTOP_ATTACHMENT_MAX_BYTES ? 'Too large' : ''
                    return <li key={entry.name}>
                        <button type="button" disabled={!!reason} onClick={() => folder ? enter(entry.name) : onSelect(path)}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50 disabled:opacity-55">
                            {folder ? <FolderIcon className="size-4 shrink-0" /> : <FileTextIcon className="size-4 shrink-0" />}
                            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                            {reason && <span className="text-xs text-muted-foreground">{reason}</span>}
                        </button>
                    </li>
                })}</ul> : <p className="text-sm text-muted-foreground">This folder is empty.</p>}
        </div>
    </>
}

export function DesktopAttachmentPicker({ agent, disabled, onSelect }: { agent: DesktopAgentView; disabled: boolean; onSelect: (path: string) => void }) {
    const [open, setOpen] = useState(false)
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        <DialogTrigger asChild><Button type="button" size="icon-sm" variant="ghost" title="Attach from Files" disabled={disabled}><PaperclipIcon aria-hidden className="size-4" /><span className="sr-only">Attach from Files</span></Button></DialogTrigger>
        {open && <DialogContent className="flex h-[65dvh] flex-col sm:max-w-lg">
            <DialogHeader>
                <DialogTitle>Attach from Files</DialogTitle>
                <DialogDescription>Choose one text or Markdown file from {agent.name}’s workspace, up to {DESKTOP_ATTACHMENT_MAX_BYTES / 1024} KiB. Its contents go to the chat provider when you send.</DialogDescription>
            </DialogHeader>
            <FolderPicker agent={agent} onSelect={path => { onSelect(path); setOpen(false) }} />
            <DialogFooter><DialogClose asChild><Button type="button" variant="outline">Cancel</Button></DialogClose></DialogFooter>
        </DialogContent>}
    </Dialog>
}
