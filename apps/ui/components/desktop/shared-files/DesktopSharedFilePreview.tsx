'use client'

import { BrainTopBar, type BrainCrumb } from '@/components/brain/BrainTopBar'
import { FilePreview } from '@/components/files/FilePreview'
import { FileEditorDialog } from '@/components/files/FileEditorDialog'
import type { SaveFileResult } from '@/app/api/_services/file.service'
import { filePreviewKind } from '@/lib/files/preview'
import { useSiblingFiles } from '@/components/files/useSiblingFiles'
import { Button } from '@/components/ui/button'
import { PanelDeleteButton, PanelEditorHeader } from '@/components/ui/panel-editor'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { desktopFileDraftHost, holdDraftAdmission, isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { readDesktopSharedPreview, replaceDesktopSharedText, type DesktopSharedEntry, type DesktopSharedTextIdentity } from '@/lib/desktop/shared-workspace-files'
import { sharedMediaUrl } from '@/lib/desktop/shared-file-previews'
import { DownloadIcon, FileIcon, FolderIcon } from '@/lib/icons'
import { Badge } from '@rerun/ui/primitives'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { DesktopFileImagePreview } from '../DesktopFileImagePreview'
import { DesktopFileAudioPreview } from '../DesktopFileAudioPreview'
import { DesktopFileVideoPreview } from '../DesktopFileVideoPreview'
import { DesktopFilePdfPreview } from '../DesktopFilePdfPreview'
import { FileSiblingControls, useFileSiblingKeys } from '../DesktopFileSiblingNav'
import { useDesktopSharedDelete } from './useDesktopSharedDelete'
import { useDesktopSharedSave } from './useDesktopSharedSave'

const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const parentPath = (path: string) => path.split('/').filter(Boolean).slice(0, -1).join('/')

function folderCrumbs(path: string, onSelect: (path: string) => void): BrainCrumb[] {
    const parts = path.split('/').filter(Boolean)
    return [
        { label: 'Files', icon: FolderIcon, onClick: () => onSelect('') },
        ...parts.map((part, index) => ({ label: part, onClick: () => onSelect(parts.slice(0, index + 1).join('/')) })),
    ]
}

function messageOf(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback
}

export function DesktopSharedFilePreview({ path, entries, onOpen, editWorkspaceId, onTextSaved, onDeleted }: {
    path: string
    entries: DesktopSharedEntry[] | undefined
    onOpen: (path: string, directory: boolean) => void
    editWorkspaceId?: number | null
    onTextSaved?: () => void
    onDeleted?: () => void
}) {
    const dir = parentPath(path)
    const name = path.split('/').pop() ?? path
    const kind = filePreviewKind(name)
    const text = kind === 'text'
    const [preview, setPreview] = useState<{ path: string; content: string | null; truncated: boolean; error: string | null; editIdentity?: DesktopSharedTextIdentity | null; deleteRevision?: string } | null>(null)
    const viewerRef = useRef<HTMLDivElement>(null)
    const [attempt, setAttempt] = useState(0)
    const [previewHash, setPreviewHash] = useState<string | null>(null)
    const { available: canSaveLocally, saving, savedName, save } = useDesktopSharedSave(editWorkspaceId, path)
    const [editing, setEditing] = useState(false)
    const editBase = useRef<DesktopSharedTextIdentity | null>(null)
    const savedDeleteRevision = useRef<string | undefined>(undefined)
    const editController = useRef<AbortController | null>(null)
    const { deleting, remove } = useDesktopSharedDelete(editWorkspaceId, path)
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
    const listedRevision = entries?.find(entry => entry.type === 'file' && entry.name === name)?.deleteRevision
    const [selection, setSelection] = useState<{ path: string; revision: string } | null>(null)
    if (listedRevision && selection?.path !== path) setSelection({ path, revision: listedRevision })
    const navigationBlocked = saving || deleting || !!confirmDelete || editing
    const goTo = (next: string, directory: boolean) => {
        if (!navigationBlocked && !isDesktopQuitting()) onOpen(next, directory)
    }

    useEffect(() => {
        if (!text) return
        const controller = new AbortController()
        setPreview(null)
        void readDesktopSharedPreview(path, controller.signal)
            .then(page => { if (!controller.signal.aborted) {
                setPreview({ path, content: page.content, truncated: page.truncated, error: null, editIdentity: page.editIdentity, deleteRevision: page.deleteRevision })
            } })
            .catch(error => { if (!controller.signal.aborted) setPreview({ path, content: null, truncated: false, error: messageOf(error, 'This file could not be read') }) })
        return () => controller.abort()
    }, [path, text, attempt])

    useEffect(() => () => { editController.current?.abort() }, [path])

    const siblings = useSiblingFiles({
        entries: entries ?? [],
        openName: name,
        onOpen: next => goTo(joinPath(dir, next), false),
    })
    const visibleSiblings = navigationBlocked ? null : siblings
    useFileSiblingKeys(visibleSiblings, viewerRef)
    const ready = preview?.path === path ? preview : null
    // The shared editor preserves LF or CRLF. Keep mixed and bare-CR files read-only.
    const lineBreaks = ready?.content?.replace(/\r\n/g, '')
    const canEdit = !!editWorkspaceId && !!ready?.editIdentity && !ready.truncated && ready.content != null
        && !lineBreaks?.includes('\r') && !(ready.content.includes('\r\n') && lineBreaks?.includes('\n'))
    const back = () => goTo(dir, true)
    const selectedRevision = selection?.path === path && selection.revision === listedRevision ? selection.revision : undefined
    const displayedRevision = text ? ready?.deleteRevision : selectedRevision
    const deleteRevision = displayedRevision === listedRevision ? displayedRevision : undefined
    const saveVersion = text && !ready?.error ? deleteRevision : selectedRevision

    async function saveText(content: string, baseHash: string | null): Promise<SaveFileResult> {
        if (!editWorkspaceId || !editBase.current || baseHash === null) {
            return { success: false, error: 'Reopen the file before saving again.' }
        }
        if (editController.current || isDesktopQuitting()) return { success: false, error: 'The workspace is busy.' }
        const controller = new AbortController()
        editController.current = controller
        const release = holdDraftAdmission()
        try {
            const saved = await replaceDesktopSharedText(editWorkspaceId, path, content, editBase.current, controller.signal)
            controller.signal.throwIfAborted()
            editBase.current = saved.editIdentity
            savedDeleteRevision.current = saved.deleteRevision
            if (saved.recoveryPath) toast.success('Changes saved. The previous version is in this folder.')
            return { success: true }
        } catch (error) {
            editBase.current = null
            return { success: false, error: messageOf(error, 'The save could not be confirmed. Reopen this file before trying again.') }
        } finally {
            editController.current = null
            release()
        }
    }

    return (
        <div ref={viewerRef} className="flex min-h-0 flex-1 flex-col">
            <BrainTopBar crumbs={[...folderCrumbs(dir, next => goTo(next, true)), { label: name, icon: FileIcon }]} />
            <div className="shrink-0 border-t border-border">
                <PanelEditorHeader title={name} mono onBack={navigationBlocked ? undefined : back} backLabel="Back to folder">
                    <FileSiblingControls siblings={visibleSiblings} />
                    {canSaveLocally && <Button type="button" size="xs" variant="outline" disabled={saving || deleting || editing || !saveVersion}
                        onClick={() => void save(path, saveVersion, (text ? ready?.editIdentity?.expectedSha256 : previewHash) ?? undefined)}>
                        <DownloadIcon className="size-3.5" />{saving ? 'Saving…' : 'Save As'}
                    </Button>}
                    {canEdit && <Button type="button" size="xs" variant="outline" disabled={saving || deleting} onClick={() => {
                        editBase.current = ready.editIdentity ?? null
                        setEditing(true)
                    }}>Edit</Button>}
                    {!!editWorkspaceId && deleteRevision && <PanelDeleteButton type="button" label="Delete file" confirm={false}
                        disabled={saving || editing || deleting} onClick={() => setConfirmDelete(deleteRevision)} />}
                    {savedName && <Badge size="xs" tone="green" glow={false}>Saved {savedName}</Badge>}
                    {ready?.truncated && <Badge size="xs" tone="orange" glow={false}>Truncated</Badge>}
                </PanelEditorHeader>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
                {text ? (
                    ready?.error ? <div className="space-y-2 p-3"><p role="alert" className="text-xs text-destructive">{ready.error}</p><Button variant="outline" onClick={() => setAttempt(value => value + 1)}>Retry</Button></div> : <FilePreview fileName={name} content={ready?.content ?? null} rawUrl="" loading={!ready} />
                ) : kind === 'image' ? <DesktopFileImagePreview name={name} path={path} srcUrl={sharedMediaUrl(path, 'image')} onBack={back} chrome="body" onPreviewIdentity={setPreviewHash} />
                    : kind === 'audio' ? <DesktopFileAudioPreview name={name} path={path} srcUrl={sharedMediaUrl(path, 'audio')} onBack={back} chrome="body" onPreviewIdentity={setPreviewHash} />
                    : kind === 'video' ? <DesktopFileVideoPreview name={name} path={path} srcUrl={sharedMediaUrl(path, 'video')} onBack={back} chrome="body" onPreviewIdentity={setPreviewHash} />
                    : kind === 'pdf' ? <DesktopFilePdfPreview name={name} path={path} srcUrl={sharedMediaUrl(path, 'pdf')} onBack={back} chrome="body" onPreviewIdentity={setPreviewHash} />
                    : <FilePreview fileName={name} content={null} rawUrl="" loading={false} />}
            </div>
            {editing && ready?.content != null && (
                <FileEditorDialog
                    fileName={name}
                    initialContent={ready.content}
                    host={desktopFileDraftHost()}
                    onSave={saveText}
                    onSaved={content => {
                        setPreview({ ...ready, content, editIdentity: editBase.current, deleteRevision: savedDeleteRevision.current })
                        onTextSaved?.()
                    }}
                    onClose={() => {
                        if (!editBase.current) {
                            setPreview(null)
                            setAttempt(value => value + 1)
                        }
                        setEditing(false)
                    }}
                />
            )}
            {confirmDelete && <ConfirmDialog open pending={deleting} onOpenChange={open => { if (!open && !deleting) setConfirmDelete(null) }}
                title={`Delete ${name}?`} description="The file is deleted from the workspace. This cannot be undone."
                onConfirm={event => {
                    event.preventDefault()
                    void remove(path, confirmDelete).then(removed => {
                        setConfirmDelete(null)
                        if (removed) {
                            onDeleted?.()
                            onOpen(dir, true)
                        }
                    })
                }} />}
        </div>
    )
}
