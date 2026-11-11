'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { DesktopMcpSignInSource } from '../../../../../packages/contracts/src/desktop-mcp-sign-in'
import type { McpDeviceAttemptView, McpDeviceAuthorization, McpDeviceMethodReview, McpDeviceReviewDecision } from '@/lib/desktop/mcp-device-review'
import { DesktopMcpDeviceMethodReview } from './DesktopMcpDeviceMethodReview'

export function DesktopMcpDeviceSignIn({ source, onBack, onConnected }: {
    source: DesktopMcpSignInSource
    onBack(): void
    onConnected(): void
}) {
    const [review, setReview] = useState<McpDeviceMethodReview | null>(null)
    const [authorization, setAuthorization] = useState<McpDeviceAuthorization | null>(null)
    const [busy, setBusy] = useState(false)
    const [deciding, setDeciding] = useState(false)
    const [notice, setNotice] = useState('')
    const [terminal, setTerminal] = useState(false)
    const controller = useRef<AbortController | null>(null)
    const decisionInFlight = useRef(false)
    const requestIds = useRef<Partial<Record<'start' | 'check', string>>>({})
    useEffect(() => () => controller.current?.abort(), [])
    useEffect(() => {
        if (!authorization && review?.state !== 'approved') return
        const expiresAt = authorization?.expiresAt ?? review!.expiresAt
        const timer = setTimeout(() => {
            setAuthorization(null)
            setTerminal(true)
            setNotice(authorization ? 'The verification code expired.' : 'Device approval expired.')
        }, Math.max(1, expiresAt - Date.now()))
        return () => clearTimeout(timer)
    }, [authorization, review])

    async function action<T>(input: Record<string, unknown>, signal: AbortSignal): Promise<T> {
        const response = await fetch(`/api/desktop/sessions/${encodeURIComponent(source.sessionId)}/mcp-device-sign-in`, {
            method: 'POST', cache: 'no-store', signal, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...input, source }),
        })
        if (!response.ok) throw new Error('Device sign-in is unavailable')
        const body = await response.json() as T
        signal.throwIfAborted()
        return body
    }
    function showCode(code: McpDeviceAuthorization | null, expected: McpDeviceMethodReview) {
        if (code && (code.reviewId !== expected.reviewId || code.revision !== expected.revision
            || code.verificationUri !== expected.method.verificationUri || !code.verificationUri.startsWith('https://')
            || !/^[\x21-\x7e]{1,128}$/.test(code.userCode) || code.expiresAt <= Date.now())) throw new Error('Verification code changed')
        setAuthorization(code)
    }
    async function run(work: (signal: AbortSignal) => Promise<void>) {
        if (controller.current || decisionInFlight.current) return
        const pending = new AbortController()
        controller.current = pending
        setBusy(true); setNotice('')
        try { await work(pending.signal) }
        catch { if (!pending.signal.aborted) setNotice('Device sign-in is unavailable. Retry or reload this conversation.') }
        finally { if (!pending.signal.aborted) { controller.current = null; setBusy(false) } }
    }
    async function loadReview(signal: AbortSignal) {
        const result = await action<{ review: McpDeviceMethodReview }>({ action: 'review-device-method' }, signal)
        const next = result.review
        if (next.owner !== source.agentId || next.localSessionId !== source.sessionId || next.serverName !== source.server.name
            || next.registrationRevision !== source.server.revision || next.method.resource !== source.server.url) throw new Error('Review changed')
        setReview(next)
        if (next.state === 'approved') {
            const { authorization } = await action<{ authorization: McpDeviceAuthorization | null }>({
                action: 'read-device-authorization', reviewId: next.reviewId, revision: next.revision,
            }, signal)
            showCode(authorization, next)
        }
    }
    async function decide(decision: McpDeviceReviewDecision, signal: AbortSignal) {
        if (controller.current) throw new Error('Device operation is running')
        decisionInFlight.current = true
        setDeciding(true)
        try {
            const { review: next } = await action<{ review: McpDeviceMethodReview }>({ action: 'decide-device-method', decision }, signal)
            if (!review || next.reviewId !== review.reviewId || next.revision !== review.revision
                || next.owner !== review.owner || next.localSessionId !== review.localSessionId || next.workspaceId !== review.workspaceId
                || next.serverName !== review.serverName || next.registrationRevision !== review.registrationRevision
                || JSON.stringify(next.method) !== JSON.stringify(review.method)) throw new Error('Review changed')
            setReview(next)
            if (next.state !== 'approved') setAuthorization(null)
            return next
        } finally {
            decisionInFlight.current = false
            if (!signal.aborted) setDeciding(false)
        }
    }
    async function operate(operation: 'start' | 'check', signal: AbortSignal) {
        if (review?.state !== 'approved' || review.expiresAt <= Date.now()) return
        const requestId = requestIds.current[operation] ?? crypto.randomUUID()
        requestIds.current[operation] = requestId
        const { attempt } = await action<{ attempt: McpDeviceAttemptView }>({
            action: `${operation}-device-authorization`, reviewId: review.reviewId, revision: review.revision, requestId,
        }, signal)
        delete requestIds.current[operation]
        if (attempt.state === 'connected') { setAuthorization(null); onConnected(); return }
        showCode(attempt.authorization, review)
        if (attempt.state === 'pending') setNotice('Still waiting for authorization in your browser.')
        if (attempt.state !== 'waiting' && attempt.state !== 'pending') {
            setTerminal(true)
            setNotice(attempt.state === 'unknown' ? 'The provider response could not be confirmed. Stop this attempt to return to sign-in.' : 'Device authorization is unavailable or has expired.')
        }
    }

    return <div className="space-y-3">
        {!review && <Button size="sm" variant="outline" disabled={busy} onClick={() => { void run(loadReview) }}>Review device sign-in</Button>}
        {review && <DesktopMcpDeviceMethodReview review={review} active={!busy} onDecide={decide} />}
        {review?.state === 'approved' && !terminal && <>
            {authorization ? <div className="space-y-2">
                <p className="text-sm">Enter this code in your browser <code className="ml-1 select-all font-semibold">{authorization.userCode}</code></p>
                <a href={authorization.verificationUri} target="_blank" rel="noreferrer" className="block break-words text-sm underline underline-offset-2">Open verification page</a>
                <Button size="sm" disabled={busy || deciding} onClick={() => { void run(signal => operate('check', signal)) }}>Check authorization</Button>
            </div> : <Button size="sm" disabled={busy || deciding} onClick={() => { void run(signal => operate('start', signal)) }}>Start device sign-in</Button>}
        </>}
        {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
        {(!review || review.state !== 'approved') && <Button size="sm" variant="ghost" disabled={busy || deciding} onClick={onBack}>Back to sign-in</Button>}
    </div>
}
