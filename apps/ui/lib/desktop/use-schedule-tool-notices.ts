'use client'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { desktopScheduleToolNoticeSchema } from '@rerun/contracts'
import { readDesktopToolInstallBody } from './tool-install-client'
const schema = z.strictObject({ notices: z.array(desktopScheduleToolNoticeSchema.omit({ engineAgentId: true })).max(50) })
export function useDesktopScheduleToolNotices(agentId: string, onCommitted: () => void) {
    const callback = useRef(onCommitted); callback.current = onCommitted
    const [last, setLast] = useState<z.infer<typeof schema>['notices'][number] | null>(null)
    useEffect(() => {
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined, previous = ''
        setLast(null)
        const poll = async () => {
            if (controller.signal.aborted) return
            try {
                const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])
                const response = await fetch(`/api/desktop/coworkers/${encodeURIComponent(agentId)}/schedule-tool-notices`, { cache: 'no-store', signal })
                const body = schema.parse(await readDesktopToolInstallBody(response, signal, 64000))
                if (!response.ok || body.notices.some(row => row.localAgentId !== agentId)) throw new Error('Routine notice owner changed')
                const fingerprint = JSON.stringify(body.notices)
                if (!controller.signal.aborted && fingerprint !== previous) {
                    const first = previous === ''; previous = fingerprint
                    setLast(body.notices.at(-1) ?? null)
                    if (!first || body.notices.length) callback.current()
                }
            } catch { /* The canonical schedule list remains usable; reconnect retries the notice read. */ }
            if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2500)
        }
        void poll()
        return () => { controller.abort(); if (timer) clearTimeout(timer) }
    }, [agentId])
    return last?.localAgentId === agentId ? last : null
}
