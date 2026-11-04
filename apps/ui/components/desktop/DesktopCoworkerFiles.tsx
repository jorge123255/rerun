'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { FileTextEditor } from '@/components/files/FileTextEditor'
import { useFileNavigation } from '@/components/files/useFileNavigation'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ArrowLeftIcon, ChevronRightIcon, EyeIcon, EyeOffIcon, FileTextIcon, FolderIcon, HomeIcon, PencilIcon, RefreshCwIcon, XIcon } from '@/lib/icons'
import { applyEol, splitEol } from '@/lib/files/editable'
import { Badge } from '@rerun/ui/primitives'
import type { DesktopAgentView } from './DesktopApp'

type Entry = { name: string; type: 'file' | 'dir'; size: number; modifiedAt: string }
type Preview = { path: string; content: string; truncated: boolean; hash?: string; identity?: string } | { path: string; error: string } | { path: string; loading: true } | { path: string; conflict: FileConflict }

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
type CloseGuard = (close: () => void) => void

async function errorOf(response: Response, fallback: string) {
    const body = await response.json().catch(() => null)
    return typeof body?.error === 'string' ? body.error : fallback
}

/** Port of AgentPanelFiles: breadcrumb folder navigation, a text preview, and a single .txt/.md import, scoped to one coworker. */
function FilesPanel({ agent, registerCloseGuard }: { agent: DesktopAgentView; registerCloseGuard: (guard: CloseGuard | null) => void }) {
    const base = `/api/desktop/agents/${encodeURIComponent(agent.id)}/files`
    const [error, setError] = useState('')
    const [preview, setPreview] = useState<Preview | null>(null)
    const [renaming, setRenaming] = useState<string | null>(null)
    const [menuName, setMenuName] = useState<string | null>(null)
    const renameAfterMenu = useRef<string | null>(null)
    const [selected, setSelected] = useState<string | null>(null)
    const [renamePending, setRenamePending] = useState(false)
    const renamingNow = useRef(false)
    useEffect(() => {
        if (!renamePending) return
        registerCloseGuard(() => {})
        return () => registerCloseGuard(null)
    }, [renamePending, registerCloseGuard])

    const list = useCallback(async (path: string, showHidden: boolean) => {
        const response = await fetch(`${base}?path=${encodeURIComponent(path)}${showHidden ? '&hidden=1' : ''}`, { cache: 'no-store' })
        if (!response.ok) {
            setError(await errorOf(response, 'Could not open this folder.'))
            throw new Error('list failed')
        }
        setError('')
        return ((await response.json()) as { entries: Entry[] }).entries
    }, [base])

    const { currentPath, entries, loading, busy, showHidden, navigate, enter, goUp, goHome, setShowHidden, reload } = useFileNavigation<Entry>({ list })

    const openPath = preview?.path
    useEffect(() => {
        if (!openPath) return
        const controller = new AbortController()
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
    }, [base, openPath])

    const fileInput = useRef<HTMLInputElement>(null)
    const [importing, setImporting] = useState(false)
    const [notice, setNotice] = useState<{ ok: boolean; text: string; folder: string } | null>(null)
    const importFile = async (file: File) => {
        setImporting(true)
        setNotice(null)
        const folder = currentPath
        try {
            const form = new FormData()
            form.set('path', folder)
            form.set('file', file)
            const response = await fetch(base, { method: 'POST', body: form })
            if (response.ok) {
                setNotice({ ok: true, folder, text: `Imported “${file.name}” into ${folder || 'the workspace home'}.` })
                await reload()
            } else setNotice({ ok: false, folder, text: await errorOf(response, `Could not import “${file.name}”.`) })
        } catch {
            setNotice({ ok: false, folder, text: `Could not import “${file.name}”.` })
        } finally {
            setImporting(false)
        }
    }

    const [editingPath, setEditingPath] = useState<string | null>(null)
    const childPath = (name: string) => currentPath ? `${currentPath}/${name}` : name
    const parentOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const selectedHere = selected && parentOf(selected) === currentPath ? selected.slice(selected.lastIndexOf('/') + 1) : null
    const retarget = (value: string, from: string, to: string, directory: boolean) => value === from || (directory && value.startsWith(`${from}/`)) ? `${to}${value.slice(from.length)}` : value
    const renameEntry = async (name: string, next: string) => {
        if (renamingNow.current) return
        renamingNow.current = true
        setRenamePending(true)
        const from = childPath(name)
        const directory = entries.some(entry => entry.name === name && entry.type === 'dir')
        setNotice(null)
        try {
            const response = await fetch(`${base}/rename`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: from, name: next }) })
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

    const breadcrumbs = currentPath.split('/').filter(Boolean)
    const menuEntry = menuName ? entries.find(entry => entry.name === menuName) : undefined

    // Keyed on the path (as FileDetail does), so opening another file leaves the editor by itself.
    const editing = !!preview && editingPath === preview.path

    if (preview && 'conflict' in preview) {
        return <FileEditor base={base} path={preview.path} content={preview.conflict.content} hash={preview.conflict.hash} identity={preview.conflict.identity} initialConflict={preview.conflict} registerCloseGuard={registerCloseGuard}
            onClose={() => setPreview(null)}
            onSaved={(content, hash, identity) => { setPreview({ path: preview.path, content, truncated: false, hash, identity }); setEditingPath(null) }} />
    }

    if (preview && editing && 'hash' in preview && preview.hash) {
        return <FileEditor base={base} path={preview.path} content={preview.content} hash={preview.hash} identity={preview.identity} registerCloseGuard={registerCloseGuard}
            onClose={() => setEditingPath(null)}
            onSaved={(content, hash, identity) => { setPreview({ path: preview.path, content, truncated: false, hash, identity }); setEditingPath(null) }} />
    }

    if (preview) {
        const name = preview.path.split('/').pop()
        const editable = 'hash' in preview && !!preview.hash
        return <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-2 text-sm">
                <Button type="button" variant="ghost" size="sm" aria-label="Back to folder" onClick={() => setPreview(null)}><ArrowLeftIcon className="size-4" /></Button>
                <span className="min-w-0 flex-1 truncate font-medium" title={preview.path}>{name}</span>
                {'content' in preview && <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={!editable}
                    title={editable ? undefined : 'Only UTF-8 .txt and .md files up to 256 KB can be edited here.'} onClick={() => setEditingPath(preview.path)}>Edit</Button>}
            </div>
            {'loading' in preview ? <p role="status" className="text-sm text-muted-foreground">Loading preview…</p>
                : 'error' in preview ? <p role="alert" className="text-sm text-destructive">{preview.error}</p>
                : <>
                    <pre data-testid="file-preview" className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-words">{preview.content}</pre>
                    {preview.truncated && <p className="text-xs text-muted-foreground">Preview shows the first 256 KB.</p>}
                </>}
        </div>
    }

    return <div className="flex min-h-0 flex-1 flex-col">
        <nav aria-label="Folder" className="flex items-center gap-1 overflow-x-auto border-b pb-2 text-xs">
            <button type="button" aria-label="Workspace home" disabled={renamePending} onClick={goHome} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"><HomeIcon className="size-3.5" /></button>
            {breadcrumbs.map((crumb, i) => <span key={i} className="flex shrink-0 items-center gap-1">
                <ChevronRightIcon className="size-3 text-muted-foreground" />
                <button type="button" disabled={renamePending} onClick={() => navigate(breadcrumbs.slice(0, i + 1).join('/'))} className="text-muted-foreground hover:text-foreground">{crumb}</button>
            </span>)}
            <div className="flex-1" />
            <button type="button" disabled={renamePending} onClick={() => setShowHidden(v => !v)} title={showHidden ? 'Hide hidden files' : 'Show hidden files'} aria-label={showHidden ? 'Hide hidden files' : 'Show hidden files'}
                className={`shrink-0 rounded p-1 hover:bg-accent/50 ${showHidden ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                {showHidden ? <EyeIcon className="size-3.5" /> : <EyeOffIcon className="size-3.5" />}
            </button>
            <input ref={fileInput} type="file" accept=".txt,.md,text/plain,text/markdown" className="hidden" data-testid="import-file-input"
                onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file) }} />
            <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 px-2 text-xs" disabled={renamePending || importing || loading || busy || !!error} onClick={() => fileInput.current?.click()}>
                {importing ? 'Importing…' : 'Import file'}
            </Button>
            <button type="button" aria-label="Refresh files" disabled={renamePending} onClick={reload} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"><RefreshCwIcon className="size-3.5" /></button>
        </nav>
        {renamePending && <p role="status" className="pt-2 text-xs text-muted-foreground">Renaming…</p>}
        {notice?.folder === currentPath && <p role={notice.ok ? 'status' : 'alert'} data-testid="import-notice" className={`pt-2 text-xs ${notice.ok ? 'text-muted-foreground' : 'text-destructive'}`}>{notice.text}</p>}
        <div className={`min-h-0 flex-1 overflow-y-auto py-2 ${busy || renamePending ? 'pointer-events-none opacity-60' : ''}`}>
            {loading ? <p role="status" className="text-sm text-muted-foreground">Loading files…</p>
                : error ? <p role="alert" className="text-sm text-destructive">{error}</p>
                : <ContextMenu onOpenChange={open => { if (!open) setMenuName(null) }}>
                    <ContextMenuTrigger asChild>
                        <ul className="space-y-0.5">
                            {currentPath && <li><button type="button" onContextMenu={event => { event.preventDefault(); setMenuName(null) }} disabled={renamePending} onClick={goUp} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50"><FolderIcon className="size-4 text-muted-foreground" />..</button></li>}
                            {entries.map(entry => {
                                const path = childPath(entry.name)
                                const glyph = entry.type === 'dir' ? <FolderIcon className="size-4 shrink-0 text-muted-foreground" /> : <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                                return <li key={entry.name}>
                                    {renaming === entry.name ? <div className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm">
                                        {glyph}
                                        <RenameField name={entry.name} onSubmit={next => { setRenaming(null); void renameEntry(entry.name, next) }} onCancel={() => setRenaming(null)} />
                                    </div> : <button type="button" disabled={renamePending} aria-selected={selectedHere === entry.name} onContextMenu={() => setMenuName(entry.name)}
                                        onClick={() => { setSelected(path); if (entry.type === 'dir') enter(entry.name); else setPreview({ path, loading: true }) }}
                                        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50 ${selectedHere === entry.name ? 'bg-accent/60' : ''}`}>
                                        {glyph}
                                        <span className="truncate">{entry.name}</span>
                                    </button>}
                                </li>
                            })}
                            {entries.length === 0 && <li className="px-2 py-6 text-center text-sm text-muted-foreground">This is your coworker’s workspace. Files it downloads, creates or edits during its runs are stored here.</li>}
                        </ul>
                    </ContextMenuTrigger>
                    {menuEntry && <ContextMenuContent onCloseAutoFocus={event => {
                        const name = renameAfterMenu.current
                        if (!name) return
                        // Mount the inline editor after the menu releases its focus trap. Mounting
                        // in onSelect lets that trap blur and immediately cancel the new field.
                        event.preventDefault()
                        renameAfterMenu.current = null
                        setRenaming(name)
                    }}>
                        <ContextMenuLabel className="max-w-56 truncate">{menuEntry.name}</ContextMenuLabel>
                        <ContextMenuItem disabled={renamePending} onSelect={() => { renameAfterMenu.current = menuEntry.name }}>
                            <PencilIcon className="size-4" />
                            Rename
                        </ContextMenuItem>
                    </ContextMenuContent>}
                </ContextMenu>}
        </div>
    </div>
}

type FileConflict = { content: string; hash: string; identity?: string; stale?: boolean; recovery?: { draft: string; external: string } }
type SaveResponse = { path: string; hash: string; identity?: string } | { error: string; conflict?: true; stale?: boolean; current?: { content: string; hash: string; identity?: string } | null; recovery?: { draft: string; external: string } }

/**
 * Original FileEditorDialog layout and editor, with desktop conflict details. Every close path
 * guards the draft, including the Files dialog behind this modal. Overwrite retries against the
 * version shown, so another change still produces a conflict.
 */
function FileEditor({ base, path, content, hash, identity, initialConflict = null, registerCloseGuard, onClose, onSaved }: { base: string; path: string; content: string; hash: string; identity?: string; initialConflict?: FileConflict | null; registerCloseGuard: (guard: CloseGuard | null) => void; onClose: () => void; onSaved: (content: string, hash: string, identity?: string) => void }) {
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
        registerCloseGuard(requestClose)
        return () => registerCloseGuard(null)
    }, [registerCloseGuard, requestClose])

    useEffect(() => {
        if (!dirty) return
        const warn = (event: BeforeUnloadEvent) => event.preventDefault()
        window.addEventListener('beforeunload', warn)
        return () => window.removeEventListener('beforeunload', warn)
    }, [dirty])

    const save = async (baseHash: string, fileIdentity = opened.identity) => {
        setSaving(true)
        setError('')
        const next = applyEol(draft, opened.eol)
        try {
            const response = await fetch(`${base}/content`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content: next, baseHash, ...(fileIdentity && { identity: fileIdentity }) }) })
            const body = await response.json().catch(() => ({ error: 'Could not save this file.' })) as SaveResponse
            if (response.ok && 'hash' in body) { onSaved(next, body.hash, body.identity); return }
            if ('conflict' in body && body.conflict && body.current) setConflict({ ...body.current, ...(body.recovery && { recovery: body.recovery }), ...(body.stale ? { stale: true } : {}) })
            else setError('error' in body && body.error ? `${body.error} Your edits are still here; try again.` : 'Could not save this file. Your edits are still here; try again.')
        } catch {
            setError('Could not save this file. Your edits are still here; try again.')
        } finally {
            setSaving(false)
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
                <FileTextEditor value={draft} onChange={setDraft} fileName={name ?? path} readOnly={saving} autoFocus onSave={saveDraft} />
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

export function DesktopCoworkerFiles({ agent }: { agent: DesktopAgentView }) {
    const [open, setOpen] = useState(false)
    const closeGuard = useRef<CloseGuard | null>(null)
    const registerCloseGuard = useCallback((guard: CloseGuard | null) => { closeGuard.current = guard }, [])
    const changeOpen = (next: boolean) => {
        if (!next && closeGuard.current) closeGuard.current(() => setOpen(false))
        else setOpen(next)
    }
    return <Dialog open={open} onOpenChange={changeOpen} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Files</Button></DialogTrigger>
        {open && <DialogContent className="flex h-[75dvh] flex-col sm:max-w-2xl" onEscapeKeyDown={event => {
            // Radix handles Escape at document capture before the field can stop propagation.
            // Let the inline field cancel its name edit without dismissing the Files dialog.
            if (event.target instanceof HTMLElement && event.target.hasAttribute('data-desktop-file-rename')) event.preventDefault()
        }}>
            <DialogHeader>
                <DialogTitle>Files</DialogTitle>
                <DialogDescription>{agent.name}’s workspace. Browse, preview, edit, rename, or import a .txt or .md file.</DialogDescription>
            </DialogHeader>
            <FilesPanel key={agent.id} agent={agent} registerCloseGuard={registerCloseGuard} />
            <DialogFooter><DialogClose asChild><Button type="button">Done</Button></DialogClose></DialogFooter>
        </DialogContent>}
    </Dialog>
}
