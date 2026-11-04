import { useCallback, useEffect, useRef, useState } from 'react'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import { DESKTOP_ATTENTION_URL, desktopAttentionSchema, type DesktopAttentionItem } from '@/lib/desktop/attention'

export const DESKTOP_ATTENTION_POLL_MS = 3000

export type DesktopAttentionRead = 'loading' | 'ready' | 'failed'

export type DesktopAttentionState = {
    status: DesktopAttentionRead
    items: DesktopAttentionItem[]
    unavailableAgentIds: string[]
    checkedAt: string | null
}

// Polls the read-only actions inbox while the panel is open (`active`) and the window is visible.
// A failed read keeps the last good list but is never shown as an empty or fully resolved
// workspace: the status stays `failed` so the panel can offer a retry instead of a false « nothing ».
export function useDesktopAttention(active = true): DesktopAttentionState & { retry: () => void } {
    const [attempt, setAttempt] = useState(0)
    const [state, setState] = useState<DesktopAttentionState>({ status: 'loading', items: [], unavailableAgentIds: [], checkedAt: null })
    const inFlight = useRef<AbortController | null>(null)
    const mounted = useRef(true)
    const activeRef = useRef(active)
    activeRef.current = active

    const read = useCallback(async () => {
        if (!activeRef.current || inFlight.current || document.visibilityState === 'hidden') return
        const controller = new AbortController()
        inFlight.current = controller
        try {
            const response = await fetch(DESKTOP_ATTENTION_URL, { signal: controller.signal, cache: 'no-store' })
            if (!response.ok) throw new Error(`Attention read failed (${response.status})`)
            const body = desktopAttentionSchema.parse(await response.json())
            if (!mounted.current || controller.signal.aborted) return
            setState({ status: 'ready', items: body.items, unavailableAgentIds: body.unavailableAgentIds, checkedAt: body.checkedAt })
        } catch (error) {
            if (!mounted.current || controller.signal.aborted) return
            if ((error as Error)?.name === 'AbortError') return
            setState(current => ({ ...current, status: 'failed' }))
        } finally {
            if (inFlight.current === controller) inFlight.current = null
        }
    }, [])

    useVisibleInterval(() => void read(), DESKTOP_ATTENTION_POLL_MS)

    // Closing the panel stops polling and cancels an in-flight read; opening it reads immediately.
    useEffect(() => {
        if (active) void read()
        else inFlight.current?.abort()
    }, [active, read])

    // A manual retry re-reads right away when the last read failed.
    useEffect(() => {
        if (attempt > 0 && state.status === 'failed') void read()
    }, [attempt, state.status, read])

    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
            inFlight.current?.abort()
        }
    }, [])

    const retry = useCallback(() => setAttempt(value => value + 1), [])

    return { ...state, retry }
}
