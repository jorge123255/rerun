'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { DesktopUsageWaitKey, DesktopUsageWaitStatus } from './server/usage-waits'

const ROUTE = '/api/desktop/usage-waits'
/** How often the open app asks whether a waiting message can be sent now. */
export const DESKTOP_USAGE_WAIT_TICK_MS = 60_000

// Which conversations hold a waiting message. Kept for the window so that the app only asks its
// server about waits when there is one: seeded when the app opens, added to when a message is
// queued, and replaced by each tick's answer.
const keyOf = (agentId: string, sessionId: string | null) => `${agentId}\0${sessionId ?? ''}`
let holding = new Set<string>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
// The coworkers behind those conversations, as one stable string for the board to read.
let holdingAgents = ''
function setHolding(next: Set<string>) {
    if (next.size === holding.size && [...next].every(key => holding.has(key))) return
    holding = next
    holdingAgents = [...new Set([...next].map(key => key.split('\0')[0]))].sort().join('\0')
    for (const listener of listeners) listener()
}
export function seedDesktopUsageWaits(keys: readonly DesktopUsageWaitKey[]) { setHolding(new Set(keys.map(key => keyOf(key.agentId, key.sessionId)))) }

/**
 * The coworkers holding a message until their plan resets. Read from what the window already
 * knows (the app's seed, each queued message and the minute clock's answers): it asks nothing.
 */
export function useDesktopUsageWaitAgents(): ReadonlySet<string> {
    const joined = useSyncExternalStore(subscribe, () => holdingAgents, () => '')
    return useMemo(() => new Set(joined ? joined.split('\0') : []), [joined])
}

async function post(body: unknown): Promise<unknown> {
    const response = await fetch(ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const data = await response.json().catch(() => null) as { error?: unknown } | null
    if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'That did not work. Try again.')
    return data
}

/**
 * The message this conversation is holding until its plan resets. It is read only when the chat
 * shows a usage-limit notice (`revision` changes with each one) or when this conversation is known
 * to hold a message; otherwise nothing is asked.
 */
export function useDesktopUsageWait(agentId: string, sessionId: string | null, active: boolean, revision: number) {
    const [status, setStatus] = useState<DesktopUsageWaitStatus | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const key = keyOf(agentId, sessionId)
    const scope = useRef(key)
    scope.current = key
    const held = useSyncExternalStore(subscribe, () => holding.has(key), () => false)
    const wanted = active && (revision > 0 || held)

    const load = useCallback(async (signal?: AbortSignal) => {
        const own = keyOf(agentId, sessionId)
        try {
            const query = new URLSearchParams({ agentId, ...(sessionId && { sessionId }) })
            const response = await fetch(`${ROUTE}?${query}`, { cache: 'no-store', signal })
            if (!response.ok || signal?.aborted || scope.current !== own) return
            const next = await response.json() as DesktopUsageWaitStatus
            setStatus(next)
            const all = new Set(holding)
            if (next.wait) all.add(own); else all.delete(own)
            setHolding(all)
        } catch { /* The notice still offers another model; the wait is read again on the next tick. */ }
    }, [agentId, sessionId])

    useEffect(() => {
        if (!wanted) { setStatus(null); setError(''); return }
        const controller = new AbortController()
        void load(controller.signal)
        const timer = setInterval(() => void load(controller.signal), DESKTOP_USAGE_WAIT_TICK_MS)
        return () => { controller.abort(); clearInterval(timer) }
    }, [wanted, load, revision])

    const act = useCallback(async (body: unknown) => {
        setBusy(true); setError('')
        try { await post(body); await load() }
        catch (cause) { setError(cause instanceof Error ? cause.message : 'That did not work. Try again.') }
        finally { setBusy(false) }
    }, [load])

    return {
        status: wanted ? status : null, busy, error,
        queue: (text: string) => act({ action: 'queue', agentId, sessionId, text }),
        cancel: (id: string) => act({ action: 'cancel', id }),
    }
}

/**
 * The app's clock for waiting messages. While any conversation holds one, each minute it asks the
 * app's own server to send whatever can be sent now. The server decides and sends; this only ticks.
 */
export function useDesktopUsageWaitClock(initial?: readonly DesktopUsageWaitKey[]) {
    const seeded = useRef(false)
    if (!seeded.current) { seeded.current = true; if (initial?.length) seedDesktopUsageWaits(initial) }
    const any = useSyncExternalStore(subscribe, () => holding.size > 0, () => false)
    useEffect(() => {
        if (!any) return
        const tick = () => {
            void post({ action: 'flush' }).then(data => {
                const active = (data as { active?: DesktopUsageWaitKey[] } | null)?.active
                if (Array.isArray(active)) seedDesktopUsageWaits(active)
            }).catch(() => {})
        }
        const first = setTimeout(tick, 5_000)
        const timer = setInterval(tick, DESKTOP_USAGE_WAIT_TICK_MS)
        return () => { clearTimeout(first); clearInterval(timer) }
    }, [any])
}
