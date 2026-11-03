'use client'

import type { MessageFeedbackDetails } from '@/components/chat/MessageFeedbackDialog'
import type { MessageFeedbackRating } from '@rerun/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

type SavedVote = { rating: MessageFeedbackRating; id: string }
type Vote = { rating: MessageFeedbackRating; feedbackId: Promise<string | null> }
type FeedbackDialog = Vote & { open: boolean; agentId: string; sessionId: string; messageId: string }

const SAVE_FAILED = 'Could not save your feedback'
const NO_VOTES: ReadonlyMap<string, Vote> = new Map()

function feedbackUrl(sessionId: string, agentId?: string) {
    const path = `/api/desktop/sessions/${encodeURIComponent(sessionId)}/feedback`
    return agentId ? `${path}?agentId=${encodeURIComponent(agentId)}` : path
}

// A tab can close and remount while a write is pending. Keep only the pending work in this
// page-wide queue, independently for each coworker, chat and assistant message.
const writes = new Map<string, Promise<void>>()
function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (writes.get(key) ?? Promise.resolve()).then(work)
    const settled = result.then(() => {}, () => {})
    writes.set(key, settled)
    void settled.then(() => { if (writes.get(key) === settled) writes.delete(key) })
    return result
}

async function readVotes(sessionId: string, agentId: string, signal?: AbortSignal) {
    const response = await fetch(feedbackUrl(sessionId, agentId), { cache: 'no-store', signal })
    if (!response.ok) throw new Error(SAVE_FAILED)
    const { votes } = await response.json()
    if (!Array.isArray(votes)) throw new Error(SAVE_FAILED)
    const rows = new Map<string, SavedVote>()
    for (const row of votes) {
        if (row && typeof row.id === 'string' && typeof row.messageId === 'string' && (row.rating === 'up' || row.rating === 'down')) {
            rows.set(row.messageId, { id: row.id, rating: row.rating })
        }
    }
    return rows
}

function viewOf(vote: SavedVote): Vote { return { rating: vote.rating, feedbackId: Promise.resolve(vote.id) } }

export function useDesktopReplyFeedback(agentId: string, sessionId: string | null, active = true) {
    const key = sessionId ? `${agentId}:${sessionId}` : null
    const [stored, setStored] = useState<ReadonlyMap<string, ReadonlyMap<string, Vote>>>(new Map())
    const state = useRef(stored)
    const confirmed = useRef(new Map<string, SavedVote>())
    const changes = useRef(new Map<string, number>())
    const revision = useRef(0)
    const [dialog, setDialog] = useState<FeedbackDialog | null>(null)

    const updateSession = useCallback((sessionKey: string, votes: ReadonlyMap<string, Vote>) => {
        // Update before returning from the click, even when React batches consecutive clicks.
        state.current = new Map(state.current).set(sessionKey, votes)
        setStored(state.current)
    }, [])

    const showVote = useCallback((sessionKey: string, messageId: string, vote?: Vote) => {
        const next = new Map(state.current.get(sessionKey))
        if (vote) next.set(messageId, vote)
        else next.delete(messageId)
        updateSession(sessionKey, next)
    }, [updateSession])

    useEffect(() => {
        if (!key || !sessionId || !active) return
        const controller = new AbortController()
        const prefix = key + '\0'
        const before = revision.current
        void (async () => {
            try {
                await Promise.all([...writes].filter(([id]) => id.startsWith(prefix)).map(([, done]) => done))
                if (controller.signal.aborted) return
                const rows = await readVotes(sessionId, agentId, controller.signal)
                if (controller.signal.aborted) return
                const next = new Map(state.current.get(key))
                for (const messageId of new Set([...next.keys(), ...rows.keys()])) {
                    const id = prefix + messageId
                    if ((changes.current.get(id) ?? 0) > before || writes.has(id)) continue
                    const row = rows.get(messageId)
                    if (row) { confirmed.current.set(id, row); next.set(messageId, viewOf(row)) }
                    else { confirmed.current.delete(id); next.delete(messageId) }
                }
                updateSession(key, next)
            } catch { /* Keep existing votes until this chat is reopened. */ }
        })()
        return () => controller.abort()
    }, [agentId, key, sessionId, active, updateSession])

    if (dialog?.open && (!active || dialog.sessionId !== sessionId || dialog.agentId !== agentId)) {
        setDialog({ ...dialog, open: false })
    }

    const rate = useCallback((messageId: string, rating: MessageFeedbackRating) => {
        if (!key || !sessionId || !active) return
        const id = key + '\0' + messageId
        const remove = state.current.get(key)?.get(messageId)?.rating === rating
        const version = ++revision.current
        changes.current.set(id, version)
        const feedbackId: Promise<string | null> = serialize(id, async (): Promise<string | null> => {
            try {
                if (remove) {
                    const vote = confirmed.current.get(id)
                    if (vote) {
                        const response = await fetch(`${feedbackUrl(sessionId, agentId)}&id=${encodeURIComponent(vote.id)}`, { method: 'DELETE' })
                        if (!response.ok) throw new Error('Could not remove your feedback')
                    }
                    confirmed.current.delete(id)
                    return null
                }
                const response = await fetch(feedbackUrl(sessionId), {
                    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId, messageId, rating }),
                })
                if (!response.ok) throw new Error(SAVE_FAILED)
                const vote = await response.json()
                if (typeof vote.id !== 'string' || vote.rating !== rating || vote.messageId !== messageId) throw new Error(SAVE_FAILED)
                confirmed.current.set(id, { id: vote.id, rating })
                return vote.id as string
            } catch {
                // The response can be lost after a committed write. Read back the actual row
                // before the next queued click chooses a vote ID to undo or annotate.
                let reconciled = false
                try {
                    const saved = (await readVotes(sessionId, agentId)).get(messageId)
                    if (saved) confirmed.current.set(id, saved)
                    else confirmed.current.delete(id)
                    reconciled = true
                } catch { /* Keep the last acknowledged vote if the read also failed. */ }
                const saved = confirmed.current.get(id)
                if (reconciled && (remove ? !saved : saved?.rating === rating)) return saved?.id ?? null
                if (changes.current.get(id) === version) {
                    showVote(key, messageId, saved && viewOf(saved))
                    setDialog(current => current?.feedbackId === feedbackId ? { ...current, open: false } : current)
                    toast.error(remove ? 'Could not remove your feedback' : SAVE_FAILED)
                }
                return null
            }
        })
        if (remove) {
            showVote(key, messageId)
            setDialog(current => current?.messageId === messageId && current.sessionId === sessionId ? { ...current, open: false } : current)
        } else {
            const vote = { rating, feedbackId }
            showVote(key, messageId, vote)
            setDialog({ ...vote, agentId, sessionId, messageId, open: true })
        }
    }, [active, agentId, key, sessionId, showVote])

    const submitDetails = useCallback(async ({ category, details }: MessageFeedbackDetails): Promise<boolean> => {
        if (!dialog || !dialog.open || !active || dialog.agentId !== agentId || dialog.sessionId !== sessionId) return false
        return serialize(`${dialog.agentId}:${dialog.sessionId}\0${dialog.messageId}`, async () => {
            const id = await dialog.feedbackId
            if (!id) return false
            try {
                const response = await fetch(feedbackUrl(dialog.sessionId), {
                    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: dialog.agentId, id, category, details }),
                })
                if (!response.ok) throw new Error(SAVE_FAILED)
                toast.success('Thanks for your feedback')
                return true
            } catch { toast.error(SAVE_FAILED); return false }
        })
    }, [active, agentId, dialog, sessionId])

    const currentId = dialog?.feedbackId
    const onDialogOpenChange = useCallback((open: boolean) => {
        if (!open) setDialog(current => current && current.feedbackId === currentId ? { ...current, open: false } : current)
    }, [currentId])

    return {
        votes: (key && stored.get(key)) || NO_VOTES, rate, submitDetails, onDialogOpenChange,
        dialogOpen: !!(active && dialog?.open && dialog.agentId === agentId && dialog.sessionId === sessionId), dialogRating: dialog?.rating ?? 'up',
    }
}
