'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@rerun/ui/primitives'
import { submitDesktopSecretRequestDecision } from '@/lib/desktop/secret-requests-client'
import type { DesktopSecretRequestAction, DesktopSecretRequestDecision, DesktopSecretRequestView } from '@rerun/contracts'
import { DesktopSecretRequestForm } from './DesktopSecretRequestForm'
import { DesktopSecretRequestReceipt } from './DesktopSecretRequestReceipt'

export function DesktopSecretRequestBlock({ sessionId, request, active = true, inline, onAccepted }: {
    sessionId: string
    request: DesktopSecretRequestView
    active?: boolean
    inline?: boolean
    onAccepted?: (response: Response, stream: { signal: AbortSignal; cancelStream: () => void }) => void | Promise<void>
}) {
    const attempt = useRef<{ key: string; id: string } | null>(null)
    const controller = useRef<AbortController | null>(null)
    const mounted = useRef(true)
    const owner = JSON.stringify([sessionId, request.requestId, request.revision, request.source])
    const live = useRef({ owner, active })
    live.current = { owner, active }
    const [recovering, setRecovering] = useState(false)
    const [recoveryError, setRecoveryError] = useState<string | null>(null)

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; controller.current?.abort(); attempt.current = null }
    }, [])
    useEffect(() => {
        attempt.current = null
        controller.current?.abort()
        controller.current = null
        setRecovering(false)
        setRecoveryError(null)
    }, [owner, active])

    const submit = async (input: DesktopSecretRequestAction) => {
        if (!active || sessionId !== request.source.sessionId || controller.current) throw new Error('This credential request is no longer active.')
        const pending = new AbortController()
        controller.current = pending
        try {
            const response = await submitDesktopSecretRequestDecision(sessionId, input, { signal: pending.signal })
            if (!mounted.current || pending.signal.aborted || live.current.owner !== owner || !live.current.active) throw new DOMException('Credential request changed.', 'AbortError')
            attempt.current = null
            // Chat owns the accepted stream now; removing this completed form must not abort it.
            controller.current = null
            await onAccepted?.(response, { signal: pending.signal, cancelStream: () => pending.abort() })
        } catch (error) {
            pending.abort()
            throw error
        } finally {
            if (controller.current === pending) controller.current = null
        }
    }

    const decide = async (operation: DesktopSecretRequestDecision['operation'], values?: Record<string, string>) => {
        const key = JSON.stringify([operation, request.revision, values])
        if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() }
        return submit({ operation, requestId: request.requestId, attemptId: attempt.current.id,
            expectedRevision: request.revision, source: request.source, ...(values !== undefined ? { values } : {}) })
    }

    const recover = async () => {
        const attemptId = request.receipt?.attemptId ?? request.pendingAttempt?.attemptId
        if (!attemptId || controller.current) return
        setRecovering(true)
        setRecoveryError(null)
        try {
            await submit({ operation: 'recover', requestId: request.requestId, attemptId, expectedRevision: request.revision, source: request.source })
        } catch (error) {
            if (mounted.current && live.current.owner === owner && live.current.active) setRecoveryError(error instanceof Error ? error.message : 'Could not resume this saved decision.')
        } finally {
            if (mounted.current && live.current.owner === owner) setRecovering(false)
        }
    }

    if (request.receipt || request.pendingAttempt) return <div className="space-y-2">
        {request.receipt ? <DesktopSecretRequestReceipt request={request} /> : <p className="text-xs text-muted-foreground">An encrypted credential decision is waiting to finish.</p>}
        {!request.receipt?.accepted && <Button type="button" size="sm" disabled={!active || sessionId !== request.source.sessionId || recovering} onClick={() => { void recover() }}>{recovering ? 'Resuming…' : 'Resume saved decision'}</Button>}
        {recoveryError && <p role="alert" className="break-words text-xs text-destructive">{recoveryError}</p>}
    </div>
    return <DesktopSecretRequestForm
        key={owner}
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
