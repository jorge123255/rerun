'use client'

import { BrainChromeContext, BrainTopBar, type BrainCrumb } from '@/components/brain/BrainTopBar'
import { FileList } from '@/components/files/FileList'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { importDesktopSharedFiles, listDesktopSharedFolder, renameDesktopSharedEntry, type DesktopSharedEntry, type DesktopSharedImportResult } from '@/lib/desktop/shared-workspace-files'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import type { UploadEntry } from '@/lib/files/upload'
import { FolderIcon } from '@/lib/icons'
import { useDesktopLocale } from './DesktopLocale'
import { DesktopSharedFilePreview } from './shared-files/DesktopSharedFilePreview'
import { DesktopSharedImportResults } from './shared-files/DesktopSharedImportResults'
import { useDesktopSharedDelete } from './shared-files/useDesktopSharedDelete'
import { useDesktopSharedSave } from './shared-files/useDesktopSharedSave'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { holdDraftAdmission, isDesktopQuitting, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'

// The workspace shared folder. Same FileList, breadcrumb, and text preview as the hosted
// shared Files view. Renames stay within the selected folder.
// Optional FileList actions keep the original layout without advertising unavailable mutations.

const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const parentPath = (path: string) => path.split('/').filter(Boolean).slice(0, -1).join('/')

function folderCrumbs(path: string, rootLabel: string, onSelect: (path: string) => void): BrainCrumb[] {
    const parts = path.split('/').filter(Boolean)
    return [
        { label: rootLabel, icon: FolderIcon, onClick: () => onSelect('') },
        ...parts.map((part, index) => ({ label: part, onClick: () => onSelect(parts.slice(0, index + 1).join('/')) })),
    ]
}

function messageOf(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback
}

function SharedFolder({ path, onOpen, workspaceId }: { path: string; onOpen: (path: string, directory: boolean) => void; workspaceId?: number | null }) {
    const { t } = useDesktopLocale()
    const rootLabel = t('brain.files.root')
    const { deleting, remove } = useDesktopSharedDelete(workspaceId, path)
    const { available: canSaveLocally, saving, savedName, save } = useDesktopSharedSave(workspaceId, path)
    const [entries, setEntries] = useState<DesktopSharedEntry[] | undefined>()
    const [truncated, setTruncated] = useState(false)
    const [failed, setFailed] = useState<string | null>(null)
    const [uploading, setUploading] = useState(false)
    const [renaming, setRenaming] = useState(false)
    const [results, setResults] = useState<DesktopSharedImportResult[]>([])
    const [attempt, setAttempt] = useState(0)
    const current = useRef({ mounted: true, path, workspaceId })
    current.current = { ...current.current, path, workspaceId }
    const importing = useRef<AbortController | null>(null)
    const originalFiles = useRef(new WeakMap<DesktopSharedImportResult, File>())

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
    }, [path, workspaceId, attempt])

    const upload = async (picked: UploadEntry[]) => {
        if (saving || deleting || importing.current || !current.current.mounted || isDesktopQuitting()) return
        if (picked.length > 16) { toast.error('Import at most 16 files at a time.'); return }
        if (picked.reduce((total, entry) => total + entry.file.size, 0) > 32 * 1024 * 1024) { toast.error('Import at most 32 MB at a time.'); return }
        const controller = new AbortController()
        importing.current = controller
        const release = holdDraftAdmission()
        setUploading(true)
        const active = () => current.current.mounted && current.current.path === path && !controller.signal.aborted && !isDesktopQuitting()
        try {
            const groups = new Map<string, File[]>()
            for (const entry of picked) {
                const folder = entry.subDir ? joinPath(path, entry.subDir) : path
                const files = groups.get(folder) ?? []
                files.push(entry.file)
                groups.set(folder, files)
            }
            const imported: DesktopSharedImportResult[] = []
            for (const [folder, files] of groups) {
                if (!active()) return
                let groupResults: DesktopSharedImportResult[]
                try {
                    groupResults = await importDesktopSharedFiles(folder, files, controller.signal)
                } catch (error) {
                    if (!active()) return
                    groupResults = files.map(file => ({ name: file.name, folder, status: 'uncertain', message: messageOf(error, 'This import could not be confirmed. Inspect Shared files before trying again.') }))
                }
                groupResults.forEach((result, index) => {
                    const file = files[index]
                    if (file) originalFiles.current.set(result, file)
                })
                imported.push(...groupResults)
                if (active()) setResults([...imported])
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

    const retry = async (result: DesktopSharedImportResult) => {
        if (saving || deleting || importing.current || result.status !== 'refused' || !current.current.mounted || isDesktopQuitting()) return
        const folder = result.folder ?? path
        const file = originalFiles.current.get(result)
        if (!file) return
        const controller = new AbortController()
        importing.current = controller
        const release = holdDraftAdmission()
        setUploading(true)
        const active = () => current.current.mounted && current.current.path === path && !controller.signal.aborted && !isDesktopQuitting()
        try {
            const imported = await importDesktopSharedFiles(folder, [file], controller.signal)
            const next = imported[0]
            if (active() && next) {
                originalFiles.current.set(next, file)
                setResults(current => current.map(item => item === result ? next : item))
            }
            if (active() && imported.some(item => item.status === 'created')) {
                try {
                    const listing = await listDesktopSharedFolder(path, controller.signal)
                    if (active()) { setEntries(listing.entries); setTruncated(listing.truncated); setFailed(null) }
                } catch (error) { if (active()) setFailed(messageOf(error, 'The shared folder could not be listed.')) }
            }
        } catch (error) {
            if (active()) setResults(current => current.map(item => item === result
                ? { ...item, status: 'uncertain', message: messageOf(error, 'This import could not be confirmed. Inspect Shared files before trying again.') }
                : item))
        } finally {
            if (importing.current === controller) importing.current = null
            if (current.current.mounted) setUploading(false)
            release()
        }
    }

    const rename = async (name: string, next: string, revision?: string) => {
        if (!workspaceId || !revision || saving || deleting || importing.current || !current.current.mounted || isDesktopQuitting()) return
        const controller = new AbortController()
        importing.current = controller
        const release = holdDraftAdmission()
        setRenaming(true)
        const active = () => current.current.mounted && current.current.path === path && current.current.workspaceId === workspaceId
            && !controller.signal.aborted && !isDesktopQuitting()
        try {
            await renameDesktopSharedEntry(workspaceId, joinPath(path, name), next, revision, controller.signal)
            if (active()) setAttempt(value => value + 1)
        } catch (error) {
            if (active()) toast.error(messageOf(error, 'The rename was not confirmed. Refresh Shared files before retrying.'))
        } finally {
            if (importing.current === controller) importing.current = null
            if (current.current.mounted) setRenaming(false)
            release()
        }
    }

    const busy = uploading || renaming || deleting || saving
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <BrainTopBar crumbs={folderCrumbs(path, rootLabel, next => onOpen(next, true))} status={truncated ? t('sharedFiles.truncated') : undefined} />
            <DesktopSharedImportResults results={results} disabled={busy} onRetry={result => void retry(result)} onOpen={path => onOpen(path, false)} />
            {uploading && <p role="status" className="px-6 py-2 text-sm text-muted-foreground">{t('sharedFiles.importing')}</p>}
            {savedName && <p role="status" className="px-6 py-2 text-sm text-muted-foreground">{t('sharedFiles.saved', { name: savedName })}</p>}
            {failed ? <div className="space-y-2 px-6 py-6"><p role="alert" className="text-sm text-destructive">{failed}</p><Button variant="outline" onClick={() => setAttempt(value => value + 1)}>{t('brain.workspace.retry')}</Button></div> : <FileList
                key={path}
                title={path.split('/').filter(Boolean).pop() ?? rootLabel}
                entries={entries}
                onOpen={entry => onOpen(joinPath(path, entry.name), entry.type === 'dir')}
                emptyDescription={t('sharedFiles.empty')}
                canRename={entry => !!workspaceId && !!entry.deleteRevision && !busy}
                onRename={(name, next, entry) => void rename(name, next, entry.deleteRevision)}
                canDownload={entry => canSaveLocally && entry.type === 'file' && !!entry.deleteRevision && !busy}
                onDownload={(name, entry) => { if (!importing.current) void save(joinPath(path, name), entry.deleteRevision) }}
                downloadLabel={t('sharedFiles.saveAs')}
                canDelete={entry => !!workspaceId && !!entry.deleteRevision && !busy}
                onDelete={async (name, entry) => {
                    if (!importing.current && await remove(joinPath(path, name), entry.deleteRevision)) setAttempt(value => value + 1)
                }}
                deleteDescription={{ file: t('sharedFiles.deleteFile'), folder: t('sharedFiles.deleteFolder') }}
                uploadDisabled={busy || !entries}
                onUpload={picked => void upload(picked)}
            />}
        </div>
    )
}

function SharedFilesPanel({ onClose, workspaceId }: { onClose: () => void; workspaceId?: number | null }) {
    const [selection, setSelection] = useState<{ kind: 'folder' | 'file'; path: string }>({ kind: 'folder', path: '' })
    const [folderEntries, setFolderEntries] = useState<DesktopSharedEntry[] | undefined>()
    const [listingRevision, refreshListing] = useState(0)
    const folder = selection.kind === 'file' ? parentPath(selection.path) : selection.path

    useEffect(() => {
        if (selection.kind !== 'file') return
        const controller = new AbortController()
        setFolderEntries(undefined)
        void listDesktopSharedFolder(folder, controller.signal)
            .then(listing => { if (!controller.signal.aborted) setFolderEntries(listing.entries) })
            .catch(() => { if (!controller.signal.aborted) setFolderEntries([]) })
        return () => controller.abort()
    }, [folder, selection.kind, listingRevision])

    const open = (path: string, directory: boolean) => setSelection(directory ? { kind: 'folder', path } : { kind: 'file', path })

    return (
        <BrainChromeContext.Provider value={{ onClose, onToggleSidebar: null }}>
            <div className="flex min-h-0 flex-1 flex-col">
                {selection.kind === 'folder'
                    ? <SharedFolder path={selection.path} onOpen={open} workspaceId={workspaceId} />
                    : <DesktopSharedFilePreview key={selection.path} path={selection.path} entries={folderEntries} onOpen={open}
                        editWorkspaceId={workspaceId} onTextSaved={() => refreshListing(value => value + 1)} />}
            </div>
        </BrainChromeContext.Provider>
    )
}

export function DesktopSharedFiles({ dialogControl, hideTrigger = false, onCloseAutoFocus, workspaceId }: {
    dialogControl?: DesktopDialogControl; hideTrigger?: boolean; onCloseAutoFocus?: (event: Event) => void; workspaceId?: number | null
}) {
    const { t } = useDesktopLocale()
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    return (
        <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
            {!hideTrigger && <DialogTrigger asChild><Button type="button" variant="outline" size="sm">{t('sharedFiles.title')}</Button></DialogTrigger>}
            {open && <DialogContent onCloseAutoFocus={onCloseAutoFocus} className="flex h-[80dvh] flex-col sm:max-w-5xl">
                <DialogHeader>
                    <DialogTitle>{t('sharedFiles.title')}</DialogTitle>
                    <DialogDescription>{t('sharedFiles.description')}</DialogDescription>
                </DialogHeader>
                <SharedFilesPanel key={workspaceId ?? 'loading'} workspaceId={workspaceId} onClose={() => setOpen(false)} />
            </DialogContent>}
        </Dialog>
    )
}
