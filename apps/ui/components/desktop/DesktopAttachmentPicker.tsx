'use client'

import { DESKTOP_ATTACHMENT_MAX_BYTES, DESKTOP_ATTACHMENT_MAX_FILES, DESKTOP_ATTACHMENT_TOTAL_MAX_BYTES, isDesktopAttachmentPath } from '@rerun/contracts'
import { useCallback, useState } from 'react'
import { useFileNavigation } from '@/components/files/useFileNavigation'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { ArrowLeftIcon, FileTextIcon, FolderIcon, PaperclipIcon, XIcon } from '@/lib/icons'
import { formatBytes } from '@/lib/files/format'
import type { DesktopAgentView } from './DesktopApp'

type Entry = { name: string; type: 'file' | 'dir'; size: number }

export function AttachmentChip({ path, size, onRemove, disabled }: { path: string; size?: number; onRemove?: () => void; disabled?: boolean }) {
    const name = path.split('/').pop()
    return <span title={path} className="inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
        <FileTextIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="sr-only">Attached file: </span><span className="truncate">{name}</span>
        {size !== undefined && <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{formatBytes(size)}</span>}
        {onRemove && <Button type="button" size="icon-sm" variant="ghost" disabled={disabled} aria-label={`Remove attachment ${name}`} onClick={onRemove}><XIcon className="size-3" /></Button>}
    </span>
}

/** The composer's ordered attachment chips, matching the original attachment row. */
export function AttachmentChips({ paths, disabled, locked, onRemove }: { paths: readonly string[]; disabled?: boolean; locked?: readonly string[]; onRemove?: (path: string) => void }) {
    if (!paths.length) return null
    return <div className="flex flex-wrap items-center gap-1">
        {paths.map(path => <AttachmentChip key={path} path={path} disabled={disabled || !!locked?.includes(path)} onRemove={onRemove ? () => onRemove(path) : undefined} />)}
    </div>
}

function FolderPicker({ agent, selected, sizes, onEntries, onToggle }: {
    agent: DesktopAgentView
    selected: readonly string[]
    sizes: ReadonlyMap<string, number>
    onEntries: (folder: string, entries: readonly Entry[]) => void
    onToggle: (path: string) => void
}) {
    const list = useCallback(async (path: string, hidden: boolean): Promise<Entry[]> => {
        const query = new URLSearchParams({ path })
        if (hidden) query.set('hidden', '1')
        const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agent.id)}/files?${query}`, { cache: 'no-store' })
        const body = await response.json().catch(() => null)
        if (!response.ok || !Array.isArray(body?.entries)) throw new Error(body?.error || 'Could not load workspace files.')
        return body.entries
    }, [agent.id])
    const { currentPath, entries, loading, busy, error, enter, goUp, showHidden, setShowHidden, reload } = useFileNavigation({ list, onDirectoryLoaded: onEntries })
    const knownTotal = selected.reduce((sum, path) => sum + (sizes.get(path) ?? 0), 0)

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
                    const picked = selected.includes(path)
                    const reason = folder ? '' : !isDesktopAttachmentPath(path) ? 'Text or Markdown only'
                        : entry.size > DESKTOP_ATTACHMENT_MAX_BYTES ? 'Too large'
                            : !picked && selected.length >= DESKTOP_ATTACHMENT_MAX_FILES ? 'Up to 10 files'
                                : !picked && knownTotal + entry.size > DESKTOP_ATTACHMENT_TOTAL_MAX_BYTES ? 'Over 128 KiB total' : ''
                    return <li key={entry.name}>
                        <button type="button" disabled={!!reason} onClick={() => folder ? enter(entry.name) : onToggle(path)}
                            aria-pressed={folder ? undefined : picked}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50 disabled:opacity-55">
                            {folder ? <FolderIcon className="size-4 shrink-0" /> : <FileTextIcon className="size-4 shrink-0" />}
                            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                            {picked && !reason && <span className="text-xs text-muted-foreground">Selected</span>}
                            {reason && <span className="text-xs text-muted-foreground">{reason}</span>}
                        </button>
                    </li>
                })}</ul> : <p className="text-sm text-muted-foreground">This folder is empty.</p>}
        </div>
    </>
}

/**
 * The Mac port of the original attachments picker: choose ordered existing text files from this
 * coworker's Files workspace. One click adds a file, a second click removes it, and Done applies
 * the staged order so Cancel never changes the composer.
 */
export function DesktopAttachmentPicker({ agent, disabled, paths, onChange }: {
    agent: DesktopAgentView
    disabled: boolean
    paths: readonly string[]
    onChange: (paths: string[]) => void
}) {
    const [open, setOpen] = useState(false)
    const [selected, setSelected] = useState<string[]>([])
    const [sizes, setSizes] = useState<ReadonlyMap<string, number>>(() => new Map())
    const start = () => {
        setSelected([...paths])
        setSizes(new Map())
        setOpen(true)
    }
    const noteEntries = useCallback((folder: string, entries: readonly Entry[]) => {
        setSizes(current => {
            const next = new Map(current)
            for (const entry of entries) if (entry.type === 'file') next.set(folder ? `${folder}/${entry.name}` : entry.name, entry.size)
            return next
        })
    }, [])
    const toggle = (path: string) => setSelected(current => current.includes(path)
        ? current.filter(item => item !== path)
        : current.length < DESKTOP_ATTACHMENT_MAX_FILES ? [...current, path] : current)
    return <Dialog open={open} onOpenChange={next => { if (next) start(); else setOpen(false) }}>
        <DialogTrigger asChild><Button type="button" size="icon-sm" variant="ghost" title="Attach from Files" disabled={disabled}><PaperclipIcon aria-hidden className="size-4" /><span className="sr-only">Attach from Files</span></Button></DialogTrigger>
        {open && <DialogContent className="flex h-[65dvh] flex-col sm:max-w-lg">
            <DialogHeader>
                <DialogTitle>Attach from Files</DialogTitle>
                <DialogDescription>Choose up to {DESKTOP_ATTACHMENT_MAX_FILES} text or Markdown files from {agent.name}’s workspace, up to {DESKTOP_ATTACHMENT_MAX_BYTES / 1024} KiB each and {DESKTOP_ATTACHMENT_TOTAL_MAX_BYTES / 1024} KiB total. Their contents go to the chat provider when you send.</DialogDescription>
            </DialogHeader>
            <FolderPicker agent={agent} selected={selected} sizes={sizes} onEntries={noteEntries} onToggle={toggle} />
            <DialogFooter className="sm:justify-between">
                <span role="status" className="text-xs text-muted-foreground">{selected.length} of {DESKTOP_ATTACHMENT_MAX_FILES} selected</span>
                <span className="flex gap-2">
                    <DialogClose asChild><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button></DialogClose>
                    <Button type="button" disabled={!selected.length} onClick={() => { onChange(selected); setOpen(false) }}>Done</Button>
                </span>
            </DialogFooter>
        </DialogContent>}
    </Dialog>
}
