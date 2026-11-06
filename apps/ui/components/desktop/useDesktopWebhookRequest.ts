'use client'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { readDesktopToolInstallBody } from '@/lib/desktop/tool-install-client'
import { triggerRequestViewSchema, type TriggerRequestView } from '@/lib/desktop/trigger-requests/types'
const envelope = z.strictObject({ request: triggerRequestViewSchema.nullable() })
/** Read the session's canonical trigger lineage. No webhook firing or continuation is implied by polling. */
export function useDesktopWebhookRequest(agentId: string, sessionId: string | null, active: boolean, refresh: number) {
    const owner = JSON.stringify([agentId, sessionId])
    const [state, setState] = useState<{ owner: string; view: TriggerRequestView | null }>({ owner, view: null })
    useEffect(() => {
        if (!active || !sessionId) return
        const stop = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined
        async function read() {
            try {
                const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(10000)])
                const response = await fetch(`/api/desktop/sessions/${encodeURIComponent(sessionId!)}/trigger-requests`, { signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
                const raw = await readDesktopToolInstallBody(response, signal, 2 * 1024 * 1024)
                if (!response.ok) throw new Error('Webhook request unavailable')
                const view = envelope.parse(raw).request
                if (view && (view.link.agentId !== agentId || view.link.sessionId !== sessionId)) throw new Error('Webhook result owner changed')
                if (!stop.signal.aborted) setState({ owner, view })
            } catch { /* Keep an exact saved view on a transient read failure; existing canonical forms remain the fallback. */ }
            finally { if (!stop.signal.aborted) timer = setTimeout(() => void read(), 3000) }
        }
        void read()
        return () => { stop.abort(); if (timer) clearTimeout(timer) }
    }, [owner, agentId, sessionId, active, refresh])
    return state.owner === owner ? state.view : null
}
