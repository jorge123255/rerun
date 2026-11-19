'use client'

import { foremanChatRefSchema, isPinnable, nextPinnedIds, RELEASE_DELAY_MS, settledPinnedIds, skillProposalSchema, type DesktopForemanChatRef } from '@rerun/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'

export const foremanSkillsPath = '/api/desktop/foreman/skills'
export const foremanSkillSummary = z.object({ slug: z.string(), name: z.string(), description: z.string() })
const listing = z.object({ chat: foremanChatRefSchema, skills: foremanSkillSummary.array(), proposals: skillProposalSchema.extend({ revision: z.string().regex(/^[0-9a-f]{64}$/) }).array() })
const decisionReceipt = z.object({ chat: foremanChatRefSchema, proposal: skillProposalSchema })

// ConnectedForeman is keyed by workspace and saved chat. A refreshed snapshot or an old decision
// must never attach cards to another session, including during shutdown or while the chat is hidden.
export function useDesktopForemanSkills(chat: DesktopForemanChatRef, sessionId: string | undefined, active: boolean, turnKey: string) {
    const [snapshot, setSnapshot] = useState<z.infer<typeof listing> | null>(null)
    const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => new Set())
    const [unavailable, setUnavailable] = useState(false)
    const [decisionFailed, setDecisionFailed] = useState(false)
    const [pendingId, setPendingId] = useState<string | null>(null)
    const readEpoch = useRef(0)
    const pending = useRef<AbortController | null>(null)
    const [revision, setRevision] = useState(0)
    const refresh = useCallback(() => setRevision(value => value + 1), [])
    const { chatId, workspaceId } = chat
    useEffect(() => {
        setSnapshot(null)
        setPinnedIds(new Set())
        setPendingId(null)
        setDecisionFailed(false)
        return () => { pending.current?.abort(); pending.current = null }
    }, [chatId, workspaceId, sessionId, active])

    useEffect(() => {
        if (!active || !sessionId || isDesktopQuitting()) return
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout>
        const read = async () => {
            if (controller.signal.aborted || isDesktopQuitting()) return
            const epoch = readEpoch.current
            let writing = false
            try {
                const response = await fetch(foremanSkillsPath + '?' + new URLSearchParams({ workspaceId, chatId }), { cache: 'no-store', signal: controller.signal })
                if (!response.ok) throw Error()
                const result = listing.parse(await response.json())
                if (result.chat.chatId !== chatId || result.chat.workspaceId !== workspaceId || result.proposals.some(row => row.sessionId !== sessionId)) throw Error()
                if (controller.signal.aborted || isDesktopQuitting()) return
                if (pending.current || epoch !== readEpoch.current) return
                writing = result.proposals.some(row => row.status === 'accepted')
                setSnapshot(result)
                setPinnedIds(ids => nextPinnedIds(ids, result.proposals))
                setUnavailable(false)
            } catch {
                if (controller.signal.aborted || isDesktopQuitting()) return
                if (pending.current || epoch !== readEpoch.current) return
                setSnapshot(null)
                setUnavailable(true)
            }
            timer = setTimeout(read, writing ? 1000 : 10000)
        }
        void read()
        return () => { controller.abort(); clearTimeout(timer) }
    }, [chatId, workspaceId, sessionId, active, revision, turnKey])

    useEffect(() => {
        if (!snapshot) return
        const settled = settledPinnedIds(pinnedIds, snapshot.proposals)
        if (!settled.length) return
        const timer = setTimeout(() => setPinnedIds(ids => {
            const next = new Set(ids)
            settled.forEach(id => next.delete(id))
            return next
        }), RELEASE_DELAY_MS)
        return () => clearTimeout(timer)
    }, [snapshot, pinnedIds])

    async function decide(id: string, decision: 'accept' | 'dismiss') {
        const row = snapshot?.proposals.find(proposal => proposal.id === id)
        if (!active || isDesktopQuitting() || pending.current || !row || !isPinnable(row.status) || row.sessionId !== sessionId) return
        const controller = new AbortController()
        readEpoch.current++
        pending.current = controller
        setPendingId(id)
        setDecisionFailed(false)
        try {
            const response = await fetch(foremanSkillsPath, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat: { workspaceId, chatId }, proposalId: id, decision, revision: row.revision }), signal: controller.signal })
            if (!response.ok) throw Error()
            const receipt = decisionReceipt.parse(await response.json())
            if (receipt.chat.chatId !== chatId || receipt.chat.workspaceId !== workspaceId || receipt.proposal.id !== id || receipt.proposal.sessionId !== sessionId) throw Error()
        } catch {
            if (!controller.signal.aborted && !isDesktopQuitting()) setDecisionFailed(true)
        } finally {
            if (pending.current === controller && !controller.signal.aborted && !isDesktopQuitting()) {
                pending.current = null
                setSnapshot(null)
                setPendingId(null)
                refresh()
            }
        }
    }
    return { snapshot: active ? snapshot : null, pinnedIds, unavailable, decisionFailed, pendingId, decide, refresh }
}
export type ChiefSkills = ReturnType<typeof useDesktopForemanSkills>
