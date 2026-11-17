import { useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'

import { fetchForemanConversation } from '@/api/foreman'
import { useAuth } from '@/auth/AuthProvider'
import { cachedForeman } from '@/data/local-cache'

export type ForemanLast = { title: string | null; running: boolean }

// What the Foreman's row on the Home says: the title of its last conversation, first as the phone
// kept it, then as the hub tells it each time the Home comes back into view.
export function useForemanLast(): ForemanLast {
    const { session, me } = useAuth()
    const accessToken = session?.access_token
    const workspaceId = me?.workspace.id
    const [last, setLast] = useState<ForemanLast>(() => ({ title: workspaceId ? (cachedForeman(workspaceId).read()?.last?.title ?? null) : null, running: false }))

    useFocusEffect(
        useCallback(() => {
            if (!accessToken || !workspaceId) return
            let stale = false
            fetchForemanConversation({ accessToken, workspaceId })
                .then(conversation => !stale && setLast({ title: conversation?.title ?? null, running: Boolean(conversation?.activeRunId) }))
                .catch(() => {})
            return () => {
                stale = true
            }
        }, [accessToken, workspaceId])
    )

    return last
}
