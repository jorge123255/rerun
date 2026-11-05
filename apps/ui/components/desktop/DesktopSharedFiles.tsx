'use client'

import { BrainChromeContext, BrainTopBar, type BrainCrumb } from '@/components/brain/BrainTopBar'
import { FileList } from '@/components/files/FileList'
import { FilePreview } from '@/components/files/FilePreview'
import { useSiblingFiles } from '@/components/files/useSiblingFiles'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { importDesktopSharedFile, listDesktopSharedFolder, readDesktopSharedPreview, type DesktopSharedEntry } from '@/lib/desktop/shared-workspace-files'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import type { UploadEntry } from '@/lib/files/upload'
import { ChevronLeftIcon, ChevronRightIcon, FileIcon, FolderIcon } from '@/lib/icons'
import { Badge } from '@rerun/ui/primitives'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

// The workspace shared folder. Same FileList, breadcrumb, and text preview as the hosted
// shared Files view. Rename, delete, edit, media, and publication stay out of this slice.
// FileList still draws those menu items; the handlers refuse them and make no request.

const ROOT = 'Files'
const TEXT = /\.(txt|md)$/i
const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const parentPath = (path: string) => path.split('/').filter(Boolean).slice(0, -1).join('/')

function folderCrumbs(path: string, onSelect: (path: string) => void): BrainCrumb[] {
    const parts = path.split('/').filter(Boolean)
    return [
        { label: ROOT, icon: FolderIcon, onClick: () => onSelect('') },
        ...parts.map((part, index) => ({ label: part, onClick: () => onSelect(parts.slice(0, index + 1).join('/')) })),
    ]
}

function messageOf(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback
}

function SharedFolder({ path, onOpen }: { path: string; onOpen: (path: string, directory: boolean) => void }) {
    const [entries, setEntries] = useState<DesktopSharedEntry[] | undefined>()
    const [truncated, setTruncated] = useState(false)
    const [failed, setFailed] = useState<string | null>(null)

    const refresh = useCallback(async () => {
        const listing = await listDesktopSharedFolder(path)
        setEntries(listing.entries)
        setTruncated(listing.truncated)
    }, [path])

    useEffect(() => {
        const controller = new AbortController()
        setEntries(undefined)
        setFailed(null)
        void listDesktopSharedFolder(path, controller.signal)
            .then(listing => {
                if (controller.signal.aborted) return
                setEntries(listing.entries)
                setTruncated(listing.truncated)
            })
            .catch(error => {
                if (controller.signal.aborted) return
                setEntries(undefined)
                setFailed(messageOf(error, 'The shared folder could not be listed.'))
            })
        return () => controller.abort()
    }, [path])

    const upload = async (picked: UploadEntry[]) => {
        for (const entry of picked) {
            const folder = [path, entry.subDir].filter(Boolean).join('/')
            try { await importDesktopSharedFile(folder, entry.file) }
            catch (error) { toast.error(messageOf(error, `Could not import ${entry.file.name}`)) }
        }
        try { await refresh() }
        catch (error) { toast.error(messageOf(error, 'The shared folder could not be listed.')) }
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <BrainTopBar crumbs={folderCrumbs(path, next => onOpen(next, true))} status={truncated ? 'Showing the first 512 entries' : undefined} />
            {failed ? <p className="px-6 py-6 text-sm text-destructive">{failed}</p> : <FileList
                title={path.split('/').filter(Boolean).pop() ?? ROOT}
                entries={entries}
                onOpen={entry => onOpen(joinPath(path, entry.name), entry.type === 'dir')}
                onRename={() => toast.error('Shared files can’t be renamed here.')}
                onDelete={() => toast.error('Shared files can’t be deleted here.')}
                onDownload={() => toast.error('Open a .txt or .md file to preview it. Download isn’t available for shared files.')}
                onUpload={picked => void upload(picked)}
            />}
        </div>
    )
}

function SharedFile({ path, entries, onOpen }: { path: string; entries: DesktopSharedEntry[] | undefined; onOpen: (path: string, directory: boolean) => void }) {
    const dir = parentPath(path)
    const name = path.split('/').pop() ?? path
    const text = TEXT.test(name)
    const [preview, setPreview] = useState<{ path: string; content: string | null; truncated: boolean; error: string | null } | null>(null)

    useEffect(() => {
        if (!text) return
        const controller = new AbortController()
        setPreview(null)
        void readDesktopSharedPreview(path, controller.signal)
            .then(page => { if (!controller.signal.aborted) setPreview({ path, content: page.content, truncated: page.truncated, error: null }) })
            .catch(error => { if (!controller.signal.aborted) setPreview({ path, content: null, truncated: false, error: messageOf(error, 'This file could not be read') }) })
        return () => controller.abort()
    }, [path, text])

    const siblings = useSiblingFiles({
        entries: (entries ?? []).filter(entry => entry.type !== 'dir' && TEXT.test(entry.name)),
        openName: name,
        onOpen: next => onOpen(joinPath(dir, next), false),
    })
    const ready = preview?.path === path ? preview : null

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <BrainTopBar crumbs={[...folderCrumbs(dir, next => onOpen(next, true)), { label: name, icon: FileIcon }]}>
                {siblings && <>
                    <Button size="icon-sm" variant="ghost" onClick={siblings.previous} title="Previous file" aria-label="Previous file"><ChevronLeftIcon className="size-4" /></Button>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{siblings.index + 1} / {siblings.total}</span>
                    <Button size="icon-sm" variant="ghost" onClick={siblings.next} title="Next file" aria-label="Next file"><ChevronRightIcon className="size-4" /></Button>
                </>}
                {ready?.truncated && <Badge size="xs" tone="orange" glow={false}>Truncated</Badge>}
            </BrainTopBar>
            <div className="flex min-h-0 flex-1 flex-col border-t border-border">
                {text ? (
                    ready?.error ? <p className="p-3 text-xs text-destructive">{ready.error}</p> : <FilePreview fileName={name} content={ready?.content ?? null} rawUrl="" loading={!ready} />
                ) : (
                    <p className="p-3 text-xs text-muted-foreground">Only .txt and .md files can be previewed.</p>
                )}
            </div>
        </div>
    )
}

function SharedFilesPanel({ onClose }: { onClose: () => void }) {
    const [selection, setSelection] = useState<{ kind: 'folder' | 'file'; path: string }>({ kind: 'folder', path: '' })
    const [folderEntries, setFolderEntries] = useState<DesktopSharedEntry[] | undefined>()
    const folder = selection.kind === 'file' ? parentPath(selection.path) : selection.path

    useEffect(() => {
        if (selection.kind !== 'file') return
        const controller = new AbortController()
        void listDesktopSharedFolder(folder, controller.signal)
            .then(listing => { if (!controller.signal.aborted) setFolderEntries(listing.entries) })
            .catch(() => { if (!controller.signal.aborted) setFolderEntries([]) })
        return () => controller.abort()
    }, [folder, selection.kind])

    const open = (path: string, directory: boolean) => setSelection(directory ? { kind: 'folder', path } : { kind: 'file', path })

    return (
        <BrainChromeContext.Provider value={{ onClose, onToggleSidebar: null }}>
            <div className="flex min-h-0 flex-1 flex-col">
                {selection.kind === 'folder'
                    ? <SharedFolder path={selection.path} onOpen={open} />
                    : <SharedFile path={selection.path} entries={folderEntries} onOpen={open} />}
            </div>
        </BrainChromeContext.Provider>
    )
}

export function DesktopSharedFiles({ dialogControl, hideTrigger = false, onCloseAutoFocus }: { dialogControl?: DesktopDialogControl; hideTrigger?: boolean; onCloseAutoFocus?: (event: Event) => void }) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    return (
        <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
            {!hideTrigger && <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Shared files</Button></DialogTrigger>}
            {open && <DialogContent onCloseAutoFocus={onCloseAutoFocus} className="flex h-[80dvh] flex-col sm:max-w-5xl">
                <DialogHeader>
                    <DialogTitle>Shared files</DialogTitle>
                    <DialogDescription>The workspace shared folder. Import a .txt or .md file. Coworkers with shared files permission read the same documents. Their private Files stay separate.</DialogDescription>
                </DialogHeader>
                <SharedFilesPanel onClose={() => setOpen(false)} />
            </DialogContent>}
        </Dialog>
    )
}
