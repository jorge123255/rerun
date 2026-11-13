'use client'

import { useEffect, useState } from 'react'
import type { DesktopUpcomingRoutine } from '@rerun/contracts'
import { readDesktopUpcomingRoutines } from '@/lib/desktop/workspace-routines/client'

const REFRESH_MS = 15_000
const EMPTY: DesktopUpcomingRoutine[] = []

export function useDesktopUpcomingRoutines(workspaceId: number | null, launchNonce: string | undefined, ownerIds: string[], enabled: boolean) {
    const scope = enabled && workspaceId !== null && ownerIds.length
        ? JSON.stringify([workspaceId, launchNonce, [...ownerIds].sort()])
        : null
    const [state, setState] = useState<{ scope: string; routines: DesktopUpcomingRoutine[]; now: number } | null>(null)

    useEffect(() => {
        if (scope === null) return
        const lifetime = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        let reading = false
        const refresh = async () => {
            if (lifetime.signal.aborted || document.visibilityState === 'hidden') return
            if (reading) return
            reading = true
            clearTimeout(timer)
            const routines = await readDesktopUpcomingRoutines(AbortSignal.any([lifetime.signal, AbortSignal.timeout(8000)])).catch(() => EMPTY)
            reading = false
            if (lifetime.signal.aborted) return
            const now = Date.now()
            const upcoming = routines.filter(routine => routine.at > now)
            setState({ scope, routines: upcoming, now })
            const delay = upcoming.reduce((wait, routine) => Math.min(wait, routine.at - now), REFRESH_MS)
            if (document.visibilityState === 'visible') timer = setTimeout(refresh, delay)
        }
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') clearTimeout(timer)
            else void refresh()
        }
        void refresh()
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('focus', onVisibility)
        return () => {
            lifetime.abort()
            clearTimeout(timer)
            document.removeEventListener('visibilitychange', onVisibility)
            window.removeEventListener('focus', onVisibility)
        }
    }, [scope])

    return state && state.scope === scope ? state : null
}
