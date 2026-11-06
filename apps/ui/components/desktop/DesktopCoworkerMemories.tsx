'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { memoriesListSchema, desktopSemanticIndexStatusSchema, desktopSemanticRecallResultSchema, type DesktopSemanticIndexStatus } from '@rerun/contracts'
import { MemoryRow } from '@/components/agent/MemoryRow'
import { ClearMemoriesDialog } from '@/components/dialogs/ClearMemoriesDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { PanelList } from '@/components/ui/panel-list'
import { Textarea } from '@/components/ui/textarea'
import { BrainIcon, PlusIcon, Trash2Icon } from '@/lib/icons'
import type { EngineMemory } from '@/lib/engine/types'
import type { DesktopAgentView } from './DesktopApp'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'

type Result = { memories: EngineMemory[] } | { error: string }
type Draft = { content: string; kind: string; tags: string }

function MemoryPanel({ agent }: { agent: DesktopAgentView }) {
    const url = `/api/desktop/agents/${encodeURIComponent(agent.id)}/memories`
    const semanticUrl = `/api/desktop/coworkers/${encodeURIComponent(agent.id)}/semantic-memory`
    const [result, setResult] = useState<Result | null>(null)
    const [hasMemories, setHasMemories] = useState(false)
    const [revision, setRevision] = useState(0)
    const [query, setQuery] = useState('')
    const [activeQuery, setActiveQuery] = useState('')
    const [draft, setDraft] = useState<Draft | null>(null)
    const submission = useRef<{ payload: string; id: string } | null>(null)
    const [writing, setWriting] = useState(false)
    const [error, setError] = useState('')
    const [confirmClear, setConfirmClear] = useState(false)
    const [indexStatus, setIndexStatus] = useState<DesktopSemanticIndexStatus | null>(null)
    const [recallDetail, setRecallDetail] = useState('')
    const [indexBusy, setIndexBusy] = useState(false)
    const maintenance = useRef<AbortController | null>(null)

    useEffect(() => () => maintenance.current?.abort(), [])
    useEffect(() => {
        const controller = new AbortController()
        if (!activeQuery) void fetch(semanticUrl, { cache: 'no-store', signal: controller.signal }).then(async response => {
            if (!response.ok) return
            const status = desktopSemanticIndexStatusSchema.safeParse(await response.json())
            if (status.success && !controller.signal.aborted) setIndexStatus(status.data)
        }).catch(() => {})
        return () => controller.abort()
    }, [semanticUrl, revision, activeQuery])

    useEffect(() => {
        const controller = new AbortController()
        async function load() {
            try {
                const options: RequestInit = { cache: 'no-store', signal: controller.signal }
                const response = activeQuery
                    ? await fetch(semanticUrl, { ...options, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: activeQuery }) })
                    : await fetch(url, options)
                if (!response.ok) throw new Error('Could not load coworker memories.')
                const raw = await response.json()
                const semantic = activeQuery ? desktopSemanticRecallResultSchema.parse(raw) : null
                const data = semantic ? { memories: semantic.memories } : memoriesListSchema.parse(raw)
                if (!controller.signal.aborted) {
                    setResult(data)
                    setRecallDetail(semantic?.detail ?? '')
                    if (semantic) setIndexStatus(semantic.index)
                    // Like Rerun's separate memories/recall lists, an empty search does not hide
                    // clear-all when the unfiltered list already showed saved notes.
                    if (!activeQuery || data.memories.length > 0) setHasMemories(data.memories.length > 0)
                }
            } catch {
                if (!controller.signal.aborted) setResult({ error: activeQuery ? 'Could not search memories. Try again.' : 'Could not load coworker memories. Try again.' })
            }
        }
        void load()
        return () => controller.abort()
    }, [url, semanticUrl, revision, activeQuery])

    async function retryIndex() {
        if (indexBusy) return
        maintenance.current?.abort()
        const controller = new AbortController()
        maintenance.current = controller
        setIndexBusy(true)
        setError('')
        try {
            const response = await fetch(`${semanticUrl}/index`, { method: 'POST', cache: 'no-store', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'retry' }) })
            if (!response.ok) throw new Error('Could not retry memory indexing.')
            const status = desktopSemanticIndexStatusSchema.parse(await response.json())
            if (!controller.signal.aborted) { setIndexStatus(status); refresh() }
        } catch {
            if (!controller.signal.aborted) setError('Could not retry memory indexing. Try again.')
        } finally { if (!controller.signal.aborted) setIndexBusy(false) }
    }

    function refresh() {
        setResult(null)
        setRevision(current => current + 1)
    }

    function search(value: string) {
        setActiveQuery(value.trim())
        refresh()
    }

    async function changeMemory(target: string, options: RequestInit, message: string) {
        setWriting(true)
        setError('')
        try {
            const response = await fetch(target, options)
            // A prior single-note delete may already have succeeded before its response reached
            // this window; a missing coworker on a clear-all is a genuine failure instead.
            if (!response.ok && !(options.method === 'DELETE' && target !== url && response.status === 404)) {
                const body = await response.json().catch(() => null)
                throw new Error(typeof body?.error === 'string' ? body.error : message)
            }
            refresh()
            return true
        } catch (cause) {
            setError(cause instanceof Error && cause.name !== 'TypeError' ? cause.message : message)
            return false
        } finally {
            setWriting(false)
        }
    }

    async function create(event: FormEvent) {
        event.preventDefault()
        if (writing || !draft?.content.trim()) return
        const tags = draft.tags.split(',').map(tag => tag.trim()).filter(Boolean)
        const note = { content: draft.content.trim(), kind: draft.kind.trim() || undefined, tags: tags.length ? tags : undefined }
        const payload = JSON.stringify(note)
        if (submission.current?.payload !== payload) submission.current = { payload, id: crypto.randomUUID() }
        const saved = await changeMemory(url, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...note, requestId: submission.current.id }),
        }, 'Could not save this memory. Try again.')
        if (saved) { setDraft(null); submission.current = null }
    }

    // The original panel retires the active recall search with the confirmed clear, so the refreshed
    // list is what remains. A failed or lost response may follow partial progress: refresh the
    // remaining notes while keeping the search and error available for a retry.
    async function clearAll() {
        setConfirmClear(false)
        const cleared = await changeMemory(url, { method: 'DELETE' }, 'Could not clear these memories. Try again.')
        if (cleared) { setHasMemories(false); setQuery(''); setActiveQuery('') }
        else refresh()
    }

    return <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-xl" showCloseButton={!writing}
        onEscapeKeyDown={event => { if (writing) event.preventDefault() }}
        onInteractOutside={event => { if (writing) event.preventDefault() }}>
        <DialogHeader>
            <DialogTitle>Memories</DialogTitle>
            <DialogDescription>Saved memories for {agent.name}.</DialogDescription>
        </DialogHeader>
        <fieldset disabled={writing} className="min-h-0 space-y-3 overflow-y-auto">
            <form role="search" aria-label="Search coworker memories" className="flex flex-wrap items-end gap-2"
                onSubmit={event => { event.preventDefault(); search(query) }}>
                <div className="min-w-40 flex-1">
                    <Input id="desktop-memory-search" label="Recall memories" hideRequired value={query}
                        placeholder="Search saved notes…" onChange={event => {
                            setQuery(event.target.value)
                            if (!event.target.value.trim() && activeQuery) search('')
                        }} />
                </div>
                <Button type="submit" size="sm" variant="outline" disabled={!query.trim()}>Search</Button>
                {(activeQuery || query) && <Button type="button" size="sm" variant="ghost" onClick={() => { setQuery(''); search('') }}>Clear search</Button>}
                {hasMemories && (
                    <Button type="button" size="icon-sm" variant="destructive" title="Clear all memories" aria-label="Clear all memories" onClick={() => setConfirmClear(true)}>
                        <Trash2Icon />
                    </Button>
                )}
            </form>
            {indexStatus && <div className="flex flex-wrap items-center gap-2">
                <p role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">{recallDetail || indexStatus.detail}</p>
                {indexStatus.backend && indexStatus.mode !== 'ready' && <Button type="button" size="sm" variant="outline" disabled={indexBusy} loading={indexBusy} onClick={() => void retryIndex()}>Retry indexing</Button>}
            </div>}
            {draft ? <form onSubmit={create} className="space-y-3 rounded-lg border p-3">
                <Textarea id="desktop-memory-content" label="Content" required value={draft.content} onChange={e => setDraft({ ...draft, content: e.target.value })}
                    placeholder="The user prefers concise answers." className="min-h-20" />
                <div className="grid gap-2 sm:grid-cols-2">
                    <Input id="desktop-memory-kind" label="Kind" hideRequired value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value })} placeholder="note" />
                    <Input id="desktop-memory-tags" label="Tags" hideRequired value={draft.tags} onChange={e => setDraft({ ...draft, tags: e.target.value })} placeholder="Separate tags with commas" />
                </div>
                <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={!draft.content.trim()}>Save memory</Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => { setDraft(null); setError('') }}>Cancel</Button>
                </div>
            </form> : <Button type="button" size="sm" variant="outline" onClick={() => { submission.current = null; setDraft({ content: '', kind: '', tags: '' }); setError('') }}>
                <PlusIcon className="size-4" aria-hidden /> Add memory
            </Button>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {activeQuery && result && 'memories' in result && <p role="status" className="text-sm text-muted-foreground">{result.memories.length} recalled for “{activeQuery}”</p>}
            {!result ? <p role="status" className="text-sm text-muted-foreground">{activeQuery ? 'Searching memories…' : 'Loading memories…'}</p>
                : 'error' in result ? <p role="alert" className="text-sm text-destructive">{result.error}</p>
                : result.memories.length ? <PanelList>{result.memories.map(memory => <MemoryRow key={memory.id} memory={memory}
                    confirmDescription={`This permanently deletes “${memory.content.length > 140 ? memory.content.slice(0, 140) + '…' : memory.content}” from ${agent.name}’s memories.`}
                    onDelete={memory.id ? () => void changeMemory(`${url}/${encodeURIComponent(memory.id)}`, { method: 'DELETE' }, 'Could not delete this memory. Try again.') : undefined} />)}</PanelList>
                : activeQuery ? <EmptyState icon={BrainIcon} title="No matches" description="Try another keyword or clear the search to see all saved notes." />
                : <EmptyState icon={BrainIcon} title="No memories yet" description="Saved memories for this coworker will appear here." />}
        </fieldset>
        <DialogFooter>
            {result && <Button type="button" variant="outline" disabled={writing} onClick={refresh}>{'error' in result ? 'Retry' : 'Refresh'}</Button>}
            <DialogClose asChild><Button type="button" disabled={writing}>Done</Button></DialogClose>
        </DialogFooter>
        <ClearMemoriesDialog open={confirmClear} onOpenChange={setConfirmClear} onConfirm={clearAll} />
    </DialogContent>
}

export function DesktopCoworkerMemories({ agent, dialogControl }: { agent: DesktopAgentView; dialogControl?: DesktopDialogControl }) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Memories</Button></DialogTrigger>
        {open && <MemoryPanel key={agent.id} agent={agent} />}
    </Dialog>
}
