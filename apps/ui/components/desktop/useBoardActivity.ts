import { useCallback, useEffect, useRef, useState } from 'react'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import { BOARD_ACTIVITY_POLL_MS, BOARD_ACTIVITY_URL, boardActivitySchema, boardActivityForAgents, emptyBoardAttention, type BoardActivitySnapshot } from '@/lib/desktop/board-activity'

// Polls per-coworker activity while the board is mounted and the window is visible.
// A failed read marks every coworker unreachable instead of leaving a stale or idle state.
export function useBoardActivity(agentIds: string[]): BoardActivitySnapshot {
    const scope = JSON.stringify([...new Set(agentIds)].sort())
    const currentScope = useRef(scope)
    currentScope.current = scope
    const [snapshot, setSnapshot] = useState<BoardActivitySnapshot & { scope: string }>(() => ({ scope, statuses: {}, attention: emptyBoardAttention() }))
    const inFlight = useRef<{ controller: AbortController; scope: string } | null>(null)
    const read = useCallback(async () => {
        if (inFlight.current?.scope === scope) return
        inFlight.current?.controller.abort()
        const controller = new AbortController()
        inFlight.current = { controller, scope }
        const current = () => !controller.signal.aborted && currentScope.current === scope && inFlight.current?.controller === controller
        const ids = JSON.parse(scope) as string[]
        try {
            const response = await fetch(BOARD_ACTIVITY_URL, { signal: controller.signal, cache: 'no-store' })
            if (!response.ok) throw new Error('Board activity read failed')
            const activity = boardActivitySchema.parse(await response.json())
            if (current()) setSnapshot({ scope, ...boardActivityForAgents(activity, ids) })
        } catch {
            if (current()) setSnapshot({ scope, statuses: Object.fromEntries(ids.map(id => [id, 'unreachable' as const])), attention: emptyBoardAttention() })
        } finally {
            if (inFlight.current?.controller === controller) inFlight.current = null
        }
    }, [scope])
    useVisibleInterval(read, BOARD_ACTIVITY_POLL_MS)
    useEffect(() => () => {
        if (inFlight.current?.scope === scope) { inFlight.current.controller.abort(); inFlight.current = null }
    }, [scope])
    return snapshot.scope === scope ? snapshot : { statuses: {}, attention: emptyBoardAttention() }
}
