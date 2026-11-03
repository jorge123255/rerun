'use client'

import type { MessageFeedbackDetails } from '@/components/chat/MessageFeedbackDialog'
import type { MessageFeedbackRating } from '@rerun/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

type Vote = { rating: MessageFeedbackRating; feedbackId: Promise<string | null> }
type FeedbackDialog = { open: boolean; rating: MessageFeedbackRating; feedbackId: Promise<string | null>; agentId: string; sessionId: string }

const SAVE_FAILED = 'Could not save your feedback'
const NO_VOTES: ReadonlyMap<string, Vote> = new Map()

function feedbackUrl(sessionId: string) {
    return `/api/desktop/sessions/${encodeURIComponent(sessionId)}/feedback`
}

async function readJson(response: Response): Promise<{ id?: unknown; votes?: unknown; error?: unknown } | null> {
    return response.json().catch(() => null)
}

export function useDesktopReplyFeedback(agentId: string, sessionId: string | null, active = true) {
    const key = sessionId ? `${agentId}:${sessionId}` : null
    const [stored, setStored] = useState<ReadonlyMap<string, ReadonlyMap<string, Vote>>>(() => new Map())
    const [dialog, setDialog] = useState<FeedbackDialog | null>(null)
    const votes = key ? stored.get(key) ?? NO_VOTES : NO_VOTES
    const storedRef = useRef(stored)
    const touched = useRef(new Set<string>())
    useEffect(() => { storedRef.current = stored })

    const updateSession = useCallback((sessionKey: string, update: (current: ReadonlyMap<string, Vote>) => ReadonlyMap<string, Vote>) => {
        setStored(current => {
            const next = new Map(current)
            next.set(sessionKey, update(current.get(sessionKey) ?? NO_VOTES))
            return next
        })
    }, [])

    useEffect(() => {
        if (!key || !sessionId) return
        const sessionKey = key
        const controller = new AbortController()
        void (async () => {
            try {
                const response = await fetch(`${feedbackUrl(sessionId)}?agentId=${encodeURIComponent(agentId)}`, { signal: controller.signal })
                const body = await readJson(response)
                if (!response.ok || !Array.isArray(body?.votes) || controller.signal.aborted) return
                const rows = body.votes.flatMap(vote => {
                    if (!vote || typeof vote !== 'object') return []
                    const row = vote as { id?: unknown; messageId?: unknown; rating?: unknown }
                    if (typeof row.id !== 'string' || typeof row.messageId !== 'string' || (row.rating !== 'up' && row.rating !== 'down')) return []
                    if (touched.current.has(`${sessionKey}\0${row.messageId}`)) return []
                    return [[row.messageId, { rating: row.rating, feedbackId: Promise.resolve<string | null>(row.id) }] as const]
                })
                updateSession(sessionKey, current => new Map([...rows, ...current]))
            } catch {
                // A missed read leaves the votes already on screen. The next open tries again.
            }
        })()
        return () => controller.abort()
    }, [agentId, key, sessionId, updateSession])

    useEffect(() => {
        if (!active) setDialog(current => current?.open ? { ...current, open: false } : current)
    }, [active])

    const rate = useCallback((messageId: string, rating: MessageFeedbackRating) => {
        if (!key || !sessionId) return
        const sessionKey = key
        const touch = `${sessionKey}\0${messageId}`
        touched.current.add(touch)
        const previous = storedRef.current.get(sessionKey)?.get(messageId)

        if (previous?.rating === rating) {
            updateSession(sessionKey, current => {
                const next = new Map(current)
                next.delete(messageId)
                return next
            })
            void previous.feedbackId.then(async id => {
                if (!id) return { ok: true as const }
                const response = await fetch(`${feedbackUrl(sessionId)}?agentId=${encodeURIComponent(agentId)}&id=${encodeURIComponent(id)}`, { method: 'DELETE' })
                if (!response.ok) throw new Error('remove failed')
                return { ok: true as const }
            }).catch(() => {
                updateSession(sessionKey, current => {
                    if (current.has(messageId)) return current
                    const next = new Map(current)
                    next.set(messageId, previous)
                    return next
                })
                toast.error('Could not remove your feedback')
            })
            return
        }

        const feedbackId = fetch(feedbackUrl(sessionId), {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ agentId, messageId, rating }),
        }).then(async response => {
            const body = await readJson(response)
            return response.ok && typeof body?.id === 'string' ? body.id : null
        }).catch(() => null)
        updateSession(sessionKey, current => new Map(current).set(messageId, { rating, feedbackId }))
        setDialog({ open: true, rating, feedbackId, agentId, sessionId })
        void feedbackId.then(id => {
            if (id) return
            updateSession(sessionKey, current => {
                if (current.get(messageId)?.feedbackId !== feedbackId) return current
                const next = new Map(current)
                if (previous) next.set(messageId, previous)
                else next.delete(messageId)
                return next
            })
            setDialog(current => current?.feedbackId === feedbackId ? { ...current, open: false } : current)
            toast.error(SAVE_FAILED)
        })
    }, [agentId, key, sessionId, updateSession])

    const submitDetails = useCallback(async ({ category, details }: MessageFeedbackDetails): Promise<boolean> => {
        const current = dialog
        const id = await current?.feedbackId
        if (!current || !id) return false
        try {
            const response = await fetch(feedbackUrl(current.sessionId), {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ agentId: current.agentId, id, category, details }),
            })
            if (!response.ok) throw new Error('details failed')
        } catch {
            toast.error(SAVE_FAILED)
            return false
        }
        toast.success('Thanks for your feedback')
        return true
    }, [dialog])

    const onDialogOpenChange = useCallback((open: boolean) => {
        if (!open) setDialog(current => current ? { ...current, open: false } : current)
    }, [])

    return { votes, rate, dialogOpen: dialog?.open ?? false, dialogRating: dialog?.rating ?? 'up', submitDetails, onDialogOpenChange }
}
