'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useFileNavigation } from '@/components/files/useFileNavigation'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { ArrowLeftIcon, ChevronRightIcon, EyeIcon, EyeOffIcon, FileTextIcon, FolderIcon, HomeIcon, RefreshCwIcon } from '@/lib/icons'
import type { DesktopAgentView } from './DesktopApp'

type Entry = { name: string; type: 'file' | 'dir'; size: number; modifiedAt: string }
type Preview = { path: string; content: string; truncated: boolean } | { path: string; error: string } | { path: string; loading: true }

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
                const next: Preview = response.ok ? await response.json() : { path: openPath, error: await errorOf(response, 'Could not preview this file.') }
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

    if (preview) {
        const name = preview.path.split('/').pop()
        return <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-2 text-sm">
                <Button type="button" variant="ghost" size="sm" aria-label="Back to folder" onClick={() => setPreview(null)}><ArrowLeftIcon className="size-4" /></Button>
                <span className="truncate font-medium" title={preview.path}>{name}</span>
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

export function DesktopCoworkerFiles({ agent }: { agent: DesktopAgentView }) {
    const [open, setOpen] = useState(false)
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Files</Button></DialogTrigger>
        {open && <DialogContent className="flex h-[75dvh] flex-col sm:max-w-2xl">
            <DialogHeader>
                <DialogTitle>Files</DialogTitle>
                <DialogDescription>{agent.name}’s workspace. Browse, preview, or import a .txt or .md file.</DialogDescription>
            </DialogHeader>
            <FilesPanel key={agent.id} agent={agent} />
            <DialogFooter><DialogClose asChild><Button type="button">Done</Button></DialogClose></DialogFooter>
        </DialogContent>}
    </Dialog>
}
