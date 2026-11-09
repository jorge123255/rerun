'use client'

import { BrainChromeContext, BrainTopBar, type BrainCrumb } from '@/components/brain/BrainTopBar'
import { FileList } from '@/components/files/FileList'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { importDesktopSharedFile, listDesktopSharedFolder, type DesktopSharedEntry } from '@/lib/desktop/shared-workspace-files'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import type { UploadEntry } from '@/lib/files/upload'
import { FolderIcon } from '@/lib/icons'
import { DesktopSharedFilePreview } from './shared-files/DesktopSharedFilePreview'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { holdDraftAdmission, isDesktopQuitting, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'

// The workspace shared folder. Same FileList, breadcrumb, and text preview as the hosted
// shared Files view. Rename, delete, edit, media, and publication stay out of this slice.
// Optional FileList actions keep the original layout without advertising unavailable mutations.

const ROOT = 'Files'
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
    const [uploading, setUploading] = useState(false)
    const [attempt, setAttempt] = useState(0)
    const current = useRef({ mounted: true, path })
    current.current.path = path
    const importing = useRef<AbortController | null>(null)

    useEffect(() => {
        current.current.mounted = true
        const stop = subscribeDraftShutdown(() => importing.current?.abort())
        return () => { current.current.mounted = false; importing.current?.abort(); stop() }
    }, [])

    useEffect(() => {
        const controller = new AbortController()
        importing.current?.abort()
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
    }, [path, attempt])

    const upload = async (picked: UploadEntry[]) => {
        if (importing.current || !current.current.mounted || isDesktopQuitting()) return
        if (picked.length > 100) { toast.error('Import at most 100 files at a time.'); return }
        const controller = new AbortController()
        importing.current = controller
        const release = holdDraftAdmission()
        setUploading(true)
        const active = () => current.current.mounted && current.current.path === path && !controller.signal.aborted && !isDesktopQuitting()
        try {
            for (const entry of picked) {
                if (!active()) break
                const folder = [path, entry.subDir].filter(Boolean).join('/')
                try { await importDesktopSharedFile(folder, entry.file, controller.signal) }
                catch (error) { if (active()) toast.error(messageOf(error, `Could not confirm import of ${entry.file.name}. Refresh before retrying.`)) }
            }
            if (active()) {
                try {
                    const listing = await listDesktopSharedFolder(path, controller.signal)
                    if (active()) { setEntries(listing.entries); setTruncated(listing.truncated); setFailed(null) }
                } catch (error) { if (active()) setFailed(messageOf(error, 'The shared folder could not be listed.')) }
            }
        } finally {
            if (importing.current === controller) importing.current = null
            if (current.current.mounted) setUploading(false)
            release()
        }
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <BrainTopBar crumbs={folderCrumbs(path, next => onOpen(next, true))} status={truncated ? 'Showing the first 512 entries' : undefined} />
            {uploading && <p role="status" className="px-6 py-2 text-sm text-muted-foreground">Importing files…</p>}
            {failed ? <div className="space-y-2 px-6 py-6"><p role="alert" className="text-sm text-destructive">{failed}</p><Button variant="outline" onClick={() => setAttempt(value => value + 1)}>Retry</Button></div> : <FileList
                title={path.split('/').filter(Boolean).pop() ?? ROOT}
                entries={entries}
                onOpen={entry => onOpen(joinPath(path, entry.name), entry.type === 'dir')}
                emptyDescription="Nothing here yet. Import a text or Markdown file to share it with coworkers that have Read shared files enabled."
                uploadDisabled={uploading || !entries}
                onUpload={picked => void upload(picked)}
            />}
        </div>
    )
}

const SharedFile = DesktopSharedFilePreview

function SharedFilesPanel({ onClose }: { onClose: () => void }) {
    const [selection, setSelection] = useState<{ kind: 'folder' | 'file'; path: string }>({ kind: 'folder', path: '' })
    const [folderEntries, setFolderEntries] = useState<DesktopSharedEntry[] | undefined>()
    const folder = selection.kind === 'file' ? parentPath(selection.path) : selection.path

    useEffect(() => {
        if (selection.kind !== 'file') return
        const controller = new AbortController()
        setFolderEntries(undefined)
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
                    : <SharedFile key={selection.path} path={selection.path} entries={folderEntries} onOpen={open} />}
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
