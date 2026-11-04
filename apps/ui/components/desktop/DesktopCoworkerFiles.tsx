'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useFileNavigation } from '@/components/files/useFileNavigation'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { ArrowLeftIcon, ChevronRightIcon, EyeIcon, EyeOffIcon, FileTextIcon, FolderIcon, HomeIcon, RefreshCwIcon } from '@/lib/icons'
import { applyEol, splitEol } from '@/lib/files/editable'
import type { DesktopAgentView } from './DesktopApp'

type Entry = { name: string; type: 'file' | 'dir'; size: number; modifiedAt: string }
type Preview = { path: string; content: string; truncated: boolean; hash?: string } | { path: string; error: string } | { path: string; loading: true } | { path: string; conflict: FileConflict }

async function errorOf(response: Response, fallback: string) {
    const body = await response.json().catch(() => null)
    return typeof body?.error === 'string' ? body.error : fallback
}

/** Port of AgentPanelFiles: breadcrumb folder navigation, a text preview, and a single .txt/.md import, scoped to one coworker. */
function FilesPanel({ agent }: { agent: DesktopAgentView }) {
    const base = `/api/desktop/agents/${encodeURIComponent(agent.id)}/files`
    const [error, setError] = useState('')
    const [preview, setPreview] = useState<Preview | null>(null)

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

    const breadcrumbs = currentPath.split('/').filter(Boolean)

    // Keyed on the path (as FileDetail does), so opening another file leaves the editor by itself.
    const [editingPath, setEditingPath] = useState<string | null>(null)
    const editing = !!preview && editingPath === preview.path

    if (preview && 'conflict' in preview) {
        return <FileEditor base={base} path={preview.path} content={preview.conflict.content} hash={preview.conflict.hash} initialConflict={preview.conflict}
            onClose={() => setPreview(null)}
            onSaved={(content, hash) => { setPreview({ path: preview.path, content, truncated: false, hash }); setEditingPath(null) }} />
    }

    if (preview && editing && 'hash' in preview && preview.hash) {
        return <FileEditor base={base} path={preview.path} content={preview.content} hash={preview.hash}
            onClose={() => setEditingPath(null)}
            onSaved={(content, hash) => { setPreview({ path: preview.path, content, truncated: false, hash }); setEditingPath(null) }} />
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
            <button type="button" aria-label="Workspace home" onClick={goHome} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"><HomeIcon className="size-3.5" /></button>
            {breadcrumbs.map((crumb, i) => <span key={i} className="flex shrink-0 items-center gap-1">
                <ChevronRightIcon className="size-3 text-muted-foreground" />
                <button type="button" onClick={() => navigate(breadcrumbs.slice(0, i + 1).join('/'))} className="text-muted-foreground hover:text-foreground">{crumb}</button>
            </span>)}
            <div className="flex-1" />
            <button type="button" onClick={() => setShowHidden(v => !v)} title={showHidden ? 'Hide hidden files' : 'Show hidden files'} aria-label={showHidden ? 'Hide hidden files' : 'Show hidden files'}
                className={`shrink-0 rounded p-1 hover:bg-accent/50 ${showHidden ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                {showHidden ? <EyeIcon className="size-3.5" /> : <EyeOffIcon className="size-3.5" />}
            </button>
            <input ref={fileInput} type="file" accept=".txt,.md,text/plain,text/markdown" className="hidden" data-testid="import-file-input"
                onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file) }} />
            <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 px-2 text-xs" disabled={importing || loading || busy || !!error} onClick={() => fileInput.current?.click()}>
                {importing ? 'Importing…' : 'Import file'}
            </Button>
            <button type="button" aria-label="Refresh files" onClick={reload} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"><RefreshCwIcon className="size-3.5" /></button>
        </nav>
        {notice?.folder === currentPath && <p role={notice.ok ? 'status' : 'alert'} data-testid="import-notice" className={`pt-2 text-xs ${notice.ok ? 'text-muted-foreground' : 'text-destructive'}`}>{notice.text}</p>}
        <div className={`min-h-0 flex-1 overflow-y-auto py-2 ${busy ? 'pointer-events-none opacity-60' : ''}`}>
            {loading ? <p role="status" className="text-sm text-muted-foreground">Loading files…</p>
                : error ? <p role="alert" className="text-sm text-destructive">{error}</p>
                : <ul className="space-y-0.5">
                    {currentPath && <li><button type="button" onClick={goUp} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50"><FolderIcon className="size-4 text-muted-foreground" />..</button></li>}
                    {entries.map(entry => <li key={entry.name}>
                        <button type="button" onClick={() => entry.type === 'dir' ? enter(entry.name) : setPreview({ path: currentPath ? `${currentPath}/${entry.name}` : entry.name, loading: true })}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50">
                            {entry.type === 'dir' ? <FolderIcon className="size-4 text-muted-foreground" /> : <FileTextIcon className="size-4 text-muted-foreground" />}
                            <span className="truncate">{entry.name}</span>
                        </button>
                    </li>)}
                    {entries.length === 0 && <li className="px-2 py-6 text-center text-sm text-muted-foreground">This is your coworker’s workspace. Files it downloads, creates or edits during its runs are stored here.</li>}
                </ul>}
        </div>
    </div>
}

type FileConflict = { content: string; hash: string; recovery?: { draft: string; external: string } }
type SaveResponse = { path: string; hash: string } | { error: string; conflict?: true; current?: { content: string; hash: string } | null; recovery?: { draft: string; external: string } }

/**
 * Port of FileDetail's FileEditorDialog/useFileDraft. Cancel discards only after asking when there
 * are edits. A stale save (the file changed since the editor opened) keeps both versions on screen:
 * the user's draft stays in the editor and the newer disk text is shown beside it, with Reload
 * (take the disk version, keeping the draft visible to copy) or Save mine anyway (retry against the
 * version now shown, so a third change is still caught).
 */
function FileEditor({ base, path, content, hash, initialConflict = null, onClose, onSaved }: { base: string; path: string; content: string; hash: string; initialConflict?: FileConflict | null; onClose: () => void; onSaved: (content: string, hash: string) => void }) {
    const [opened, setOpened] = useState(() => ({ ...splitEol(content), hash }))
    const [draft, setDraft] = useState(opened.text)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    const [conflict, setConflict] = useState<FileConflict | null>(initialConflict)
    const [setAside, setSetAside] = useState<string | null>(null)
    const [confirmingDiscard, setConfirmingDiscard] = useState(false)
    const dirty = draft !== opened.text
    const name = path.split('/').pop()

    useEffect(() => {
        if (!dirty) return
        const warn = (event: BeforeUnloadEvent) => event.preventDefault()
        window.addEventListener('beforeunload', warn)
        return () => window.removeEventListener('beforeunload', warn)
    }, [dirty])

    const save = async (baseHash: string) => {
        setSaving(true)
        setError('')
        const next = applyEol(draft, opened.eol)
        try {
            const response = await fetch(`${base}/content`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content: next, baseHash }) })
            const body = await response.json().catch(() => ({ error: 'Could not save this file.' })) as SaveResponse
            if (response.ok && 'hash' in body) { onSaved(next, body.hash); return }
            if ('conflict' in body && body.conflict && body.current) setConflict({ ...body.current, ...(body.recovery && { recovery: body.recovery }) })
            else setError('error' in body && body.error ? `${body.error} Your edits are still here; try again.` : 'Could not save this file. Your edits are still here; try again.')
        } catch {
            setError('Could not save this file. Your edits are still here; try again.')
        } finally {
            setSaving(false)
        }
    }

    const reload = () => {
        if (!conflict) return
        const fresh = { ...splitEol(conflict.content), hash: conflict.hash }
        if (dirty) setSetAside(draft)
        setOpened(fresh)
        setDraft(fresh.text)
        setConflict(null)
    }

    const requestClose = () => { if (saving) return; if (dirty) setConfirmingDiscard(true); else onClose() }

    return <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="file-editor">
        <div className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>Editing {name}</span>
            {dirty && <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-[10px] text-orange-600">Unsaved</span>}
        </div>
        <textarea aria-label={`Edit ${name}`} value={draft} onChange={event => setDraft(event.target.value)} readOnly={saving} autoFocus spellCheck={false}
            onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); if (dirty && !saving && !conflict) void save(opened.hash) } }}
            className="min-h-0 flex-1 resize-none rounded-md border bg-background p-3 font-mono text-xs" />
        {conflict && <div role="alert" data-testid="edit-conflict" className="space-y-2 rounded-md border border-orange-500/40 bg-orange-500/5 p-2 text-xs">
            <p className="font-medium">{initialConflict
                ? `${name} was recovered after an interrupted save. Your draft is in the named recovery copy; the external version is below.`
                : `${name} changed on disk after you opened it. Your edits are still in the editor; the newer version is below. Nothing was saved.`}</p>
            <pre data-testid="conflict-disk" className="max-h-32 overflow-auto rounded border bg-muted/30 p-2 font-mono whitespace-pre-wrap break-words">{conflict.content}</pre>
            {conflict.recovery && <p data-testid="edit-recovery" className="break-words text-muted-foreground">
                Recovery copies in Files: <code>{conflict.recovery.draft}</code> holds your draft; <code>{conflict.recovery.external}</code> holds the external version. The external version is also back at its original path.
            </p>}
            <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={reload} disabled={saving}>Keep theirs</Button>
                <Button type="button" size="sm" onClick={() => void save(conflict.hash)} disabled={saving}>Overwrite</Button>
            </div>
        </div>}
        {setAside !== null && <div className="space-y-1 text-xs" data-testid="set-aside">
            <p className="text-muted-foreground">Reloaded the newer version. Your previous edits, not saved:</p>
            <textarea readOnly aria-label="Your previous edits" value={setAside} className="h-24 w-full resize-none rounded border bg-muted/30 p-2 font-mono text-xs" />
            <div className="flex justify-end"><Button type="button" variant="ghost" size="sm" onClick={() => setSetAside(null)}>Dismiss</Button></div>
        </div>}
        {error && <p role="alert" data-testid="edit-error" className="text-xs text-destructive">{error}</p>}
        {confirmingDiscard ? <div role="alertdialog" aria-label="Discard your changes?" className="flex items-center justify-end gap-2 text-xs">
            <span className="flex-1">Discard your changes to {name}? The file on disk stays as it was.</span>
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingDiscard(false)}>Keep editing</Button>
            <Button type="button" variant="destructive" size="sm" onClick={onClose}>Discard changes</Button>
        </div> : <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={requestClose} disabled={saving}>Cancel</Button>
            <Button type="button" size="sm" onClick={() => void save(opened.hash)} disabled={!dirty || saving || !!conflict}>{saving ? 'Saving…' : 'Save changes'}</Button>
        </div>}
    </div>
}

export function DesktopCoworkerFiles({ agent }: { agent: DesktopAgentView }) {
    const [open, setOpen] = useState(false)
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Files</Button></DialogTrigger>
        {open && <DialogContent className="flex h-[75dvh] flex-col sm:max-w-2xl">
            <DialogHeader>
                <DialogTitle>Files</DialogTitle>
                <DialogDescription>{agent.name}’s workspace. Browse, preview, edit, or import a .txt or .md file.</DialogDescription>
            </DialogHeader>
            <FilesPanel key={agent.id} agent={agent} />
            <DialogFooter><DialogClose asChild><Button type="button">Done</Button></DialogClose></DialogFooter>
        </DialogContent>}
    </Dialog>
}
