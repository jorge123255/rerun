import type { BoardAgent } from '@rerun/contracts'
import { useEffect, useState } from 'react'

import { fetchBoardAgents } from '@/api/board'
import { useAuth } from '@/auth/AuthProvider'
import { cachedBoard } from '@/data/local-cache'

// The coworkers of the workspace, for a screen that names or draws them outside the Home: served from
// the board the Home kept while a fresh read lands. Null until either answers.
export function useWorkspaceAgents(): BoardAgent[] | null {
    const { session, me } = useAuth()
    const accessToken = session?.access_token
    const workspaceId = me?.workspace.id
    const [agents, setAgents] = useState<BoardAgent[] | null>(() => (workspaceId === undefined ? null : (cachedBoard(workspaceId).read()?.agents ?? null)))

    useEffect(() => {
        if (!accessToken || workspaceId === undefined) return
        let alive = true
        fetchBoardAgents({ accessToken, workspaceId })
            .then(list => {
                if (alive) setAgents(list)
            })
            .catch(() => {})
        return () => {
            alive = false
        }
    }, [accessToken, workspaceId])

    return agents
}
