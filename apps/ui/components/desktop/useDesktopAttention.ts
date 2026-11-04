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
export function useDesktopAttention(active = true, agentIds?: readonly string[]): DesktopAttentionState & { retry: () => void } {
    const scope = agentIds ? JSON.stringify([...new Set(agentIds)].sort()) : '*'
    const scopeRef = useRef(scope)
    scopeRef.current = scope
    const empty = { status: 'loading' as const, items: [], unavailableAgentIds: [], checkedAt: null }
    const [attempt, setAttempt] = useState(0)
    const [state, setState] = useState<DesktopAttentionState & { scope: string }>({ ...empty, scope })
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
            if (!mounted.current || controller.signal.aborted || scopeRef.current !== scope) return
            setState({ scope, status: 'ready', items: body.items, unavailableAgentIds: body.unavailableAgentIds, checkedAt: body.checkedAt })
        } catch (error) {
            if (!mounted.current || controller.signal.aborted || scopeRef.current !== scope) return
            if ((error as Error)?.name === 'AbortError') return
            setState(current => ({ ...(current.scope === scope ? current : { items: [], unavailableAgentIds: [], checkedAt: null }), scope, status: 'failed' }))
        } finally {
            if (inFlight.current === controller) inFlight.current = null
        }
    }, [scope])

    // `read` is stable, so the interval never restarts on a re-render: one in-flight request at a
    // time, three-second polling while visible, abort on close, immediate read on reopen.
    useVisibleInterval(read, DESKTOP_ATTENTION_POLL_MS)

    // Closing the panel stops polling and cancels an in-flight read; opening it reads immediately.
    useEffect(() => {
        if (active) {
            setState({ status: 'loading', items: [], unavailableAgentIds: [], checkedAt: null, scope })
            void read()
        } else {
            inFlight.current?.abort()
            inFlight.current = null
        }
        return () => {
            inFlight.current?.abort()
            inFlight.current = null
        }
    }, [active, read, scope])

    // A manual retry re-reads right away, whatever the last status: it also refreshes a partial
    // read that returned confirmed items plus unavailable coworkers, not only a total failure.
    useEffect(() => {
        if (attempt > 0) void read()
    }, [attempt, read])

    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
            inFlight.current?.abort()
        }
    }, [])

    const retry = useCallback(() => setAttempt(value => value + 1), [])

    return { ...(state.scope === scope ? state : empty), retry }
}
