'use client'

import { useEffect, useRef } from 'react'
import { submitDesktopSecretRequestDecision } from '@/lib/desktop/secret-requests-client'
import type { DesktopSecretRequestDecision, DesktopSecretRequestView } from '../../../../../../packages/contracts/src/desktop-secret-requests'
import { DesktopSecretRequestForm } from './DesktopSecretRequestForm'
import { DesktopSecretRequestReceipt } from './DesktopSecretRequestReceipt'

export function DesktopSecretRequestBlock({ sessionId, request, active = true, inline, onAccepted }: {
    sessionId: string
    request: DesktopSecretRequestView
    active?: boolean
    inline?: boolean
    onAccepted?: (response: Response) => void | Promise<void>
}) {
    const attempt = useRef<{ key: string; id: string } | null>(null)
    const controller = useRef<AbortController | null>(null)
    const mounted = useRef(true)
    const owner = `${sessionId}:${request.requestId}`

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; controller.current?.abort() }
    }, [])
    useEffect(() => {
        attempt.current = null
        controller.current?.abort()
        controller.current = null
    }, [owner])

    const decide = async (operation: DesktopSecretRequestDecision['operation'], values?: Record<string, string>) => {
        if (!active || sessionId !== request.source.sessionId || controller.current) throw new Error('This credential request is no longer active.')
        const key = JSON.stringify([operation, request.revision, values])
        if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() }
        const pending = new AbortController()
        controller.current = pending
        try {
            const response = await submitDesktopSecretRequestDecision(sessionId, {
                operation, requestId: request.requestId, attemptId: attempt.current.id,
                expectedRevision: request.revision, source: request.source, ...(values !== undefined ? { values } : {}),
            }, { signal: pending.signal })
            if (mounted.current && !pending.signal.aborted) void onAccepted?.(response)
        } finally {
            if (controller.current === pending) controller.current = null
        }
    }

    if (request.receipt) return <DesktopSecretRequestReceipt request={request} />
    return <DesktopSecretRequestForm
        fields={request.fields}
        reason={request.reason}
        ownerKey={owner}
        disabled={!active || sessionId !== request.source.sessionId}
        inline={inline}
        onSubmit={values => decide('save', values)}
        onSkip={() => decide('skip')}
        onDismiss={() => decide('dismiss')}
    />
}
