'use client'

import type { FileEntry } from '@/app/api/_actions/workspace-file.actions'
import type { BrainSelection } from '@/components/brain/selection'
import { useBrainTranslations } from '@/components/brain/brain-translations'
import { BrainTopBar, type BrainCrumb } from '@/components/brain/BrainTopBar'
import { joinPath, parentPath, type SharedFilesTree } from '@/components/brain/useSharedFilesTree'
import { DesktopSharedFilePreview } from '@/components/desktop/shared-files/DesktopSharedFilePreview'
import { DesktopSharedImportResults } from '@/components/desktop/shared-files/DesktopSharedImportResults'
import { useDesktopSharedDelete } from '@/components/desktop/shared-files/useDesktopSharedDelete'
import { useDesktopSharedSave } from '@/components/desktop/shared-files/useDesktopSharedSave'
import { FileList } from '@/components/files/FileList'
import { renameDesktopSharedEntry, type DesktopSharedEntry, type DesktopSharedImportResult } from '@/lib/desktop/shared-workspace-files'
import type { UploadEntry } from '@/lib/files/upload'
import { FolderIcon } from '@/lib/icons'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { holdDraftAdmission, isDesktopQuitting, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'
import { useDesktopLocale } from '../../DesktopLocale'

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
    const { t: desktop } = useDesktopLocale()
    const rootLabel = t('files.root')
    const { expand } = files
    const { deleting, remove } = useDesktopSharedDelete(workspaceId, path)
    const { available: canSaveLocally, saving, savedName, save } = useDesktopSharedSave(workspaceId, path)
    const pending = useRef<AbortController | null>(null)
    const scope = useRef({ path, workspaceId })
    scope.current = { path, workspaceId }
    const [renaming, setRenaming] = useState(false)
    useEffect(() => {
        const unsubscribe = subscribeDraftShutdown(() => pending.current?.abort())
        return () => { pending.current?.abort(); unsubscribe() }
    }, [])
    useEffect(() => { pending.current?.abort(); setRenaming(false) }, [path, workspaceId])
    const rename = async (entry: FileEntry, next: string) => {
        if (!workspaceId || !entry.deleteRevision || pending.current || importing || deleting || saving || isDesktopQuitting()) return
        const controller = new AbortController()
        pending.current = controller
        setRenaming(true)
        const release = holdDraftAdmission()
        const active = () => !controller.signal.aborted && scope.current.path === path
            && scope.current.workspaceId === workspaceId && !isDesktopQuitting()
        const source = joinPath(path, entry.name)
        try {
            const renamed = await renameDesktopSharedEntry(workspaceId, source, next, entry.deleteRevision, controller.signal)
            if (active()) {
                if (entry.type === 'dir' && renamed.path !== source) {
                    files.forget?.(source)
                    if (files.expanded.has(source)) expand(renamed.path)
                }
                await files.refresh(path)
            }
        } catch (error) {
            if (active()) toast.error(error instanceof Error ? error.message : 'The rename was not confirmed. Refresh this folder before retrying.')
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
            <BrainTopBar crumbs={folderCrumbs(path, rootLabel, onSelect)} status={truncatedOf(files, path) ? desktop('sharedFiles.truncated') : undefined} />
            <DesktopSharedImportResults results={results} disabled={importing || deleting || saving} onRetry={onRetryImport} onOpen={next => onSelect({ kind: 'file', path: next })} />
            {importing && <p role="status" className="px-6 py-2 text-sm text-muted-foreground">{desktop('sharedFiles.importing')}</p>}
            {savedName && <p role="status" className="px-6 py-2 text-sm text-muted-foreground">{desktop('sharedFiles.saved', { name: savedName })}</p>}
            <FileList
                key={`${workspaceId}:${path}`}
                title={path.split('/').filter(Boolean).pop() ?? rootLabel}
                entries={files.entriesOf(path)}
                onOpen={entry => onSelect({ kind: entry.type === 'dir' ? 'folder' : 'file', path: joinPath(path, entry.name) })}
                onRename={(_name, next, entry) => void rename(entry, next)}
                canRename={entry => !!workspaceId && !!entry.deleteRevision && !importing && !renaming && !deleting && !saving}
                canDownload={entry => canSaveLocally && entry.type === 'file' && !!entry.deleteRevision && !importing && !renaming && !deleting && !saving}
                onDownload={(name, entry) => { if (!pending.current) void save(joinPath(path, name), entry.deleteRevision) }}
                downloadLabel={desktop('sharedFiles.saveAs')}
                canDelete={entry => !!workspaceId && !!entry.deleteRevision && !importing && !renaming && !deleting && !saving}
                onDelete={async (name, entry) => {
                    const target = joinPath(path, name)
                    if (pending.current || importing || !await remove(target, entry.deleteRevision)) return
                    if (entry.type === 'dir') files.forget?.(target)
                    await files.refresh(path)
                }}
                deleteDescription={{ file: desktop('sharedFiles.deleteFile'), folder: desktop('sharedFiles.deleteFolder') }}
                onUpload={entries => onUpload(entries, path)}
                uploadDisabled={importing || renaming || deleting || saving}
                emptyDescription={desktop('sharedFiles.empty')}
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
