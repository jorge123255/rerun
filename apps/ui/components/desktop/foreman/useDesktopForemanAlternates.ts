'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { createForemanAlternateClient, type ForemanAlternateListEntry, type ForemanAlternateView } from '@/lib/desktop/foreman-client/alternates'

type Review = { messageId: string; snapshot: string; requestId: string }
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Could not load the Chief of Staff retry.'

export function useDesktopForemanAlternates({ chat, snapshot, active, eligible }: {
    chat: DesktopForemanChatRef; snapshot?: string; active: boolean; eligible: boolean
}) {
    const { workspaceId, chatId } = chat
    const client = useMemo(() => createForemanAlternateClient({ workspaceId, chatId }), [workspaceId, chatId])
    const lifetime = useRef<AbortController | null>(null)
    const inFlight = useRef(false)
    const [items, setItems] = useState<ForemanAlternateListEntry[]>([])
    const [open, setOpen] = useState(false)
    const [selected, setSelected] = useState<string | null>(null)
    const [loaded, setLoaded] = useState<ForemanAlternateView | null>(null)
    const [review, setReview] = useState<Review | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [refresh, setRefresh] = useState(0)

    useEffect(() => {
        if (!active) return
        const controller = new AbortController()
        lifetime.current = controller
        void client.list(controller.signal).then(items => {
            if (controller.signal.aborted) return
            const saved = new Set(items.map(item => item.requestId))
            setItems(current => [...current.filter(item => !saved.has(item.requestId)), ...items])
        }).catch(error => { if (!controller.signal.aborted) setError(errorText(error)) })
        return () => {
            controller.abort()
            if (lifetime.current === controller) lifetime.current = null
        }
    }, [active, client])

    useEffect(() => {
        if (!active || !open || !selected) return
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout>
        const poll = async () => {
            if (isDesktopQuitting()) return
            try {
                const next = await client.read(selected, controller.signal)
                if (controller.signal.aborted) return
                setLoaded(next)
                if (next.status === 'running') timer = setTimeout(() => void poll(), 1000)
            } catch (error) {
                if (!controller.signal.aborted) setError(errorText(error))
            }
        }
        void poll()
        return () => { controller.abort(); clearTimeout(timer) }
    }, [active, open, selected, refresh, client])

    const perform = async (action: (signal: AbortSignal) => Promise<void>) => {
        const signal = lifetime.current?.signal
        if (!active || !signal || signal.aborted || isDesktopQuitting() || inFlight.current) return
        inFlight.current = true
        setBusy(true)
        setError(null)
        try { await action(signal) }
        catch (error) { if (!signal.aborted) setError(errorText(error)) }
        finally { inFlight.current = false; setBusy(false) }
    }
    const freshReview = active && eligible && review?.snapshot === snapshot ? review : null
    const view = loaded?.requestId === selected ? loaded : null
    const close = useCallback(() => { setError(null); setOpen(false); setSelected(null) }, [])

    return {
        items, open, selected, view, review: freshReview, busy, error,
        openList: () => { setError(null); setOpen(true) },
        close,
        select: (requestId: string | null) => { setError(null); setSelected(requestId) },
        cancelReview: () => setReview(null),
        reload: () => { setError(null); setRefresh(value => value + 1) },
        reviewReply(messageId: string) {
            if (!eligible || !snapshot) return
            return perform(async signal => {
                await client.review(messageId, snapshot, signal)
                if (!signal.aborted) setReview({ messageId, snapshot, requestId: crypto.randomUUID() })
            })
        },
        confirm() {
            if (!freshReview) return
            const { requestId, messageId, snapshot } = freshReview
            return perform(async signal => {
                const preparation = await client.prepare(requestId, messageId, snapshot, signal)
                if (signal.aborted) return
                setItems(items => [{ requestId, messageId }, ...items.filter(item => item.requestId !== requestId)])
                setReview(null)
                setOpen(true)
                setSelected(requestId)
                if (preparation.status === 'prepared' && !isDesktopQuitting()) {
                    try { await client.run('start', requestId, signal) }
                    finally { if (!signal.aborted) setRefresh(value => value + 1) }
                }
            })
        },
        command(action: 'start' | 'stop' | 'recover') {
            if (!selected || !view) return
            return perform(async signal => {
                try {
                    if (action === 'recover') await client.recover(selected, signal)
                    else await client.run(action, selected, signal)
                } finally { if (!signal.aborted) setRefresh(value => value + 1) }
            })
        },
    }
}
