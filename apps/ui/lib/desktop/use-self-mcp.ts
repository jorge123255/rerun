'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { SelfMcpDecisionRequest, SelfMcpDecisionResult, SelfMcpProposal, SelfMcpReviewSnapshot } from '@rerun/contracts'
import { createDesktopSelfMcpClient } from './self-mcp-client'

const POLL_QUICK_MS = 2000
const POLL_RELAXED_MS = 10_000

type Scope = { key: string }

/**
 * Panel-wide review state for a coworker's self-MCP proposals. Polls the list
 * (quick while a decision is in flight, relaxed otherwise), and serializes
 * human decisions: only one decide/dismiss runs at a time, and a mounted
 * panel whose owner changed stops issuing work. The server stays the source of
 * truth — every result is revalidated by the next poll.
 */
export function useSelfMcp(agentId: string, options: { active?: boolean } = {}) {
    const { active = true } = options
    const key = JSON.stringify([agentId, active])
    const scopeRef = useRef<Scope>({ key })
    if (scopeRef.current.key !== key) scopeRef.current = { key }
    const scope = scopeRef.current

    const clientRef = useRef<ReturnType<typeof createDesktopSelfMcpClient> | null>(null)
    if (!clientRef.current) clientRef.current = createDesktopSelfMcpClient(agentId)

    const mounted = useRef(false)
    const epoch = useRef(0)
    const pending = useRef(false)
    const [proposals, setProposals] = useState<SelfMcpProposal[]>([])
    const [unavailable, setUnavailable] = useState(false)
    const [pendingId, setPendingId] = useState<string | null>(null)

    const live = useCallback(() => mounted.current && scopeRef.current === scope && active, [scope, active])

    const refresh = useCallback(async () => {
        const client = clientRef.current
        if (!live() || pending.current || !client) return
        const myEpoch = ++epoch.current
        try {
            const result = await client.list()
            if (!live() || myEpoch !== epoch.current || pending.current) return
            setProposals(result.proposals)
            setUnavailable(false)
        } catch {
            if (live() && myEpoch === epoch.current) setUnavailable(true)
        }
    }, [live])

    const review = useCallback(async (proposalId: string): Promise<SelfMcpReviewSnapshot | null> => {
        const client = clientRef.current
        if (!live() || !client) return null
        try {
            return await client.review(proposalId)
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Review unavailable; refresh the list.')
            return null
        }
    }, [live])

    useEffect(() => {
        mounted.current = true
        epoch.current++
        setProposals([])
        setUnavailable(false)
        setPendingId(null)
        return () => {
            mounted.current = false
            epoch.current++
            pending.current = false
            clientRef.current?.dispose()
            clientRef.current = null
        }
    }, [scope])

    useEffect(() => {
        if (!active || !clientRef.current) return
        let timer: ReturnType<typeof setTimeout> | undefined
        const tick = async () => {
            await refresh()
            if (!live()) return
            timer = setTimeout(tick, pending.current ? POLL_QUICK_MS : POLL_RELAXED_MS)
        }
        void tick()
        return () => {
            if (timer) clearTimeout(timer)
        }
    }, [active, refresh, live])

    const settle = useCallback(async (operation: () => Promise<SelfMcpDecisionResult>, proposalId: string): Promise<SelfMcpDecisionResult | null> => {
        if (!live() || pending.current) return null
        pending.current = true
        setPendingId(proposalId)
        epoch.current++
        try {
            const result = await operation()
            if (result.outcome === 'in_flight') {
                toast.info('Another review is being processed; refresh to see its result.')
            }
            return result
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Review failed; refresh and try again.')
            return null
        } finally {
            pending.current = false
            setPendingId(null)
            epoch.current++
            void refresh()
        }
    }, [live, refresh])

    const decide = useCallback((decision: SelfMcpDecisionRequest) => settle(() => clientRef.current!.decide(decision), decision.proposalId), [settle])
    const dismiss = useCallback((proposalId: string, expectedProposalRevision: number) => settle(() => clientRef.current!.dismiss(proposalId, expectedProposalRevision), proposalId), [settle])

    return { proposals, pendingId, unavailable, refresh, review, decide, dismiss }
}
