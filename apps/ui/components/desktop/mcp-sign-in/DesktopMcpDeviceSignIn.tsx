'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { DesktopMcpSignInSource } from '../../../../../packages/contracts/src/desktop-mcp-sign-in'
import type { McpDeviceAttemptView, McpDeviceAuthorization, McpDeviceMethodReview, McpDeviceReviewDecision } from '@/lib/desktop/mcp-device-review'
import { DesktopMcpDeviceMethodReview } from './DesktopMcpDeviceMethodReview'
import { useDesktopLocale } from '../DesktopLocale'
import type { DesktopMessages } from '@/lib/desktop/locale'

export function DesktopMcpDeviceSignIn({ source, onBack, onConnected }: {
    source: DesktopMcpSignInSource
    onBack(): void
    onConnected(): void
}) {
    const { t } = useDesktopLocale()
    const [review, setReview] = useState<McpDeviceMethodReview | null>(null)
    const [authorization, setAuthorization] = useState<McpDeviceAuthorization | null>(null)
    const [busy, setBusy] = useState(false)
    const [deciding, setDeciding] = useState(false)
    const [notice, setNotice] = useState<keyof DesktopMessages['mcpSignIn']['device']['notices'] | null>(null)
    const [terminal, setTerminal] = useState(false)
    const controller = useRef<AbortController | null>(null)
    const decisionInFlight = useRef(false)
    const requestIds = useRef<Partial<Record<'start' | 'check', string>>>({})
    useEffect(() => () => {
        controller.current?.abort()
        controller.current = null
    }, [])
    useEffect(() => {
        if (terminal || !authorization && review?.state !== 'approved') return
        const expiresAt = authorization?.expiresAt ?? review!.expiresAt
        const timer = setTimeout(() => {
            setAuthorization(null)
            setTerminal(true)
            setNotice(authorization ? 'codeExpired' : 'approvalExpired')
        }, Math.max(1, expiresAt - Date.now()))
        return () => clearTimeout(timer)
    }, [authorization, review, terminal])

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
        setBusy(true); setNotice(null)
        try { await work(pending.signal) }
        catch { if (!pending.signal.aborted) setNotice('retry') }
        finally { if (controller.current === pending) { controller.current = null; setBusy(false) } }
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
        const stopping = decision.operation === 'stop-device-method'
        if (decisionInFlight.current || controller.current && !stopping) throw new Error('Device operation is running')
        decisionInFlight.current = true
        setDeciding(true)
        if (stopping) {
            controller.current?.abort()
            controller.current = null
            setBusy(false)
            setAuthorization(null)
            setNotice(null)
            // Keep Start and Check unavailable while the exact Stop is awaiting acknowledgement.
            setTerminal(true)
        }
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
        if (attempt.state === 'pending') setNotice('pending')
        if (attempt.state !== 'waiting' && attempt.state !== 'pending') {
            setTerminal(true)
            setNotice(attempt.state === 'unknown' ? 'unknown' : 'unavailable')
        }
    }

    return <div className="space-y-3">
        {!review && <Button size="sm" variant="outline" disabled={busy} onClick={() => { void run(loadReview) }}>{t('mcpSignIn.device.review')}</Button>}
        {review && <DesktopMcpDeviceMethodReview review={review} active authorizationBusy={busy} onDecide={decide} />}
        {review?.state === 'approved' && !terminal && <>
            {authorization ? <div className="space-y-2">
                <p className="text-sm">{t('mcpSignIn.device.enterCode')} <code className="ml-1 select-all font-semibold">{authorization.userCode}</code></p>
                <a href={authorization.verificationUri} target="_blank" rel="noreferrer" className="block break-words text-sm underline underline-offset-2">{t('mcpSignIn.device.verificationPage')}</a>
                <Button size="sm" disabled={busy || deciding} onClick={() => { void run(signal => operate('check', signal)) }}>{t('mcpSignIn.device.checkAuthorization')}</Button>
            </div> : <Button size="sm" disabled={busy || deciding} onClick={() => { void run(signal => operate('start', signal)) }}>{t('mcpSignIn.device.start')}</Button>}
        </>}
        {notice && <p role="status" className="text-xs text-muted-foreground">{t(`mcpSignIn.device.notices.${notice}`)}</p>}
        {(!review || review.state !== 'approved') && <Button size="sm" variant="ghost" disabled={busy || deciding} onClick={onBack}>{t('mcpSignIn.device.back')}</Button>}
    </div>
}
