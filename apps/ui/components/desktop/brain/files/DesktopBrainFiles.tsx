'use client'

import type { BrainSelection } from '@/components/brain/selection'
import { BrainTopBar, type BrainCrumb } from '@/components/brain/BrainTopBar'
import { joinPath, parentPath, type SharedFilesTree } from '@/components/brain/useSharedFilesTree'
import { DesktopSharedFilePreview } from '@/components/desktop/shared-files/DesktopSharedFilePreview'
import { FileList } from '@/components/files/FileList'
import type { DesktopSharedEntry } from '@/lib/desktop/shared-workspace-files'
import type { UploadEntry } from '@/lib/files/upload'
import { FolderIcon } from '@/lib/icons'
import { useEffect } from 'react'

const ROOT = 'Files'

function folderCrumbs(path: string, onSelect: (selection: BrainSelection) => void): BrainCrumb[] {
    const parts = path.split('/').filter(Boolean)
    return [
        { label: ROOT, icon: FolderIcon, onClick: () => onSelect({ kind: 'folder', path: '' }) },
        ...parts.map((part, index) => ({ label: part, onClick: () => onSelect({ kind: 'folder', path: parts.slice(0, index + 1).join('/') }) })),
    ]
}

function truncatedOf(files: SharedFilesTree, dir: string): boolean {
    const tree = files as SharedFilesTree & { truncatedOf?: (dir: string) => boolean }
    return tree.truncatedOf?.(dir) ?? false
}

/** The shared folder, through the same list the sidebar already loaded. Rename, delete, and download stay out. */
export function DesktopBrainFolder({ path, files, onSelect, onUpload }: { path: string; files: SharedFilesTree; onSelect: (selection: BrainSelection) => void; onUpload: (entries: UploadEntry[], dir: string) => void }) {
    const { expand } = files
    useEffect(() => { if (path) expand(path) }, [path, expand])

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <BrainTopBar crumbs={folderCrumbs(path, onSelect)} status={truncatedOf(files, path) ? 'Showing the first 512 entries' : undefined} />
            <FileList
                title={path.split('/').filter(Boolean).pop() ?? ROOT}
                entries={files.entriesOf(path)}
                onOpen={entry => onSelect({ kind: entry.type === 'dir' ? 'folder' : 'file', path: joinPath(path, entry.name) })}
                onUpload={entries => onUpload(entries, path)}
                emptyDescription="Nothing here yet. Import a text or Markdown file to share it with coworkers that have Read shared files enabled."
            />
        </div>
    )
}

/** The existing desktop preview. Back returns to the folder that contains the file. */
export function DesktopBrainFile({ path, files, onSelect }: { path: string; files: SharedFilesTree; onSelect: (selection: BrainSelection) => void }) {
    const dir = parentPath(path)
    const { expand } = files
    useEffect(() => { expand(dir) }, [dir, expand])
    const listed = files.entriesOf(dir)
    const entries: DesktopSharedEntry[] | undefined = listed?.map(entry => ({ name: entry.name, type: entry.type === 'dir' ? 'dir' : 'file', size: entry.size, modified: entry.modified }))

    return <DesktopSharedFilePreview path={path} entries={entries} onOpen={(next, directory) => onSelect(directory ? { kind: 'folder', path: next } : { kind: 'file', path: next })} />
}
