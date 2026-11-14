'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { McpDeviceMethodReview, McpDeviceReviewDecision } from '@/lib/desktop/mcp-device-review'
import { useDesktopLocale } from '../DesktopLocale'

const scopeOf = (view: McpDeviceMethodReview) => JSON.stringify([view.reviewId, view.revision, view.workspaceId, view.owner, view.localSessionId, view.serverName, view.registrationRevision, view.method])

export function DesktopMcpDeviceMethodReview({ review, active, authorizationBusy = false, onDecide }: {
    review: McpDeviceMethodReview
    active: boolean
    authorizationBusy?: boolean
    onDecide(input: McpDeviceReviewDecision, signal: AbortSignal): Promise<McpDeviceMethodReview>
}) {
    const { t } = useDesktopLocale()
    const [view, setView] = useState(review)
    const [decisionUnconfirmed, setDecisionUnconfirmed] = useState(false)
    const [busy, setBusy] = useState(false)
    const [clock, setClock] = useState(Date.now)
    const scope = scopeOf(review)
    const current = useRef({ scope, active })
    current.current = { scope, active }
    const pending = useRef<AbortController | null>(null)
    const decisions = useRef(new Map<string, string>())
    const latch = useRef(false)
    useEffect(() => {
        pending.current?.abort(); pending.current = null; latch.current = false
        decisions.current.clear(); setView(review); setBusy(false); setDecisionUnconfirmed(false)
        return () => { pending.current?.abort(); latch.current = false }
    }, [scope])
    useEffect(() => {
        if (!active) { pending.current?.abort(); pending.current = null; latch.current = false; setBusy(false) }
    }, [active])
    useEffect(() => {
        setView(previous => {
            if (previous.reviewId === review.reviewId && previous.revision === review.revision
                && previous.state !== 'pending' && review.state === 'pending') return previous
            if (['stopped', 'revoked', 'declined', 'expired'].includes(previous.state) && (review.state === 'pending' || review.state === 'approved')) return previous
            return review
        })
    }, [review.state, review.expiresAt, review.reviewId, review.revision])
    useEffect(() => {
        setClock(Date.now())
        const timer = setTimeout(() => setClock(Date.now()), Math.max(1, view.expiresAt - Date.now()))
        return () => clearTimeout(timer)
    }, [view.expiresAt])
    async function decide(operation: McpDeviceReviewDecision['operation']) {
        if (!active || latch.current || scopeOf(view) !== scope || authorizationBusy && operation !== 'stop-device-method') return
        latch.current = true; setBusy(true); setDecisionUnconfirmed(false)
        const controller = new AbortController(); pending.current = controller
        const decisionId = decisions.current.get(operation) ?? crypto.randomUUID()
        decisions.current.set(operation, decisionId)
        try {
            const next = await onDecide({ reviewId: view.reviewId, revision: view.revision, decisionId, operation }, controller.signal)
            if (controller.signal.aborted || !current.current.active || current.current.scope !== scope) return
            if (next.reviewId !== view.reviewId || next.revision !== view.revision || next.workspaceId !== view.workspaceId || next.owner !== view.owner || next.localSessionId !== view.localSessionId
                || next.serverName !== view.serverName || next.registrationRevision !== view.registrationRevision || JSON.stringify(next.method) !== JSON.stringify(view.method)) throw new Error('Review changed')
            setView(next)
        } catch {
            if (!controller.signal.aborted && current.current.scope === scope) setDecisionUnconfirmed(true)
        } finally {
            if (pending.current === controller) { pending.current = null; latch.current = false; setBusy(false) }
        }
    }
    const expired = view.expiresAt <= clock
    const canApprove = active && !busy && !authorizationBusy && view.state === 'pending' && !expired
    const state = expired && (view.state === 'pending' || view.state === 'approved') ? 'expired' : view.state
    return <section className="min-w-0 space-y-3 border-t border-dashed pt-3" aria-label={t('mcpSignIn.review.region')}>
        <div>
            <p className="text-sm font-medium">{t('mcpSignIn.review.title')}</p>
            <p className="text-xs text-muted-foreground">{t('mcpSignIn.review.description')}</p>
        </div>
        <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
            {([
                ['server', view.serverName], ['resource', view.method.resource], ['issuer', view.method.issuer],
                ['client', view.method.clientId], ['scopes', view.method.scope || t('mcpSignIn.review.noScopes')],
                ['deviceEndpoint', view.method.deviceEndpoint], ['tokenEndpoint', view.method.tokenEndpoint],
                ['verificationPage', view.method.verificationUri], ['registrationRevision', view.registrationRevision],
            ] as const).map(([field, value]) => <div key={field} className="contents"><dt className="font-medium">{t(`mcpSignIn.review.fields.${field}`)}</dt><dd className="min-w-0 break-all whitespace-pre-wrap">{value}</dd></div>)}
        </dl>
        <p role="status" className="text-xs text-muted-foreground">{t(`mcpSignIn.review.states.${state}`)}</p>
        {view.receipt && <p className="text-xs text-muted-foreground">{t(view.receipt.outcome === 'approved' ? 'mcpSignIn.review.receiptApproved' : 'mcpSignIn.review.receiptDeclined')}</p>}
        <div className="flex flex-wrap gap-2">
            {view.state === 'pending' && <>
                <Button size="sm" disabled={!canApprove} onClick={() => { void decide('approve-device-method') }}>{t('mcpSignIn.review.approve')}</Button>
                <Button size="sm" variant="ghost" disabled={!canApprove} onClick={() => { void decide('decline-device-method') }}>{t('mcpSignIn.notNow')}</Button>
            </>}
            {(view.state === 'pending' || view.state === 'approved') && <Button size="sm" variant="outline" disabled={!active || busy} onClick={() => { void decide('stop-device-method') }}>{t('mcpSignIn.review.stop')}</Button>}
        </div>
        {decisionUnconfirmed && <p role="alert" className="break-words text-xs text-destructive">{t('mcpSignIn.review.unconfirmed')}</p>}
    </section>
}
