'use client'

import { useEffect, useState } from 'react'
import { MemoryRow } from '@/components/agent/MemoryRow'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelList } from '@/components/ui/panel-list'
import { BrainIcon } from '@/lib/icons'
import { createDesktopSemanticMemoryClient, DesktopSemanticMemoryClientError } from '@/lib/desktop/semantic-memory-client'
import type { DesktopSemanticIndexStatus } from '@rerun/contracts'
import { reduceSemanticMemoryPanel, semanticMemoryPanelState, semanticMemoryStatusCopy } from './state'

// Root mounts this under the existing Memories search. It does not add, edit, clear, or strengthen notes.
export function DesktopSemanticMemoryRecall({ ownerId, query, includeDormant = false }: { ownerId: string; query: string; includeDormant?: boolean }) {
    const [state, setState] = useState(() => semanticMemoryPanelState(ownerId))
    const [attempt, setAttempt] = useState(0)
    const [indexStatus, setIndexStatus] = useState<DesktopSemanticIndexStatus | null>(null)
    const [indexError, setIndexError] = useState('')
    const trimmed = query.trim()

    useEffect(() => {
        const ticket = attempt + 1
        const client = createDesktopSemanticMemoryClient(ownerId)
        setState(current => {
            const owned = reduceSemanticMemoryPanel(current, { type: 'owner', ownerId, ticket })
            const queried = reduceSemanticMemoryPanel(owned, { type: 'query', query: trimmed, ticket })
            return trimmed ? reduceSemanticMemoryPanel(queried, { type: 'start', ticket, ownerId, query: trimmed }) : queried
        })
        if (!trimmed) return () => client.dispose()
        void client.recall(trimmed, includeDormant).then(result => {
            setState(current => reduceSemanticMemoryPanel(current, { type: 'success', ticket, ownerId, query: trimmed, result }))
        }).catch(error => {
            if (error instanceof DesktopSemanticMemoryClientError && error.message === 'Semantic recall was cancelled.') return
            const message = error instanceof Error && error.name !== 'TypeError' ? error.message : 'Could not search memories. Try again.'
            setState(current => reduceSemanticMemoryPanel(current, { type: 'failure', ticket, ownerId, query: trimmed, error: message }))
        })
        return () => client.dispose()
    }, [ownerId, trimmed, includeDormant, attempt])

    if (!trimmed) return null
    const searching = state.phase === 'loading' || state.query !== trimmed || state.ownerId !== ownerId
    const result = !searching && state.phase === 'ready' ? state.result : null
    const retrySearch = state.phase === 'error' || (result?.mode === 'keyword-only' && result.index.backend !== null)
    const showIndexRetry = result?.index.backend && (result.index.mode === 'partial' || result.index.mode === 'rebuilding' || result.index.mode === 'invalid')

    async function retryIndex() {
        setIndexError('')
        const client = createDesktopSemanticMemoryClient(ownerId)
        try { setIndexStatus(await client.retryIndex()) }
        catch (error) {
            if (error instanceof DesktopSemanticMemoryClientError && error.message === 'Semantic recall was cancelled.') return
            setIndexError(error instanceof Error ? error.message : 'Could not retry semantic indexing.')
        } finally { client.dispose() }
    }

    return <div className="space-y-2">
        <p role="status" className="text-sm text-muted-foreground">{semanticMemoryStatusCopy(searching, trimmed, result?.memories.length ?? 0)}</p>
        {result && <p className="text-sm text-muted-foreground">{indexStatus?.detail ?? result.detail}</p>}
        {state.phase === 'error' && state.query === trimmed && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
        {indexError && <p role="alert" className="text-sm text-destructive">{indexError}</p>}
        <div className="flex flex-wrap gap-2">
            {retrySearch && <Button type="button" size="sm" variant="outline" onClick={() => setAttempt(current => current + 1)}>Retry</Button>}
            {showIndexRetry && <Button type="button" size="sm" variant="outline" onClick={() => void retryIndex()}>Retry indexing</Button>}
        </div>
        {result && (result.memories.length ? <PanelList>{result.memories.map(memory => <MemoryRow key={memory.id} memory={memory} />)}</PanelList>
            : <EmptyState icon={BrainIcon} title="No matches" description="Try another keyword or clear the search to see all saved notes." />)}
    </div>
}
