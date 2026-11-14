import { useCallback, useEffect, useRef, useState } from 'react'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import { BOARD_ACTIVITY_POLL_MS, BOARD_ACTIVITY_URL, boardActivitySchema, boardActivityForAgents, emptyBoardAttention, type BoardActivitySnapshot } from '@/lib/desktop/board-activity'

// The app shares this snapshot between the board and Control Center. Standalone boards
// can still own a poll; a board with a supplied snapshot disables its local reader.
// A failed read marks every coworker unreachable instead of leaving a stale or idle state.
/** `onOutsiders` is told when the engine reports activity for a coworker that is not in `agentIds`. */
export function useBoardActivity(agentIds: string[], enabled = true, onOutsiders?: (ids: string[]) => void): BoardActivitySnapshot & { refresh: () => Promise<BoardActivitySnapshot | null> } {
    const outsiders = useRef(onOutsiders)
    outsiders.current = onOutsiders
    const scope = JSON.stringify([...new Set(agentIds)].sort())
    const currentScope = useRef(scope)
    currentScope.current = scope
    const [snapshot, setSnapshot] = useState<BoardActivitySnapshot & { scope: string }>(() => ({ scope, statuses: {}, attention: emptyBoardAttention() }))
    const active = useRef(enabled)
    active.current = enabled
    const inFlight = useRef<{ controller: AbortController; scope: string; promise?: Promise<BoardActivitySnapshot | null> } | null>(null)
    const read = useCallback((): Promise<BoardActivitySnapshot | null> => {
        if (!enabled || !active.current || currentScope.current !== scope) return Promise.resolve(null)
        if (inFlight.current?.scope === scope && inFlight.current.promise) return inFlight.current.promise
        inFlight.current?.controller.abort()
        const controller = new AbortController()
        const attempt: NonNullable<typeof inFlight.current> = { controller, scope }
        inFlight.current = attempt
        const current = () => active.current && !controller.signal.aborted && currentScope.current === scope && inFlight.current === attempt
        const ids = JSON.parse(scope) as string[]
        attempt.promise = (async () => {
            try {
                const response = await fetch(BOARD_ACTIVITY_URL, { signal: controller.signal, cache: 'no-store' })
                if (!response.ok) throw new Error('Board activity read failed')
                const activity = boardActivitySchema.parse(await response.json())
                const next = boardActivityForAgents(activity, ids)
                if (!current()) return null
                const unknown = Object.keys(activity.agents).filter(id => !ids.includes(id))
                if (unknown.length) outsiders.current?.(unknown)
                setSnapshot({ scope, ...next })
                return next
            } catch {
                if (current()) setSnapshot({ scope, statuses: Object.fromEntries(ids.map(id => [id, 'unreachable' as const])), attention: emptyBoardAttention() })
                return null
            } finally {
                if (inFlight.current === attempt) inFlight.current = null
            }
        })()
        return attempt.promise
    }, [scope, enabled])
    const poll = useCallback(async () => { await read() }, [read])
    useVisibleInterval(poll, BOARD_ACTIVITY_POLL_MS)
    useEffect(() => () => {
        if (inFlight.current?.scope === scope) { inFlight.current.controller.abort(); inFlight.current = null }
    }, [scope, enabled])
    return { ...(snapshot.scope === scope ? snapshot : { statuses: {}, attention: emptyBoardAttention() }), refresh: read }
}
