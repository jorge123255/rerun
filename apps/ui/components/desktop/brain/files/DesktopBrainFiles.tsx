'use client'

import type { BrainSelection } from '@/components/brain/selection'
import { useBrainTranslations } from '@/components/brain/brain-translations'
import { BrainTopBar, type BrainCrumb } from '@/components/brain/BrainTopBar'
import { joinPath, parentPath, type SharedFilesTree } from '@/components/brain/useSharedFilesTree'
import { DesktopSharedFilePreview } from '@/components/desktop/shared-files/DesktopSharedFilePreview'
import { DesktopSharedImportResults } from '@/components/desktop/shared-files/DesktopSharedImportResults'
import { useDesktopSharedDelete } from '@/components/desktop/shared-files/useDesktopSharedDelete'
import { useDesktopSharedSave } from '@/components/desktop/shared-files/useDesktopSharedSave'
import { FileList } from '@/components/files/FileList'
import { renameDesktopSharedFile, type DesktopSharedEntry, type DesktopSharedImportResult } from '@/lib/desktop/shared-workspace-files'
import type { UploadEntry } from '@/lib/files/upload'
import { FolderIcon } from '@/lib/icons'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { holdDraftAdmission, isDesktopQuitting, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'

function folderCrumbs(path: string, rootLabel: string, onSelect: (selection: BrainSelection) => void): BrainCrumb[] {
    const parts = path.split('/').filter(Boolean)
    return [
        { label: rootLabel, icon: FolderIcon, onClick: () => onSelect({ kind: 'folder', path: '' }) },
        ...parts.map((part, index) => ({ label: part, onClick: () => onSelect({ kind: 'folder', path: parts.slice(0, index + 1).join('/') }) })),
    ]
}

function truncatedOf(files: SharedFilesTree, dir: string): boolean {
    const tree = files as SharedFilesTree & { truncatedOf?: (dir: string) => boolean }
    return tree.truncatedOf?.(dir) ?? false
}

/** The shared folder, through the same list the sidebar already loaded. Rename reuses the authorized file-only API and inline menu. */
export function DesktopBrainFolder({ path, files, onSelect, onUpload, importResults, importing, onRetryImport, workspaceId }: {
    path: string
    files: SharedFilesTree & { forget?: (dir: string) => void }
    onSelect: (selection: BrainSelection) => void
    onUpload: (entries: UploadEntry[], dir: string) => void
    importResults: readonly DesktopSharedImportResult[]
    importing: boolean
    onRetryImport: (result: DesktopSharedImportResult) => void
    workspaceId?: number | null
}) {
    const t = useBrainTranslations()
    const rootLabel = t('files.root')
    const { expand } = files
    const { deleting, remove } = useDesktopSharedDelete(workspaceId, path)
    const { available: canSaveLocally, saving, savedName, save } = useDesktopSharedSave(workspaceId, path)
    const pending = useRef<AbortController | null>(null)
    const scope = useRef(path)
    scope.current = path
    const [renaming, setRenaming] = useState(false)
    useEffect(() => {
        const unsubscribe = subscribeDraftShutdown(() => pending.current?.abort())
        return () => { pending.current?.abort(); unsubscribe() }
    }, [])
    useEffect(() => { pending.current?.abort(); setRenaming(false) }, [path])
    const rename = async (name: string, next: string) => {
        if (pending.current || importing || deleting || saving || isDesktopQuitting() || !files.entriesOf(path)?.some(entry => entry.name === name && entry.type !== 'dir')) return
        const controller = new AbortController()
        pending.current = controller
        setRenaming(true)
        const release = holdDraftAdmission()
        const active = () => !controller.signal.aborted && scope.current === path && !isDesktopQuitting()
        try {
            await renameDesktopSharedFile(joinPath(path, name), next, controller.signal)
            if (active()) await files.refresh(path)
        } catch {
            if (active()) toast.error('The rename was not confirmed. Refresh this folder before retrying.')
        } finally {
            if (pending.current === controller) pending.current = null
            if (active()) setRenaming(false)
            release()
        }
    }
    useEffect(() => { if (path) expand(path) }, [path, expand])
    const results = importResults.filter(result => {
        const folder = result.folder ?? ''
        return !path || folder === path || folder.startsWith(`${path}/`)
    })

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <BrainTopBar crumbs={folderCrumbs(path, rootLabel, onSelect)} status={truncatedOf(files, path) ? 'Showing the first 512 entries' : undefined} />
            <DesktopSharedImportResults results={results} disabled={importing || deleting || saving} onRetry={onRetryImport} onOpen={next => onSelect({ kind: 'file', path: next })} />
            {importing && <p role="status" className="px-6 py-2 text-sm text-muted-foreground">Importing files…</p>}
            {savedName && <p role="status" className="px-6 py-2 text-sm text-muted-foreground">Saved {savedName}</p>}
            <FileList
                title={path.split('/').filter(Boolean).pop() ?? rootLabel}
                entries={files.entriesOf(path)}
                onOpen={entry => onSelect({ kind: entry.type === 'dir' ? 'folder' : 'file', path: joinPath(path, entry.name) })}
                onRename={(name, next) => void rename(name, next)}
                canRename={entry => entry.type !== 'dir' && !importing && !renaming && !deleting && !saving}
                canDownload={entry => canSaveLocally && entry.type === 'file' && !!entry.deleteRevision && !importing && !renaming && !deleting && !saving}
                onDownload={(name, entry) => { if (!pending.current) void save(joinPath(path, name), entry.deleteRevision) }}
                downloadLabel="Save As"
                canDelete={entry => !!workspaceId && !!entry.deleteRevision && !importing && !renaming && !deleting && !saving}
                onDelete={async (name, entry) => {
                    const target = joinPath(path, name)
                    if (pending.current || importing || !await remove(target, entry.deleteRevision)) return
                    if (entry.type === 'dir') files.forget?.(target)
                    await files.refresh(path)
                }}
                deleteScope="workspace"
                onUpload={entries => onUpload(entries, path)}
                uploadDisabled={importing || renaming || deleting || saving}
                emptyDescription="Nothing here yet. Import text, images, audio, video, or PDFs for this workspace."
            />
        </div>
    )
}

/** The existing desktop preview. Back returns to the folder that contains the file. */
export function DesktopBrainFile({ path, files, onSelect, workspaceId }: { path: string; files: SharedFilesTree; onSelect: (selection: BrainSelection) => void; workspaceId?: number | null }) {
    const dir = parentPath(path)
    const { expand } = files
    useEffect(() => { expand(dir) }, [dir, expand])
    const listed = files.entriesOf(dir)
    const entries: DesktopSharedEntry[] | undefined = listed?.map(entry => ({ ...entry, type: entry.type === 'dir' ? 'dir' : 'file' }))

    return <DesktopSharedFilePreview
        key={JSON.stringify([workspaceId, path])}
        path={path}
        entries={entries}
        editWorkspaceId={workspaceId}
        onTextSaved={() => { void files.refresh(dir) }}
        onDeleted={() => { void files.refresh(dir) }}
        onOpen={(next, directory) => onSelect(directory ? { kind: 'folder', path: next } : { kind: 'file', path: next })}
    />
}
