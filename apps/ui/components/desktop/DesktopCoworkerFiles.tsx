'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { FileTextEditor } from '@/components/files/FileTextEditor'
import { useFileUnloadGuard } from '@/components/files/useFileUnloadGuard'
import { useFileNavigation } from '@/components/files/useFileNavigation'
import { useSiblingFiles } from '@/components/files/useSiblingFiles'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { Input } from '@/components/ui/input'
import { PanelDeleteButton } from '@/components/ui/panel-editor'
import { ArrowLeftIcon, ChevronRightIcon, DownloadIcon, EyeIcon, EyeOffIcon, FileTextIcon, FolderIcon, HomeIcon, PencilIcon, RefreshCwIcon, Trash2Icon, XIcon } from '@/lib/icons'
import { DesktopFileAudioPreview, isDesktopAudioName } from './DesktopFileAudioPreview'
import { DesktopFileImagePreview, isDesktopRasterName } from './DesktopFileImagePreview'
import { DesktopFilePdfPreview, isDesktopPdfName } from './DesktopFilePdfPreview'
import { DesktopFilesGrid, desktopFilesTextHead } from '@/components/desktop/files-grid'
import { FilesImportMenu, FilesImportTray, FilesImportWriteError, useFilesImportQueue } from '@/components/desktop/files-import'
import { useFileThumbnails } from '@/components/files/useFileThumbnails'
import { FxFilesLoading } from './fx-repairs/PanelLoadingSkeletons'
import { FileSiblingControls, useFileSiblingKeys } from './DesktopFileSiblingNav'
import { DesktopFileVideoPreview, isDesktopVideoName } from './DesktopFileVideoPreview'
import { applyEol, splitEol } from '@/lib/files/editable'
import { Badge } from '@rerun/ui/primitives'
import type { DesktopAgentView } from './DesktopApp'
import { desktopFileDraftHost, holdDraftAdmission } from '@/lib/desktop/draft-writes'
import { useDesktopDialogControl, useDesktopPanelCloseGuard, type DesktopDialogControl, type RegisterDesktopPanelCloseGuard } from '@/lib/desktop/use-dialog-control'
import { useDesktopLocale } from './DesktopLocale'

type Entry = { name: string; type: 'file' | 'dir'; size: number; modifiedAt: string; identity?: string; exportVersion?: string }
type ListedSelection = { folder: string; entry: Entry }
type OpenFile = { path: string; name: string; identity?: string; exportVersion?: string }
type DeleteTarget = Pick<Entry, 'name' | 'type' | 'identity'> & { path: string }
type SaveCoworkerFile = (file: { agentId: string; path: string; version: string }) => Promise<boolean>
type Preview = { path: string; content: string; truncated: boolean; hash?: string; identity?: string; exportVersion?: string } | { path: string; error: string } | { path: string; loading: true } | { path: string; conflict: FileConflict }

/** FileList’s name field: the stem is selected, Enter saves, and Escape cancels. */
function RenameField({ name, onSubmit, onCancel }: { name: string; onSubmit: (next: string) => void; onCancel: () => void }) {
    const [value, setValue] = useState(name)
    const ref = useRef<HTMLInputElement>(null)
    const settled = useRef(false)
    useEffect(() => {
        const input = ref.current
        if (!input) return
        input.focus()
        const dot = name.lastIndexOf('.')
        input.setSelectionRange(0, dot > 0 ? dot : name.length)
    }, [name])
    const submit = () => {
        if (settled.current) return
        settled.current = true
        const next = value.trim()
        if (next && next !== name) onSubmit(next)
        else onCancel()
    }
    return <Input ref={ref} value={value} aria-label="New name" data-desktop-file-rename onChange={event => setValue(event.target.value)} onBlur={submit}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
            event.stopPropagation()
            if (event.key === 'Enter') { event.preventDefault(); submit() }
            if (event.key === 'Escape') { event.preventDefault(); settled.current = true; onCancel() }
        }}
        className="h-7 px-2 text-sm" />
}
function folderOf(path: string) {
    return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

function nameOf(path: string) {
    const slash = path.lastIndexOf('/')
    return slash === -1 ? path : path.slice(slash + 1)
}

async function errorOf(response: Response, fallback: string) {
    const body = await response.json().catch(() => null)
    return typeof body?.error === 'string' ? body.error : fallback
}

/** Port of AgentPanelFiles: breadcrumb navigation, sibling files, text/media/PDF previews, and a single .txt/.md import, scoped to one coworker. */
export function DesktopCoworkerFilesBody({ agent, initialFilePath, registerCloseGuard }: {
    agent: DesktopAgentView
    initialFilePath?: string | null
    registerCloseGuard: RegisterDesktopPanelCloseGuard
}) {
    const { t } = useDesktopLocale()
    const focusFile = useRef(initialFilePath)
    const base = `/api/desktop/agents/${encodeURIComponent(agent.id)}/files`
    const [error, setError] = useState('')
    const [preview, setPreview] = useState<Preview | null>(null)
    const [image, setImage] = useState<OpenFile | null>(null)
    const [audio, setAudio] = useState<OpenFile | null>(null)
    const [video, setVideo] = useState<OpenFile | null>(null)
    const [pdf, setPdf] = useState<OpenFile | null>(null)
    const [renaming, setRenaming] = useState<ListedSelection | null>(null)
    const [menuTarget, setMenuTarget] = useState<ListedSelection | null>(null)
    const renameAfterMenu = useRef<ListedSelection | null>(null)
    const [selected, setSelected] = useState<string | null>(null)
    const [renamePending, setRenamePending] = useState(false)
    const [deleting, setDeleting] = useState<DeleteTarget | null>(null)
    const [deletePending, setDeletePending] = useState(false)
    const renamingNow = useRef(false)
    const deletingNow = useRef(false)
    const viewerRef = useRef<HTMLDivElement>(null)
    const gridRef = useRef<HTMLDivElement>(null)
    const homeRef = useRef<HTMLButtonElement>(null)
    const gridFocus = useRef<{ folder: string; name: string | null; from: Element | null } | null>(null)
    const previewNow = useRef<Preview | null>(null)
    const blockSiblingNav = useRef(false)
    const pending = renamePending || deletePending
    useEffect(() => {
        if (!pending) return
        return registerCloseGuard(() => {})
    }, [pending, registerCloseGuard])

    const list = useCallback(async (path: string, showHidden: boolean) => {
        const response = await fetch(`${base}?path=${encodeURIComponent(path)}${showHidden ? '&hidden=1' : ''}`, { cache: 'no-store' })
        if (!response.ok) {
            setError(await errorOf(response, 'Could not open this folder.'))
            throw new Error('list failed')
        }
        setError('')
        return ((await response.json()) as { entries: Entry[] }).entries
    }, [base])

    const { currentPath, entries, loading, busy, showHidden, navigate, enter, setShowHidden, reload, refreshCurrent } = useFileNavigation<Entry>({
        list, initialPath: initialFilePath ? folderOf(initialFilePath) : '',
        initialShowHidden: initialFilePath?.split('/').some(part => part.startsWith('.')),
    })
    const [editingPath, setEditingPath] = useState<string | null>(null)

    useEffect(() => {
        // Folder navigation leaves the open file so its reader aborts and its player revokes.
        const away = (path: string | undefined) => !!path && folderOf(path) !== currentPath
        if (away(image?.path)) setImage(null)
        if (away(audio?.path)) setAudio(null)
        if (away(video?.path)) setVideo(null)
        if (away(pdf?.path)) setPdf(null)
        if (away(preview?.path)) {
            setPreview(null)
            setEditingPath(null)
        }
    }, [currentPath, image, audio, video, pdf, preview])

    useEffect(() => {
        // A replaced listing identity must not keep the previous bytes. A missing name stays put.
        const adopt = (current: OpenFile | null, set: (next: OpenFile) => void) => {
            if (!current || folderOf(current.path) !== currentPath) return
            const entry = entries.find(item => item.type === 'file' && item.name === current.name)
            if (!entry || entry.identity === current.identity) return
            set({ ...current, identity: entry.identity, exportVersion: entry.exportVersion })
        }
        adopt(image, setImage)
        adopt(audio, setAudio)
        adopt(video, setVideo)
        adopt(pdf, setPdf)
    }, [currentPath, entries, image, audio, video, pdf])

    previewNow.current = preview
    const openPath = preview?.path
    const textIdentity = preview && folderOf(preview.path) === currentPath
        ? entries.find(entry => entry.type !== 'dir' && entry.name === nameOf(preview.path))?.identity
        : undefined
    useEffect(() => {
        // A pending import can reload the listing while the editor owns a draft. Keep that
        // editor mounted; its save/conflict flow checks the disk version before writing.
        if (!openPath || editingPath === openPath) return
        const shown = previewNow.current
        if (shown?.path === openPath && 'conflict' in shown) return
        // Closing a saved/unchanged editor already has the accepted bytes. Only a
        // changed listing identity needs another read before showing the preview.
        if (shown?.path === openPath && 'content' in shown && shown.identity === textIdentity) return
        const controller = new AbortController()
        setPreview(existing => {
            if (!existing || existing.path !== openPath || 'conflict' in existing || 'loading' in existing) return existing
            if ('content' in existing && existing.identity === textIdentity) return existing
            return { path: openPath, loading: true }
        })
        void (async () => {
            try {
                const response = await fetch(`${base}/read?path=${encodeURIComponent(openPath)}`, { cache: 'no-store', signal: controller.signal })
                const body = await response.json().catch(() => null)
                const next: Preview = response.ok ? body : body?.conflict && body.current
                    ? { path: openPath, conflict: { ...body.current, ...(body.recovery && { recovery: body.recovery }) } }
                    : { path: openPath, error: typeof body?.error === 'string' ? body.error : 'Could not preview this file.' }
                if (!controller.signal.aborted) setPreview(next)
            } catch {
                if (!controller.signal.aborted) setPreview({ path: openPath, error: 'Could not preview this file.' })
            }
        })()
        return () => controller.abort()
    }, [base, openPath, textIdentity, editingPath])

    const [saveNotice, setSaveNotice] = useState<{ path: string; message: string; ok: boolean } | null>(null)
    const [savingFile, setSavingFile] = useState(false)
    const savingNow = useRef(false)
    const nativeSave = typeof window === 'undefined' ? undefined : (window as Window & { desktopApp?: { saveCoworkerFile?: SaveCoworkerFile } }).desktopApp?.saveCoworkerFile
    const saveAs = async (path: string, version: string) => {
        if (!nativeSave || savingNow.current) return
        savingNow.current = true
        setSavingFile(true)
        setSaveNotice(null)
        try {
            if (await nativeSave({ agentId: agent.id, path, version })) {
                setSaveNotice({ path, message: `Saved ${nameOf(path)}`, ok: true })
            }
        } catch (error) {
            const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'Could not save this file.'
            setSaveNotice({ path, message, ok: false })
        } finally {
            savingNow.current = false
            setSavingFile(false)
        }
    }
    const showSaveNotice = (visible: boolean) => visible && saveNotice && <p role={saveNotice.ok ? 'status' : 'alert'} className={`text-xs ${saveNotice.ok ? 'text-muted-foreground' : 'text-destructive'}`}>{saveNotice.message}</p>

    const [notice, setNotice] = useState<{ ok: boolean; text: string; folder: string } | null>(null)

    const openListed = useCallback((name: string) => {
        if (renamingNow.current || deletingNow.current) return
        const entry = entries.find(item => item.type !== 'dir' && item.name === name)
        if (!entry) return
        const path = currentPath ? `${currentPath}/${name}` : name
        gridFocus.current = null
        setSelected(path)
        const file: OpenFile = { path, name: entry.name, identity: entry.identity, exportVersion: entry.exportVersion }
        setEditingPath(null)
        if (isDesktopRasterName(entry.name)) {
            setAudio(null); setVideo(null); setPdf(null); setPreview(null); setImage(file)
        } else if (isDesktopAudioName(entry.name)) {
            setImage(null); setVideo(null); setPdf(null); setPreview(null); setAudio(file)
        } else if (isDesktopVideoName(entry.name)) {
            setImage(null); setAudio(null); setPdf(null); setPreview(null); setVideo(file)
        } else if (isDesktopPdfName(entry.name)) {
            setImage(null); setAudio(null); setVideo(null); setPreview(null); setPdf(file)
        } else {
            setImage(null); setAudio(null); setVideo(null); setPdf(null); setPreview({ path, loading: true })
        }
    }, [currentPath, entries])
    useEffect(() => {
        const path = focusFile.current
        if (!path || loading || busy || folderOf(path) !== currentPath) return
        focusFile.current = null
        if (error) return
        const name = nameOf(path)
        if (entries.some(entry => entry.name === name && entry.type === 'file')) openListed(name)
        else setNotice({ ok: false, folder: currentPath, text: `${t('linkedFileNotFound')}. ${path}` })
    }, [busy, currentPath, entries, error, loading, openListed, t])
    const openPathname = image?.path ?? audio?.path ?? video?.path ?? pdf?.path ?? preview?.path
    const openEntry = openPathname && folderOf(openPathname) === currentPath
        ? entries.find(entry => entry.type !== 'dir' && entry.name === nameOf(openPathname))
        : undefined
    const previewSaveAction = (path: string, version?: string) => nativeSave && openEntry?.exportVersion && version
        ? <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={savingFile} onClick={() => void saveAs(path, version)}>Save As</Button>
        : null
    const previewDeleteAction = (path: string, identity?: string) => {
        if (!identity || openEntry?.identity !== identity) return null
        return <PanelDeleteButton type="button" label="Delete file" confirm={false} disabled={pending || savingFile}
            onClick={() => setDeleting({ path, name: openEntry.name, type: 'file', identity })} />
    }
    const mediaActions = (file: OpenFile) => <>
        {previewSaveAction(file.path, file.exportVersion)}
        {previewDeleteAction(file.path, file.identity)}
        {showSaveNotice(saveNotice?.path === file.path)}
    </>
    const renameTarget = renaming?.folder === currentPath ? renaming : null
    const navigationLocked = renamePending || deletePending || renameTarget !== null || deleting !== null || editingPath !== null || (!!preview && 'conflict' in preview)
    blockSiblingNav.current = navigationLocked
    const openSibling = useCallback((name: string) => {
        if (blockSiblingNav.current) return
        openListed(name)
    }, [openListed])
    const siblings = useSiblingFiles({ entries, openName: openEntry?.name, onOpen: openSibling })
    const shownSiblings = navigationLocked ? null : siblings
    useFileSiblingKeys(shownSiblings, viewerRef)
    const childPath = (name: string) => currentPath ? `${currentPath}/${name}` : name
    const currentEntry = (target: ListedSelection | null) => target?.folder === currentPath
        ? entries.find(entry => entry.name === target.entry.name && entry.type === target.entry.type && entry.identity === target.entry.identity)
        : undefined
    const focusGrid = (folder: string, name: string | null) => {
        gridFocus.current = { folder, name, from: document.activeElement }
    }
    const openDirectory = (name: string) => {
        const path = childPath(name)
        focusGrid(path, null)
        setSelected(path)
        enter(name)
    }
    const openAncestor = (folder: string) => {
        if (folder !== currentPath) {
            const child = currentPath.slice(folder ? folder.length + 1 : 0).split('/')[0]
            focusGrid(folder, child)
        } else gridFocus.current = null
        navigate(folder)
    }
    const selectedHere = selected && folderOf(selected) === currentPath ? nameOf(selected) : null

    useLayoutEffect(() => {
        const viewer = viewerRef.current
        const active = document.activeElement
        if (openPathname) {
            if (active === document.body || gridRef.current?.contains(active)) {
                viewer?.querySelector<HTMLButtonElement>('[data-slot="panel-editor-back"]')?.focus()
            }
            return
        }
        const target = gridFocus.current
        if (!target || target.folder !== currentPath || loading || busy || pending) return
        gridFocus.current = null
        if (active !== document.body && active !== target.from) return
        const tiles = gridRef.current?.querySelectorAll<HTMLButtonElement>('button[data-files-name]:not([disabled])')
        const entry = target.name && tiles && [...tiles].find(tile => tile.dataset.filesName === target.name)
        const parent = !target.name && gridRef.current?.querySelector<HTMLButtonElement>('button[data-files-parent]:not([disabled])')
        const next = entry || parent || homeRef.current
        next?.focus()
    }, [openPathname, currentPath, loading, busy, pending])

    const backToFolder = (path: string) => focusGrid(folderOf(path), nameOf(path))
    const retarget = (value: string, from: string, to: string, directory: boolean) => value === from || (directory && value.startsWith(`${from}/`)) ? `${to}${value.slice(from.length)}` : value
    const renameEntry = async (target: ListedSelection, next: string) => {
        if (renamingNow.current) return
        const { name, type, identity } = target.entry
        if (!currentEntry(target)) {
            setNotice({ ok: false, folder: target.folder, text: 'This entry changed. Refresh Files and choose it again.' })
            return
        }
        renamingNow.current = true
        setRenamePending(true)
        const from = childPath(name)
        const directory = type === 'dir'
        setNotice(null)
        try {
            const response = await fetch(`${base}/rename`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path: from, name: next, identity }),
            })
            const body = await response.json().catch(() => null) as { path?: string; name?: string; error?: string } | null
            if (!response.ok || !body?.path) {
                setNotice({ ok: false, folder: currentPath, text: body?.error ?? `Could not rename “${name}”.` })
                return
            }
            setSelected(body.path)
            setPreview(prev => prev ? { ...prev, path: retarget(prev.path, from, body.path!, directory) } : prev)
            setEditingPath(prev => prev ? retarget(prev, from, body.path!, directory) : prev)
            await reload()
        } catch {
            setNotice({ ok: false, folder: currentPath, text: `Could not rename “${name}”.` })
        } finally {
            renamingNow.current = false
            setRenamePending(false)
        }
    }
    // Clear only the deleted path. Do not select a sibling, and do not retarget a chat attachment.
    const commitDelete = async (target: DeleteTarget) => {
        if (deletingNow.current) return
        deletingNow.current = true
        setDeletePending(true)
        const { path } = target
        setNotice(null)
        let removed = false
        try {
            const response = await fetch(`${base}/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, ...(target.identity && { identity: target.identity }) }) })
            const body = await response.json().catch(() => null) as { path?: string; error?: string } | null
            if (!response.ok || body?.path !== path) {
                setNotice({ ok: false, folder: folderOf(path), text: body?.error ?? `Could not delete “${target.name}”.` })
                return
            }
            removed = true
            const covered = (value: string | null) => !!value && (value === path || value.startsWith(`${path}/`))
            setSelected(previous => covered(previous) ? null : previous)
            setPreview(previous => previous && covered(previous.path) ? null : previous)
            setImage(previous => previous && covered(previous.path) ? null : previous)
            setAudio(previous => previous && covered(previous.path) ? null : previous)
            setVideo(previous => previous && covered(previous.path) ? null : previous)
            setPdf(previous => previous && covered(previous.path) ? null : previous)
            setEditingPath(previous => covered(previous) ? null : previous)
            setRenaming(previous => previous?.folder === folderOf(path) && previous.entry.name === target.name ? null : previous)
        } catch {
            setNotice({ ok: false, folder: folderOf(path), text: `Could not delete “${target.name}”.` })
        } finally {
            deletingNow.current = false
            setDeletePending(false)
            setDeleting(null)
        }
        if (removed) reload()
    }
    const deleteConfirmation = deleting && <ConfirmDialog open pending={deletePending} onOpenChange={open => { if (!open && !deletingNow.current) setDeleting(null) }}
        title={`Delete ${deleting.name}?`}
        description={deleting.type === 'dir' ? 'The folder and everything inside it are deleted from the box. This cannot be undone.' : 'The file is deleted from the box. This cannot be undone.'}
        onConfirm={event => { event.preventDefault(); void commitDelete(deleting) }} />
    const folderNotice = notice?.folder === currentPath && <p role={notice.ok ? 'status' : 'alert'} data-testid="import-notice" className={`pt-2 text-xs ${notice.ok ? 'text-muted-foreground' : 'text-destructive'}`}>{notice.text}</p>
    const withPreviewFeedback = (view: ReactNode) => <>{view}{folderNotice}{deleteConfirmation}</>

    const breadcrumbs = currentPath.split('/').filter(Boolean)
    const menuEntry = busy ? undefined : currentEntry(menuTarget)
    const menuVersion = menuEntry?.type === 'file' && menuEntry.exportVersion === menuTarget?.entry.exportVersion
        ? menuEntry.exportVersion : undefined

    // Keyed on the path (as FileDetail does), so opening another file leaves the editor by itself.
    const editing = !!preview && editingPath === preview.path

    const textHeadKey = `${agent.id}\0${currentPath}\0${entries.map(entry => `${entry.type}:${entry.name}:${entry.size}:${entry.identity ?? ''}:${entry.modifiedAt}`).join('\0')}`
    const readTextHead = useCallback(async (path: string) => {
        try {
            const response = await fetch(`${base}/read?path=${encodeURIComponent(path)}`, { cache: 'no-store' })
            const body: unknown = await response.json().catch(() => null)
            return desktopFilesTextHead(body, response.ok)
        } catch {
            return ''
        }
    }, [base])
    const { heads, request } = useFileThumbnails({ read: readTextHead, resetKey: textHeadKey })
    const writeImport = useCallback(async (item: { path: string; bytes: Uint8Array; signal: AbortSignal; onProgress: (loaded: number, total: number) => void }) => {
        item.onProgress(0, item.bytes.byteLength)
        const { buffer, byteOffset, byteLength } = item.bytes
        const body = buffer instanceof ArrayBuffer ? new Uint8Array(buffer, byteOffset, byteLength) : Uint8Array.from(item.bytes)
        const response = await fetch(`${base}/import?path=${encodeURIComponent(item.path)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body,
            signal: item.signal,
        })
        const payload: unknown = await response.json().catch(() => null)
        if (!response.ok) {
            const record = payload && typeof payload === 'object' ? payload as { error?: unknown; code?: unknown } : {}
            const code = typeof record.code === 'string' ? record.code : 'http'
            throw new FilesImportWriteError(typeof record.error === 'string' ? record.error : 'Import failed.', code as never, response.status)
        }
        if (!payload || typeof payload !== 'object' || !('saved' in payload) || payload.saved !== true
            || !('path' in payload) || typeof payload.path !== 'string') {
            throw new FilesImportWriteError('The file import result could not be confirmed. Check Files before retrying.', 'unconfirmed', response.status)
        }
        item.onProgress(item.bytes.byteLength, item.bytes.byteLength)
        return { saved: true as const, path: payload.path }
    }, [base])
    const imports = useFilesImportQueue({
        rootDir: currentPath,
        disabled: pending || loading || busy || !!error,
        write: writeImport,
        onRejected: message => setNotice({ ok: false, folder: currentPath, text: message }),
        onFileSaved: refreshCurrent,
    })

    if (preview && 'conflict' in preview) {
        return <FileEditor base={base} path={preview.path} content={preview.conflict.content} hash={preview.conflict.hash} identity={preview.conflict.identity} initialConflict={preview.conflict} registerCloseGuard={registerCloseGuard}
            onClose={() => setPreview(null)}
            onSaved={(content, hash, identity, exportVersion) => { setPreview({ path: preview.path, content, truncated: false, hash, identity, exportVersion }); setEditingPath(null) }} />
    }

    if (preview && editing && 'hash' in preview && preview.hash) {
        return <FileEditor base={base} path={preview.path} content={preview.content} hash={preview.hash} identity={preview.identity} registerCloseGuard={registerCloseGuard}
            onClose={() => setEditingPath(null)}
            onSaved={(content, hash, identity, exportVersion) => { setPreview({ path: preview.path, content, truncated: false, hash, identity, exportVersion }); setEditingPath(null) }} />
    }

    if (image) {
        const params = new URLSearchParams({ path: image.path })
        if (image.identity) params.set('identity', image.identity)
        return withPreviewFeedback(<DesktopFileImagePreview name={image.name} path={image.path} identity={image.identity} srcUrl={`${base}/image?${params.toString()}`} onBack={() => { backToFolder(image.path); setImage(null) }} siblings={shownSiblings} viewerRef={viewerRef} headerActions={mediaActions(image)} />)
    }

    if (audio) {
        const params = new URLSearchParams({ path: audio.path })
        if (audio.identity) params.set('identity', audio.identity)
        return withPreviewFeedback(<DesktopFileAudioPreview name={audio.name} path={audio.path} identity={audio.identity} srcUrl={`${base}/audio?${params.toString()}`} onBack={() => { backToFolder(audio.path); setAudio(null) }} siblings={shownSiblings} viewerRef={viewerRef} headerActions={mediaActions(audio)} />)
    }

    if (video) {
        const params = new URLSearchParams({ path: video.path })
        if (video.identity) params.set('identity', video.identity)
        return withPreviewFeedback(<DesktopFileVideoPreview name={video.name} path={video.path} identity={video.identity} srcUrl={`${base}/video?${params.toString()}`} onBack={() => { backToFolder(video.path); setVideo(null) }} siblings={shownSiblings} viewerRef={viewerRef} headerActions={mediaActions(video)} />)
    }

    if (pdf) {
        const params = new URLSearchParams({ path: pdf.path })
        if (pdf.identity) params.set('identity', pdf.identity)
        return withPreviewFeedback(<DesktopFilePdfPreview name={pdf.name} path={pdf.path} identity={pdf.identity} srcUrl={`${base}/pdf?${params.toString()}`} onBack={() => { backToFolder(pdf.path); setPdf(null) }} siblings={shownSiblings} viewerRef={viewerRef} headerActions={mediaActions(pdf)} />)
    }

    if (preview) {
        const name = preview.path.split('/').pop()
        const editable = 'hash' in preview && !!preview.hash
        return withPreviewFeedback(<div ref={viewerRef} className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-2 text-sm">
                <Button type="button" variant="ghost" size="sm" aria-label="Back to folder" data-slot="panel-editor-back" onClick={() => { backToFolder(preview.path); setPreview(null) }}><ArrowLeftIcon className="size-4" /></Button>
                <span className="min-w-0 flex-1 truncate font-medium" title={preview.path}>{name}</span>
                {shownSiblings && <div className="flex shrink-0 items-center gap-1"><FileSiblingControls siblings={shownSiblings} /></div>}
                {previewSaveAction(preview.path, 'content' in preview ? preview.exportVersion : 'error' in preview ? openEntry?.exportVersion : undefined)}
                {'content' in preview && <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={!editable}
                    title={editable ? undefined : 'Only complete UTF-8 text files up to 256 KiB can be edited here.'} onClick={() => setEditingPath(preview.path)}>Edit</Button>}
                {previewDeleteAction(preview.path, 'content' in preview ? preview.identity : 'error' in preview ? openEntry?.identity : undefined)}
            </div>
            {showSaveNotice(saveNotice?.path === preview.path)}
            {'loading' in preview ? <p role="status" className="text-sm text-muted-foreground">Loading preview…</p>
                : 'error' in preview ? <p role="alert" className="text-sm text-destructive">{preview.error}</p>
                : <>
                    <pre data-testid="file-preview" className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-words">{preview.content}</pre>
                    {preview.truncated && <p className="text-xs text-muted-foreground">Preview shows the first 256 KB.</p>}
                </>}
        </div>)
    }

    return <div className="flex min-h-0 flex-1 flex-col">
        <nav aria-label="Folder" className="flex items-center gap-1 overflow-x-auto border-b pb-2 text-xs">
            <button type="button" ref={homeRef} aria-label="Workspace home" disabled={pending} onClick={() => openAncestor('')} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"><HomeIcon className="size-3.5" /></button>
            {breadcrumbs.map((crumb, i) => <span key={i} className="flex shrink-0 items-center gap-1">
                <ChevronRightIcon className="size-3 text-muted-foreground" />
                <button type="button" disabled={pending} onClick={() => openAncestor(breadcrumbs.slice(0, i + 1).join('/'))} className="text-muted-foreground hover:text-foreground">{crumb}</button>
            </span>)}
            <div className="flex-1" />
            <button type="button" disabled={pending} onClick={() => setShowHidden(v => !v)} title={showHidden ? 'Hide hidden files' : 'Show hidden files'} aria-label={showHidden ? 'Hide hidden files' : 'Show hidden files'}
                className={`shrink-0 rounded p-1 hover:bg-accent/50 ${showHidden ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                {showHidden ? <EyeIcon className="size-3.5" /> : <EyeOffIcon className="size-3.5" />}
            </button>
            <FilesImportMenu onPick={imports.enqueueEntries} disabled={pending || loading || busy || !!error} />
            <button type="button" aria-label="Refresh files" disabled={pending} onClick={reload} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"><RefreshCwIcon className="size-3.5" /></button>
        </nav>
        {showSaveNotice(!!saveNotice && folderOf(saveNotice.path) === currentPath)}
        {renamePending && <p role="status" className="pt-2 text-xs text-muted-foreground">Renaming…</p>}
        {deletePending && <p role="status" className="pt-2 text-xs text-muted-foreground">Deleting…</p>}
        {folderNotice}
        <div className={`relative min-h-0 flex-1 overflow-y-auto py-2 ${busy || pending ? 'pointer-events-none opacity-60' : ''}`}
            onDragOver={imports.onDragOver} onDragLeave={imports.onDragLeave} onDrop={imports.onDrop}>
            {imports.dragOver && <p role="status" className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-md border border-dashed bg-background/80 text-sm">Drop files or folders to import</p>}
            {loading && !error ? <FxFilesLoading />
                : error ? <p role="alert" className="text-sm text-destructive">{error}</p>
                : <ContextMenu onOpenChange={open => { if (!open) setMenuTarget(null) }}>
                    <ContextMenuTrigger asChild>
                        <div ref={gridRef}>
                            <DesktopFilesGrid
                                entries={entries}
                                currentPath={currentPath}
                                filesBase={base}
                                selectedName={selectedHere}
                                renamingName={renameTarget?.entry.name}
                                pending={busy || pending}
                                textHeads={heads}
                                onRequestText={request}
                                onOpenFile={name => openListed(name)}
                                onOpenDir={openDirectory}
                                onGoUp={currentPath ? () => openAncestor(folderOf(currentPath)) : undefined}
                                onContextMenu={name => {
                                    const entry = entries.find(item => item.name === name)
                                    setMenuTarget(entry ? { folder: currentPath, entry } : null)
                                }}
                                onClearMenu={() => setMenuTarget(null)}
                                renderRename={name => renameTarget && <RenameField name={name} onSubmit={next => { setRenaming(null); void renameEntry(renameTarget, next) }} onCancel={() => setRenaming(null)} />}
                            />
                        </div>
                    </ContextMenuTrigger>
                    {menuEntry && <ContextMenuContent onCloseAutoFocus={event => {
                        const target = renameAfterMenu.current
                        renameAfterMenu.current = null
                        if (!target || !currentEntry(target)) return
                        // Mount the inline editor after the menu releases its focus trap. Mounting
                        // in onSelect lets that trap blur and immediately cancel the new field.
                        event.preventDefault()
                        setRenaming(target)
                    }}>
                        <ContextMenuLabel className="max-w-56 truncate pl-7">{menuEntry.name}</ContextMenuLabel>
                        <ContextMenuSeparator />
                        <ContextMenuItem className="pl-7" disabled={pending}
                            onSelect={() => menuEntry.type === 'dir' ? openDirectory(menuEntry.name) : openListed(menuEntry.name)}>
                            {t(menuEntry.type === 'dir' ? 'files.grid.openFolder' : 'files.grid.open')}
                        </ContextMenuItem>
                        {nativeSave && menuVersion && <ContextMenuItem disabled={pending || savingFile}
                            onSelect={() => void saveAs(childPath(menuEntry.name), menuVersion)}>
                            <DownloadIcon className="size-4" />
                            Save As
                        </ContextMenuItem>}
                        <ContextMenuItem disabled={pending} onSelect={() => { renameAfterMenu.current = { folder: currentPath, entry: menuEntry } }}>
                            <PencilIcon className="size-4" />
                            {t('files.grid.rename')}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem variant="destructive" disabled={pending} onSelect={() => setDeleting({ path: childPath(menuEntry.name), name: menuEntry.name, type: menuEntry.type, identity: menuEntry.identity })}>
                            <Trash2Icon className="size-4" />
                            {t('files.grid.delete')}
                        </ContextMenuItem>
                    </ContextMenuContent>}
                </ContextMenu>}
            <FilesImportTray items={imports.items} onCancel={imports.cancel} onRetry={imports.retry} onDismiss={imports.dismiss} />
        </div>
        {deleteConfirmation}
    </div>
}

type FileConflict = { content: string; hash: string; identity?: string; stale?: boolean; recovery?: { draft: string; external: string } }
type SaveResponse = { path: string; hash: string; identity?: string; exportVersion?: string } | { error: string; conflict?: true; stale?: boolean; current?: { content: string; hash: string; identity?: string } | null; recovery?: { draft: string; external: string } }

/**
 * Original FileEditorDialog layout and editor, with desktop conflict details. Every close path
 * guards the draft, including the Files dialog behind this modal. Overwrite retries against the
 * version shown, so another change still produces a conflict.
 */
function FileEditor({ base, path, content, hash, identity, initialConflict = null, registerCloseGuard, onClose, onSaved }: { base: string; path: string; content: string; hash: string; identity?: string; initialConflict?: FileConflict | null; registerCloseGuard: RegisterDesktopPanelCloseGuard; onClose: () => void; onSaved: (content: string, hash: string, identity?: string, exportVersion?: string) => void }) {
    const [opened, setOpened] = useState(() => ({ ...splitEol(content), hash, identity }))
    const [draft, setDraft] = useState(opened.text)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    const [conflict, setConflict] = useState<FileConflict | null>(initialConflict)
    const [setAside, setSetAside] = useState<string | null>(null)
    const [pendingClose, setPendingClose] = useState<(() => void) | null>(null)
    const dirty = draft !== opened.text
    const name = path.split('/').pop()
    const requestClose = useCallback((close = onClose) => {
        if (saving) return
        if (dirty) setPendingClose(() => close)
        else close()
    }, [dirty, saving, onClose])

    useEffect(() => {
        return registerCloseGuard(requestClose)
    }, [registerCloseGuard, requestClose])

    const draftHost = desktopFileDraftHost()
    useFileUnloadGuard(dirty || setAside !== null, draftHost)

    const save = async (baseHash: string, fileIdentity = opened.identity) => {
        if (draftHost?.isClosing()) return
        const release = holdDraftAdmission()
        setSaving(true)
        setError('')
        const next = applyEol(draft, opened.eol)
        try {
            const response = await fetch(`${base}/content`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content: next, baseHash, ...(fileIdentity && { identity: fileIdentity }) }) })
            const body = await response.json().catch(() => ({ error: 'Could not save this file.' })) as SaveResponse
            if (response.ok && 'hash' in body) { onSaved(next, body.hash, body.identity, body.exportVersion); return }
            if ('conflict' in body && body.conflict && body.current) setConflict({ ...body.current, ...(body.recovery && { recovery: body.recovery }), ...(body.stale ? { stale: true } : {}) })
            else setError('error' in body && body.error ? `${body.error} Your edits are still here; try again.` : 'Could not save this file. Your edits are still here; try again.')
        } catch {
            setError('Could not save this file. Your edits are still here; try again.')
        } finally {
            setSaving(false)
            release()
        }
    }

    const reload = () => {
        if (!conflict) return
        const fresh = { ...splitEol(conflict.content), hash: conflict.hash, identity: conflict.identity ?? opened.identity }
        if (dirty) setSetAside(draft)
        setOpened(fresh)
        setDraft(fresh.text)
        setConflict(null)
    }

    const saveDraft = () => { if (dirty && !saving && !conflict) void save(opened.hash) }

    return <Dialog open asSheet={false} dismissible={!dirty && !saving} onOpenChange={open => { if (!open) requestClose() }}>
        <DialogContent aria-describedby={undefined} showCloseButton={false} data-testid="file-editor"
            className="flex h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
            onOpenAutoFocus={event => event.preventDefault()}>
            <div className="flex shrink-0 items-center gap-2 border-b border-border py-2 pr-2 pl-4">
                <DialogTitle className="min-w-0 flex-1 truncate text-left font-mono text-xs font-normal text-muted-foreground" title={path}>{name}</DialogTitle>
                {dirty && <Badge size="xs" tone="orange" glow={false}>Unsaved</Badge>}
                <Button size="icon-sm" variant="ghost" onClick={() => requestClose()} disabled={saving} title="Close editor" aria-label="Close editor"><XIcon className="size-4" /></Button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
                <FileTextEditor value={draft} onChange={text => { if (!draftHost?.isClosing()) setDraft(text) }} fileName={name ?? path} readOnly={saving} autoFocus onSave={saveDraft} />
            </div>
            {setAside !== null && <div className="shrink-0 space-y-1 border-t border-border p-3 text-xs" data-testid="set-aside">
                <p className="text-muted-foreground">Reloaded the newer version. Your previous edits, not saved:</p>
                <textarea readOnly aria-label="Your previous edits" value={setAside} className="h-24 w-full resize-none rounded border bg-muted/30 p-2 font-mono text-xs" />
                <div className="flex justify-end"><Button type="button" variant="ghost" size="sm" onClick={() => setSetAside(null)}>Dismiss</Button></div>
            </div>}
            {error && <p role="alert" data-testid="edit-error" className="shrink-0 border-t border-border px-4 pt-2 text-xs text-destructive">{error}</p>}
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border p-3">
                <Button type="button" variant="outline" size="sm" onClick={() => requestClose()} disabled={saving}>Cancel</Button>
                <Button type="button" size="sm" onClick={saveDraft} disabled={!dirty || saving || !!conflict}>{saving ? 'Saving…' : 'Save changes'}</Button>
            </div>
        </DialogContent>
        {conflict && <ConfirmDialog open pending={saving} onOpenChange={open => { if (!open && !saving) { if (conflict.stale) setConflict(null); else reload() } }}
            title={conflict.stale ? `${name} is no longer at this path` : `${name} changed on this Mac`}
            description={<span className="block space-y-2" data-testid="edit-conflict">
                <span className="block">{conflict.stale
                    ? 'This file was moved or replaced. The draft was not written, and the file now at the old path was left as it is.'
                    : initialConflict
                    ? 'This file was recovered after an interrupted save. Your draft is in the named recovery copy; the external version is below.'
                    : 'Someone, or a coworker, wrote to this file after you opened it. Your edits are still in the editor. Overwrite replaces the version below with yours.'}</span>
                <span data-testid="conflict-disk" className="block max-h-32 overflow-auto rounded border bg-muted/30 p-2 font-mono whitespace-pre-wrap break-words">{conflict.content}</span>
                {conflict.recovery && <span data-testid="edit-recovery" className="block break-words">
                    Recovery copies in Files: <code>{conflict.recovery.draft}</code> holds your draft; <code>{conflict.recovery.external}</code> holds the external version. The external version is also back at its original path.
                </span>}
            </span>}
            confirmLabel={conflict.stale ? 'Keep my draft' : 'Overwrite'} cancelLabel={conflict.stale ? 'Close' : 'Keep theirs'}
            confirmVariant={conflict.stale ? 'default' : 'destructive'}
            onConfirm={event => { event.preventDefault(); if (conflict.stale) setConflict(null); else void save(conflict.hash, conflict.identity) }} />}
        {pendingClose && <ConfirmDialog open onOpenChange={open => { if (!open) setPendingClose(null) }}
            title="Discard your changes?" description={`Your edits to ${name} are not saved yet. Closing the editor throws them away.`}
            confirmLabel="Discard changes" cancelLabel="Keep editing"
            onConfirm={() => { setPendingClose(null); pendingClose() }} />}
    </Dialog>
}

export function DesktopCoworkerFiles({ agent, dialogControl, initialFilePath, onCloseAutoFocus }: {
    agent: DesktopAgentView
    dialogControl?: DesktopDialogControl
    initialFilePath?: string | null
    onCloseAutoFocus?: (event: Event) => void
}) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    const { register, requestClose } = useDesktopPanelCloseGuard()
    const changeOpen = (next: boolean) => {
        if (next) setOpen(true)
        else requestClose(() => setOpen(false))
    }
    return <Dialog open={open} onOpenChange={changeOpen} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Files</Button></DialogTrigger>
        {open && <DialogContent className="flex h-[75dvh] flex-col sm:max-w-2xl" onCloseAutoFocus={onCloseAutoFocus} onEscapeKeyDown={event => {
            // Radix handles Escape at document capture before the field can stop propagation.
            // Let the inline field cancel its name edit without dismissing the Files dialog.
            if (event.target instanceof HTMLElement && event.target.hasAttribute('data-desktop-file-rename')) event.preventDefault()
        }}>
            <DialogHeaderBar icon={FolderIcon} title="Files" description={<>{agent.name}’s workspace. Browse, preview, edit, rename, delete, or import files and folders. Preview supported images and PDFs, or play audio and video already in the folder.</>} />
            <DesktopCoworkerFilesBody key={agent.id} agent={agent} initialFilePath={initialFilePath} registerCloseGuard={register} />
            <DialogFooter><DialogClose asChild><Button type="button">Done</Button></DialogClose></DialogFooter>
        </DialogContent>}
    </Dialog>
}
