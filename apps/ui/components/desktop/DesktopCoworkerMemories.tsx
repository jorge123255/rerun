'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { memoriesListSchema, desktopSemanticIndexStatusSchema, desktopSemanticRecallResultSchema, type DesktopSemanticIndexStatus, type DesktopSemanticRecallResult } from '@rerun/contracts'
import { MemoryRow } from '@/components/agent/MemoryRow'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { useFileUnloadGuard } from '@/components/files/useFileUnloadGuard'
import { ClearMemoriesDialog } from '@/components/dialogs/ClearMemoriesDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { PanelList, PanelListHeader, PanelScroller } from '@/components/ui/panel-list'
import { FxMemoriesLoading } from './fx-repairs/PanelLoadingSkeletons'
import { Textarea } from '@/components/ui/textarea'
import { BrainIcon, PlusIcon, SearchIcon, Trash2Icon, XIcon, BookmarkIcon } from '@/lib/icons'
import type { EngineMemory } from '@/lib/engine/types'
import type { DesktopAgentView } from './DesktopApp'
import { desktopFileDraftHost, holdDraftAdmission, isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { useDesktopDialogControl, useDesktopPanelCloseGuard, type DesktopDialogControl, type RegisterDesktopPanelCloseGuard } from '@/lib/desktop/use-dialog-control'

type Result<T> = T | { error: string }
type Load<T> = { revision: number; result: Result<T> }
type RecallRequest = { query: string }
type SavedMemories = { memories: EngineMemory[] }
type Draft = { content: string; kind: string; tags: string }

export function DesktopCoworkerMemoriesBody({ agent, registerCloseGuard, inDialog = false }: {
    agent: DesktopAgentView
    registerCloseGuard: RegisterDesktopPanelCloseGuard
    inDialog?: boolean
}) {
    const fieldId = useId()
    const url = `/api/desktop/agents/${encodeURIComponent(agent.id)}/memories`
    const semanticUrl = `/api/desktop/coworkers/${encodeURIComponent(agent.id)}/semantic-memory`
    const [saved, setSaved] = useState<Load<SavedMemories> | null>(null)
    const [recall, setRecall] = useState<(Load<DesktopSemanticRecallResult> & { request: RecallRequest }) | null>(null)
    const [revision, setRevision] = useState(0)
    const [query, setQuery] = useState('')
    const [recallRequest, setRecallRequest] = useState<RecallRequest | null>(null)
    const [draft, setDraft] = useState<Draft | null>(null)
    const submission = useRef<{ payload: string; id: string } | null>(null)
    const writingNow = useRef(false)
    const [writing, setWriting] = useState(false)
    const [pendingClose, setPendingClose] = useState<(() => void) | null>(null)
    const [error, setError] = useState('')
    const [confirmClear, setConfirmClear] = useState(false)
    const [savedIndex, setSavedIndex] = useState<{ revision: number; status: DesktopSemanticIndexStatus } | null>(null)
    const [indexBusy, setIndexBusy] = useState(false)
    const maintenance = useRef<AbortController | null>(null)

    const unsaved = !!(draft?.content.trim() || draft?.kind.trim() || draft?.tags.trim())
    useFileUnloadGuard(unsaved, desktopFileDraftHost())
    const guardClose = useCallback((close: () => void) => {
        if (writingNow.current) return
        if (unsaved) setPendingClose(() => close)
        else close()
    }, [unsaved])
    useLayoutEffect(() => registerCloseGuard(guardClose), [registerCloseGuard, guardClose])

    const recalling = recallRequest !== null
    const activeQuery = recallRequest?.query ?? ''
    const savedResult = saved?.revision === revision ? saved.result : null
    const recallResult = recall && recall.request === recallRequest && recall.revision === revision ? recall.result : null
    const result = recalling ? recallResult : savedResult
    // Clear all is a property of the saved list, even while showing recall results.
    const hasMemories = !!savedResult && 'memories' in savedResult && savedResult.memories.length > 0
    const settledRecall = recallResult && 'index' in recallResult ? recallResult : null
    const indexStatus = recalling ? settledRecall?.index : savedIndex?.revision === revision ? savedIndex.status : null

    useEffect(() => () => maintenance.current?.abort(), [])
    useEffect(() => {
        if (recalling) return
        const controller = new AbortController()
        void fetch(semanticUrl, { cache: 'no-store', signal: controller.signal }).then(async response => {
            if (!response.ok) return
            const status = desktopSemanticIndexStatusSchema.safeParse(await response.json())
            if (status.success && !controller.signal.aborted) setSavedIndex({ revision, status: status.data })
        }).catch(() => {})
        return () => controller.abort()
    }, [semanticUrl, revision, recalling])

    useEffect(() => {
        const controller = new AbortController()
        void (async () => {
            try {
                const response = await fetch(url, { cache: 'no-store', signal: controller.signal })
                if (!response.ok) throw new Error('Could not load coworker memories.')
                const result = memoriesListSchema.parse(await response.json())
                if (!controller.signal.aborted) setSaved({ revision, result })
            } catch {
                if (!controller.signal.aborted) setSaved({ revision, result: { error: 'Could not load coworker memories. Try again.' } })
            }
        })()
        return () => controller.abort()
    }, [url, revision])

    useEffect(() => {
        if (!recallRequest) return
        const controller = new AbortController()
        void (async () => {
            try {
                const response = await fetch(semanticUrl, {
                    method: 'POST', cache: 'no-store', signal: controller.signal,
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ query: recallRequest.query }),
                })
                if (!response.ok) throw new Error('Could not search memories.')
                const result = desktopSemanticRecallResultSchema.parse(await response.json())
                if (!controller.signal.aborted) setRecall({ revision, request: recallRequest, result })
            } catch {
                if (!controller.signal.aborted) setRecall({ revision, request: recallRequest, result: { error: 'Could not search memories. Try again.' } })
            }
        })()
        return () => controller.abort()
    }, [semanticUrl, revision, recallRequest])

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
            desktopSemanticIndexStatusSchema.parse(await response.json())
            if (!controller.signal.aborted) refresh()
        } catch {
            if (!controller.signal.aborted) setError('Could not retry memory indexing. Try again.')
        } finally { if (!controller.signal.aborted) setIndexBusy(false) }
    }

    function refresh() {
        setRevision(current => current + 1)
    }

    function search(value: string) {
        const text = value.trim()
        if (!text && recalling) setSavedIndex(null)
        setRecallRequest(text ? { query: text } : null)
    }

    async function changeMemory(target: string, options: RequestInit, message: string) {
        if (writingNow.current || isDesktopQuitting()) return false
        writingNow.current = true
        const release = holdDraftAdmission()
        setWriting(true)
        setError('')
        try {
            const response = await fetch(target, { ...options, signal: AbortSignal.timeout(20_000) })
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
            writingNow.current = false
            setWriting(false)
            release()
        }
    }

    async function create(event: FormEvent) {
        event.preventDefault()
        if (writingNow.current || isDesktopQuitting() || !draft?.content.trim()) return
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
        if (cleared) { setQuery(''); search('') }
        else refresh()
    }

    const content = <>
        <fieldset disabled={writing} aria-busy={writing || undefined} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <PanelListHeader className="flex-col items-stretch gap-2 px-0 pt-0">
                <form role="search" aria-label="Search coworker memories" className="flex flex-wrap items-center gap-2"
                    onSubmit={event => { event.preventDefault(); search(query) }}>
                    <div className="relative min-w-40 flex-1">
                        <SearchIcon aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input id={fieldId + '-search'} name="memory-search" aria-label="Recall memories" hideRequired value={query}
                            className="h-8 pl-7 pr-8 text-xs" placeholder="Recall memories…" onChange={event => {
                                setQuery(event.target.value)
                                if (!event.target.value.trim() && recalling) search('')
                            }} />
                        {(recalling || query) && <Button type="button" size="icon-xs" variant="ghost" title="Clear search"
                            className="absolute right-1 top-1/2 -translate-y-1/2" onClick={() => { setQuery(''); search('') }}>
                            <XIcon aria-hidden className="size-3.5" /><span className="sr-only">Clear search</span>
                        </Button>}
                    </div>
                    <Button type="submit" size="sm" variant="outline" disabled={!query.trim()}>Search</Button>
                    {!draft && <Button type="button" size="sm" variant="outline" onClick={() => { submission.current = null; setDraft({ content: '', kind: '', tags: '' }); setError('') }}>
                        <PlusIcon className="size-3.5" aria-hidden /> Add memory
                    </Button>}
                    {hasMemories && <Button type="button" size="icon-sm" variant="destructive" title="Clear all memories" aria-label="Clear all memories" onClick={() => setConfirmClear(true)}>
                        <Trash2Icon />
                    </Button>}
                </form>
                {indexStatus && <div className="flex flex-wrap items-center gap-2">
                    <p role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">{settledRecall?.detail || indexStatus.detail}</p>
                    {indexStatus.backend && indexStatus.mode !== 'ready' && <Button type="button" size="sm" variant="outline" disabled={indexBusy} loading={indexBusy} onClick={() => void retryIndex()}>Retry indexing</Button>}
                </div>}
                {settledRecall && <p role="status" className="text-xs text-muted-foreground">{settledRecall.memories.length} recalled for “{activeQuery}”</p>}
            </PanelListHeader>
            <PanelScroller className="space-y-3 px-0">
                {draft ? <form onSubmit={create} className="space-y-3 rounded-lg border p-3">
                    <Textarea id={fieldId + '-content'} name="memory-content" label="Content" required value={draft.content} onChange={e => setDraft({ ...draft, content: e.target.value })}
                        placeholder="The user prefers concise answers." className="min-h-20" />
                    <div className="grid gap-2 sm:grid-cols-2">
                        <Input id={fieldId + '-kind'} name="memory-kind" label="Kind" hideRequired value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value })} placeholder="note" />
                        <Input id={fieldId + '-tags'} name="memory-tags" label="Tags" hideRequired value={draft.tags} onChange={e => setDraft({ ...draft, tags: e.target.value })} placeholder="Separate tags with commas" />
                    </div>
                    <div className="flex gap-2">
                        <Button type="submit" size="sm" disabled={!draft.content.trim()}>Save memory</Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => { setDraft(null); setError('') }}>Cancel</Button>
                    </div>
                </form> : null}
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                {!result ? <FxMemoriesLoading searching={!!activeQuery} />
                    : 'error' in result ? <p role="alert" className="text-sm text-destructive">{result.error}</p>
                    : result.memories.length ? <PanelList>{result.memories.map(memory => <MemoryRow key={memory.id} memory={memory}
                        confirmDescription={`This permanently deletes “${memory.content.length > 140 ? memory.content.slice(0, 140) + '…' : memory.content}” from ${agent.name}’s memories.`}
                        onDelete={memory.id ? () => void changeMemory(`${url}/${encodeURIComponent(memory.id)}`, { method: 'DELETE' }, 'Could not delete this memory. Try again.') : undefined} />)}</PanelList>
                    : activeQuery ? <EmptyState icon={BrainIcon} title="No matches" description="Try another keyword or clear the search to see all saved notes." />
                    : <EmptyState icon={BrainIcon} title="No memories yet" description="Saved memories for this coworker will appear here." />}
            </PanelScroller>
        </fieldset>
        <DialogFooter>
            {result && <Button type="button" variant="outline" disabled={writing} onClick={refresh}>{'error' in result ? 'Retry' : 'Refresh'}</Button>}
            {inDialog && <DialogClose asChild><Button type="button" disabled={writing}>Done</Button></DialogClose>}
        </DialogFooter>
        <ClearMemoriesDialog open={confirmClear} onOpenChange={setConfirmClear} onConfirm={clearAll} />
        {pendingClose && <ConfirmDialog open onOpenChange={open => { if (!open) setPendingClose(null) }}
            title="Discard this memory draft?" description="The new memory has not been saved."
            confirmLabel="Discard draft" cancelLabel="Keep editing"
            onConfirm={() => { setPendingClose(null); pendingClose() }} />}
    </>
    if (!inDialog) return content
    return <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-xl" showCloseButton={!writing}
        onEscapeKeyDown={event => { if (writingNow.current) event.preventDefault() }}
        onInteractOutside={event => { if (writingNow.current) event.preventDefault() }}>
        <DialogHeaderBar icon={BookmarkIcon} title="Memories" description={<>Saved memories for {agent.name}.</>} />
        {content}
    </DialogContent>
}

export function DesktopCoworkerMemories({ agent, dialogControl }: { agent: DesktopAgentView; dialogControl?: DesktopDialogControl }) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    const { register, requestClose } = useDesktopPanelCloseGuard()
    return <Dialog open={open} onOpenChange={next => {
        if (next) setOpen(true)
        else requestClose(() => setOpen(false))
    }} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Memories</Button></DialogTrigger>
        {open && <DesktopCoworkerMemoriesBody key={agent.id} agent={agent} registerCloseGuard={register} inDialog />}
    </Dialog>
}
