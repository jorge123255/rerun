'use client'

import type { MessageFeedbackRating } from '@rerun/contracts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

type Chat = { workspaceId: string; chatId: string }
type Vote = { id: string; rating: MessageFeedbackRating }
const NO_VOTES: ReadonlyMap<string, Vote> = new Map()
const SAVE_FAILED = 'Could not save your feedback'
const writes = new Map<string, Promise<void>>()

function feedbackUrl(chat: Chat, id?: string) {
    const query = new URLSearchParams({ workspaceId: chat.workspaceId, chatId: chat.chatId, ...(id && { id }) })
    return `/api/desktop/foreman/feedback?${query.toString()}`
}

function serialize(key: string, work: () => Promise<void>): Promise<void> {
    const result = (writes.get(key) ?? Promise.resolve()).then(work)
    const settled = result.then(() => {}, () => {})
    writes.set(key, settled)
    void settled.then(() => { if (writes.get(key) === settled) writes.delete(key) })
    return result
}

async function readVotes(chat: Chat, signal?: AbortSignal): Promise<ReadonlyMap<string, Vote>> {
    const response = await fetch(feedbackUrl(chat), { cache: 'no-store', signal })
    if (!response.ok) throw new Error(SAVE_FAILED)
    const body = await response.json()
    if (!Array.isArray(body?.votes)) throw new Error(SAVE_FAILED)
    const votes = new Map<string, Vote>()
    for (const row of body.votes) {
        if (row && typeof row.id === 'string' && typeof row.messageId === 'string' && (row.rating === 'up' || row.rating === 'down')) {
            votes.set(row.messageId, { id: row.id, rating: row.rating })
        }
    }
    return votes
}

/** Local Foreman answer feedback. Saved votes come back through the exact chat identity; a
 * deleted or no-longer-saved reply is never attached to a fresh row. */
export function useDesktopForemanFeedback(chat: Chat | null, active = true) {
    const target = useMemo(() => chat ? { workspaceId: chat.workspaceId, chatId: chat.chatId } : null, [chat?.workspaceId, chat?.chatId])
    const key = target ? JSON.stringify([target.workspaceId, target.chatId]) : null
    const currentKey = useRef(key)
    currentKey.current = key
    const busy = useRef(new Set<string>())
    const [votes, setVotes] = useState<ReadonlyMap<string, Vote>>(NO_VOTES)
    const votesRef = useRef(votes)
    votesRef.current = votes
    const revision = useRef(0)
    const changes = useRef(new Map<string, number>())

    useEffect(() => {
        if (!target || !active || !key) return
        const controller = new AbortController()
        const before = revision.current
        void (async () => {
            try {
                const rows = await readVotes(target, controller.signal)
                if (controller.signal.aborted || currentKey.current !== key) return
                setVotes(current => {
                    const next = new Map(current)
                    for (const messageId of new Set([...next.keys(), ...rows.keys()])) {
                        if ((changes.current.get(messageId) ?? 0) > before) continue
                        const row = rows.get(messageId)
                        if (row) next.set(messageId, row)
                        else next.delete(messageId)
                    }
                    return next
                })
            } catch { /* Keep the last visible vote until this chat is reopened. */ }
        })()
        return () => controller.abort()
    }, [active, key, target])

    useEffect(() => {
        if (!key) setVotes(NO_VOTES)
    }, [key])

    const rate = useCallback((messageId: string, rating: MessageFeedbackRating) => {
        if (!target || !active || !key || busy.current.has(messageId)) return
        const previous = votesRef.current.get(messageId)
        busy.current.add(messageId)
        const remove = previous?.rating === rating
        const stamp = ++revision.current
        changes.current.set(messageId, stamp)
        setVotes(current => {
            const next = new Map(current)
            if (remove) next.delete(messageId)
            else next.set(messageId, previous ? { ...previous, rating } : { id: `pending:${messageId}`, rating })
            return next
        })
        void serialize(key + '\0' + messageId, async () => {
            try {
                if (remove) {
                    if (previous?.id && !previous.id.startsWith('pending:')) {
                        const response = await fetch(feedbackUrl(target, previous.id), { method: 'DELETE' })
                        if (!response.ok) throw new Error('Could not remove your feedback')
                    }
                    return
                }
                const response = await fetch(feedbackUrl(target), {
                    method: 'PUT', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ workspaceId: target.workspaceId, chatId: target.chatId, messageId, rating }),
                })
                if (!response.ok) throw new Error(SAVE_FAILED)
                const vote = await response.json()
                if (typeof vote?.id !== 'string' || vote.messageId !== messageId || vote.rating !== rating) throw new Error(SAVE_FAILED)
                if (currentKey.current === key) setVotes(current => new Map(current).set(messageId, { id: vote.id, rating }))
            } catch {
                // Reconcile against the authority before the next click chooses an id to undo.
                let rows: ReadonlyMap<string, Vote> | null = null
                try { rows = await readVotes(target) } catch { /* Keep the last visible vote below. */ }
                if (currentKey.current !== key || changes.current.get(messageId) !== stamp) return
                setVotes(current => {
                    const next = new Map(current)
                    if (rows) {
                        const row = rows.get(messageId)
                        if (row) next.set(messageId, row)
                        else next.delete(messageId)
                    } else if (previous) next.set(messageId, previous)
                    else next.delete(messageId)
                    return next
                })
                toast.error(remove ? 'Could not remove your feedback' : SAVE_FAILED)
            } finally { busy.current.delete(messageId) }
        })
    }, [active, key, target])

    const ratingOf = useCallback((messageId: string): MessageFeedbackRating | null => votes.get(messageId)?.rating ?? null, [votes])
    return { votes, ratingOf, rate }
}
