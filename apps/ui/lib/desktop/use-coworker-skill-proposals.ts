'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { isPinnable, RELEASE_DELAY_MS } from '@rerun/contracts'
import { decideCoworkerSkillProposal, listCoworkerSkillProposals, DESKTOP_SKILL_PROPOSALS_CHANGED } from './coworker-skills'
import { applyProposalSnapshot } from './skill-proposal-snapshot'
import { isDesktopQuitting, subscribeDraftShutdown } from './draft-writes'
import type { EngineSkillProposal } from '@/lib/engine/types'

const POLL_QUICK_MS = 1500, POLL_RELAXED_MS = 10_000, POLL_QUICK_WINDOW_MS = 60_000
const empty = () => ({ proposals: new Map<string, EngineSkillProposal>(), pinnedIds: new Set<string>() })
type Scope = { key: string }
type Loaded = ReturnType<typeof empty> & { scope: Scope }

/** Panel-wide review or exact local-chat review. Hidden chats never poll or admit decisions. */
export function useCoworkerSkillProposals(agentId: string, options: { sessionId?: string; active?: boolean; mode?: 'panel' | 'chat' } = {}) {
    const { sessionId, active = true, mode = 'panel' } = options
    const key = JSON.stringify([agentId, sessionId ?? null, active, mode])
    const scopeRef = useRef<Scope>({ key })
    if (scopeRef.current.key !== key) scopeRef.current = { key }
    const scope = scopeRef.current
    const mounted = useRef(false), readEpoch = useRef(0)
    const pending = useRef<{ scope: Scope; id: string } | null>(null)
    const [loaded, setLoaded] = useState<Loaded>(() => ({ scope, ...empty() }))
    const loadedRef = useRef(loaded)
    const [pendingId, setPendingId] = useState<string | null>(null)
    const [unavailable, setUnavailable] = useState(false)
    const live = useCallback(() => mounted.current && scopeRef.current === scope && active && !!agentId && !isDesktopQuitting(), [scope, active, agentId])
    const publish = useCallback((rows: EngineSkillProposal[]) => {
        if (!live()) return
        const previous = loadedRef.current.scope === scope ? loadedRef.current : { scope, ...empty() }
        const proposals = new Map(rows.map(row => [row.id, row]))
        const pinnedIds = new Set<string>()
        for (const row of rows) {
            if (isPinnable(row.status) || (previous.pinnedIds.has(row.id) && !(mode === 'chat' && row.status === 'accepted'))) pinnedIds.add(row.id)
        }
        const next = { scope, proposals, pinnedIds }
        loadedRef.current = next; setLoaded(next)
    }, [live, mode, scope])
    const refresh = useCallback(async (signal?: AbortSignal) => {
        if (!live() || pending.current?.scope === scope) return
        const epoch = ++readEpoch.current
        const snapshot = await listCoworkerSkillProposals(agentId, { sessionId, signal })
        if (!live() || signal?.aborted || epoch !== readEpoch.current || pending.current?.scope === scope) return
        setUnavailable(!snapshot || snapshot.availability !== 'complete')
        const previous = loadedRef.current.scope === scope ? [...loadedRef.current.proposals.values()] : []
        const next = applyProposalSnapshot(previous, snapshot)
        if (next) publish(next)
    }, [agentId, sessionId, live, publish, scope])

    useEffect(() => {
        mounted.current = true
        loadedRef.current = { scope, ...empty() }; setLoaded(loadedRef.current)
        pending.current = null; setPendingId(null); setUnavailable(false); readEpoch.current++
        const quitting = subscribeDraftShutdown(() => { readEpoch.current++; pending.current = null; setPendingId(null) })
        return () => { mounted.current = false; readEpoch.current++; quitting() }
    }, [scope])

    const proposals = loaded.scope === scope ? loaded.proposals : new Map<string, EngineSkillProposal>()
    const pinnedIds = loaded.scope === scope ? loaded.pinnedIds : new Set<string>()
    const writing = [...proposals.values()].some(row => row.status === 'accepted')
    useEffect(() => {
        if (!active || !agentId) return
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        const started = Date.now()
        const tick = async () => {
            await refresh(controller.signal)
            if (controller.signal.aborted || !live()) return
            timer = setTimeout(tick, writing && Date.now() - started < POLL_QUICK_WINDOW_MS ? POLL_QUICK_MS : POLL_RELAXED_MS)
        }
        void tick()
        return () => { controller.abort(); clearTimeout(timer) }
    }, [active, agentId, refresh, live, writing])

    useEffect(() => {
        const changed = (event: Event) => {
            if ((event as CustomEvent<{ agentId?: string }>).detail?.agentId !== agentId || !live()) return
            readEpoch.current++
            if (pending.current?.scope !== scope) void refresh()
        }
        window.addEventListener(DESKTOP_SKILL_PROPOSALS_CHANGED, changed)
        return () => window.removeEventListener(DESKTOP_SKILL_PROPOSALS_CHANGED, changed)
    }, [agentId, live, refresh, scope])

    useEffect(() => {
        if (!live()) return
        const settled = [...pinnedIds].filter(id => {
            const row = proposals.get(id)
            return row?.status === 'applied' || row?.status === 'dismissed'
        })
        if (!settled.length) return
        const timer = setTimeout(() => {
            if (!live()) return
            const current = loadedRef.current
            if (current.scope !== scope) return
            const next = new Set(current.pinnedIds)
            for (const id of settled) if (!isPinnable(current.proposals.get(id)?.status ?? 'proposed')) next.delete(id)
            loadedRef.current = { ...current, pinnedIds: next }; setLoaded(loadedRef.current)
        }, RELEASE_DELAY_MS)
        return () => clearTimeout(timer)
    }, [pinnedIds, proposals, live, scope])

    const decide = useCallback(async (proposalId: string, decision: 'accept' | 'dismiss') => {
        if (!live() || pending.current?.scope === scope) return
        const row = loadedRef.current.scope === scope ? loadedRef.current.proposals.get(proposalId) : undefined
        if (!row || !isPinnable(row.status)) return
        const operation = { scope, id: proposalId }
        pending.current = operation; setPendingId(proposalId); readEpoch.current++
        try {
            const result = await decideCoworkerSkillProposal(agentId, proposalId, decision, sessionId)
            if (!live() || pending.current !== operation) return
            readEpoch.current++
            if (result.error) toast.error(result.error)
            // The API returns the exact scoped row; a substituted session is never rendered.
            if (result.proposal && result.proposal.id === row.id && result.proposal.sessionId === row.sessionId) {
                const next = new Map(loadedRef.current.proposals).set(row.id, result.proposal)
                publish([...next.values()])
            }
        } finally {
            if (live() && pending.current === operation) { pending.current = null; setPendingId(null); void refresh() }
        }
    }, [agentId, sessionId, live, scope, publish, refresh])

    const pinned = useMemo(() => [...proposals.values()].filter(row => pinnedIds.has(row.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [proposals, pinnedIds])
    return { proposals, pinned, pinnedIds, decide, pendingId: loaded.scope === scope ? pendingId : null, refresh, unavailable }
}
