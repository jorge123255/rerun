import { useCallback, useEffect, useRef, useState } from 'react'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import { BOARD_ACTIVITY_POLL_MS, BOARD_ACTIVITY_URL, boardActivitySchema, type BoardActivityStatus } from '@/lib/desktop/board-activity'

// Polls per-coworker activity while the board is mounted and the window is visible.
// A failed read marks every coworker unreachable instead of leaving a stale or idle state.
export function useBoardActivity(agentIds: string[]): Record<string, BoardActivityStatus> {
    const [statuses, setStatuses] = useState<Record<string, BoardActivityStatus>>({})
    const inFlight = useRef<AbortController | null>(null)
    const ids = useRef(agentIds)
    useEffect(() => { ids.current = agentIds }, [agentIds])
    const read = useCallback(async () => {
        if (inFlight.current) return
        const controller = new AbortController()
        inFlight.current = controller
        try {
            const response = await fetch(BOARD_ACTIVITY_URL, { signal: controller.signal, cache: 'no-store' })
            if (!response.ok) throw new Error('Board activity read failed')
            const { agents } = boardActivitySchema.parse(await response.json())
            if (!controller.signal.aborted) setStatuses(agents)
        } catch {
            if (!controller.signal.aborted) setStatuses(Object.fromEntries(ids.current.map(id => [id, 'unreachable' as const])))
        } finally {
            if (inFlight.current === controller) inFlight.current = null
        }
    }, [])
    useVisibleInterval(read, BOARD_ACTIVITY_POLL_MS)
    useEffect(() => () => inFlight.current?.abort(), [])
    return statuses
}
