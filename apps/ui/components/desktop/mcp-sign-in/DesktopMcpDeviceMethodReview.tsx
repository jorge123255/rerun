'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { McpDeviceMethodReview, McpDeviceReviewDecision } from '@/lib/desktop/mcp-device-review'

const scopeOf = (view: McpDeviceMethodReview) => JSON.stringify([view.reviewId, view.revision, view.workspaceId, view.owner, view.localSessionId, view.serverName, view.registrationRevision, view.method])

export function DesktopMcpDeviceMethodReview({ review, active, onDecide }: {
    review: McpDeviceMethodReview
    active: boolean
    onDecide(input: McpDeviceReviewDecision, signal: AbortSignal): Promise<McpDeviceMethodReview>
}) {
    const [view, setView] = useState(review)
    const [error, setError] = useState<string | null>(null)
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
        decisions.current.clear(); setView(review); setBusy(false); setError(null)
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
        if (!active || latch.current || scopeOf(view) !== scope) return
        latch.current = true; setBusy(true); setError(null)
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
            if (!controller.signal.aborted && current.current.scope === scope) setError('The decision was not confirmed. Retry this same decision or reload the conversation.')
        } finally {
            if (pending.current === controller) { pending.current = null; latch.current = false; setBusy(false) }
        }
    }
    const expired = view.expiresAt <= clock
    const canApprove = active && !busy && view.state === 'pending' && !expired
    return <section className="min-w-0 space-y-3 border-t border-dashed pt-3" aria-label="Device method approval">
        <div>
            <p className="text-sm font-medium">Review device sign-in method</p>
            <p className="text-xs text-muted-foreground">Approving this method permits a device sign-in attempt. It does not connect the server or approve browser OAuth.</p>
        </div>
        <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
            {[
                ['Server', view.serverName], ['Resource', view.method.resource], ['Issuer', view.method.issuer],
                ['Client', view.method.clientId], ['Scopes', view.method.scope || 'No scopes requested'],
                ['Device endpoint', view.method.deviceEndpoint], ['Token endpoint', view.method.tokenEndpoint],
                ['Verification page', view.method.verificationUri], ['Registration revision', view.registrationRevision],
            ].map(([label, value]) => <div key={label} className="contents"><dt className="font-medium">{label}</dt><dd className="min-w-0 break-all whitespace-pre-wrap">{value}</dd></div>)}
        </dl>
        <p role="status" className="text-xs text-muted-foreground">{expired && (view.state === 'pending' || view.state === 'approved') ? 'Expired' : view.state === 'approved' ? 'Method approved; connection is not yet verified.' : view.state}</p>
        {view.receipt && <p className="text-xs text-muted-foreground">Saved decision: {view.receipt.outcome}</p>}
        <div className="flex flex-wrap gap-2">
            {view.state === 'pending' && <>
                <Button size="sm" disabled={!canApprove} onClick={() => { void decide('approve-device-method') }}>Approve device method</Button>
                <Button size="sm" variant="ghost" disabled={!active || busy || expired} onClick={() => { void decide('decline-device-method') }}>Not now</Button>
            </>}
            {(view.state === 'pending' || view.state === 'approved') && <Button size="sm" variant="outline" disabled={!active || busy} onClick={() => { void decide('stop-device-method') }}>Stop device attempt</Button>}
        </div>
        {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
    </section>
}
