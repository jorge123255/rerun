'use client'

import { useRef, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { DesktopQuestionCard } from '../DesktopQuestionCard'
import { DesktopApprovalCard } from '../DesktopApprovalCard'
import { DesktopTakeoverCard } from '../DesktopTakeoverCard'
import { DesktopServiceRequestBlock } from '../service-requests/DesktopServiceRequestBlock'
import type { DesktopServiceRequestBlockProps } from '../service-requests/DesktopServiceRequestBlock'
import { DesktopSecretRequestBlock } from '../secret-requests/DesktopSecretRequestBlock'
import { DesktopTriggerPayloadBlock } from '../triggers/DesktopTriggerPayloadBlock'
import type { TriggerPayload } from '@/lib/desktop/triggers/payload'
import { useTriggerRequest } from '@/lib/desktop/trigger-requests/use-trigger-request'
import { sameTriggerResultOwner, triggerRequestStatus, triggerResultTarget } from '@/lib/desktop/trigger-requests/projection'
import type { TriggerRequestView } from '@/lib/desktop/trigger-requests/types'
import type { DesktopPendingTakeover, DesktopTakeoverAction } from '@/lib/desktop/takeover'

export type DesktopWebhookHumanRequestProps = {
    initial: TriggerRequestView
    active: boolean
    payload?: { eventId: string; engineSessionId: string; value: TriggerPayload }
    onAccepted: (response: Response, view: TriggerRequestView) => Promise<void>
    onOpenResult: (target: ReturnType<typeof triggerResultTarget>) => void | Promise<void>
    onOpenApps?: DesktopServiceRequestBlockProps['onOpenApps']
    takeover?: { screen?: ReactNode; live?: boolean; onAction: (request: DesktopPendingTakeover, input: DesktopTakeoverAction) => Promise<void> }
}
function WebhookHumanRequest(props: DesktopWebhookHumanRequestProps) {
    const { initial, active } = props
    const state = useTriggerRequest(initial, active, props.onAccepted)
    const latest = useRef(props); latest.current = props
    const view = state.view, request = view.request
    const unsettled = view.phase === 'uncertain' || view.phase === 'stop-uncertain'
    const locked = !active || state.busy || view.availability !== 'ready' || view.runStatus !== 'done' || view.phase !== 'pending'
    async function adopt(response: Response) {
        if (!latest.current.active || !sameTriggerResultOwner(view.link, latest.current.initial.link)) { void response.body?.cancel().catch(() => {}); return }
        if (response.headers.get('x-session-id') !== view.link.sessionId) { void response.body?.cancel().catch(() => {}); throw new Error('Response belongs to a different conversation') }
        await state.reconcile()
        if (latest.current.active && sameTriggerResultOwner(view.link, latest.current.initial.link)) await latest.current.onAccepted(response, view)
        else void response.body?.cancel().catch(() => {})
    }
    return <section aria-label="Webhook request" className="min-w-0 space-y-3" aria-busy={state.busy}>
        {props.payload && props.payload.eventId === view.link.eventId && props.payload.engineSessionId === view.link.engineSessionId && props.payload.value.slug === view.link.slug && <DesktopTriggerPayloadBlock payload={props.payload.value} />}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="break-words">Webhook · {view.link.slug}</span>
            <Button type="button" size="sm" variant="ghost" disabled={!active || state.busy} onClick={() => { void props.onOpenResult(triggerResultTarget(view.link)) }}>Open result chat</Button>
        </div>
        <p role="status" className="text-sm text-muted-foreground">{triggerRequestStatus(view)}</p>
        {state.error && <p role="alert" className="break-words text-sm text-destructive">{state.error}</p>}
        {unsettled && <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-sm text-muted-foreground">The saved outcome must be checked before a different answer or Stop. This never sends the webhook again.</p>
            <Button type="button" size="sm" variant="outline" disabled={!active || state.busy} onClick={() => { void state.reconcile().catch(() => {}) }}>Check saved outcome</Button>
        </div>}
        {request?.kind === 'question' && <DesktopQuestionCard question={request.value} disabled={locked && !(view.phase === 'uncertain' && !!request.value.attempt && active && !state.busy)} onAnswer={input => state.decide({ kind: 'question', input })} />}
        {request?.kind === 'approval' && <DesktopApprovalCard approval={request.value} disabled={locked && !(view.phase === 'uncertain' && !!request.value.attempt && active && !state.busy)} onDecide={input => state.decide({ kind: 'approval', input })} />}
        {request?.kind === 'takeover' && <DesktopTakeoverCard key={view.key} takeover={request.value} disabled={locked} screen={props.takeover?.screen} live={props.takeover?.live} onAction={async input => {
            if (input.action === 'done' || input.action === 'skip') await state.decide({ kind: 'takeover', input })
            else {
                if (!props.takeover) throw new Error('The browser lease authority is unavailable. No input permission was granted.')
                await props.takeover.onAction(request.value, input)
            }
        }} />}
        {request?.kind === 'service' && (props.onOpenApps ? <DesktopServiceRequestBlock agentId={view.link.agentId} sessionId={view.link.sessionId} request={request.value} disabled={locked} inline onOpenApps={props.onOpenApps} onAccepted={async result => {
            if (result.agentId !== view.link.agentId || result.sessionId !== view.link.sessionId || result.serviceRequestId !== view.link.requestId) { result.cancelStream(); throw new Error('App request owner changed') }
            await adopt(result.response)
        }} /> : <p role="status" className="text-sm text-muted-foreground">App setup navigation is unavailable. Open the exact result chat to continue.</p>)}
        {request?.kind === 'secret' && <DesktopSecretRequestBlock sessionId={view.link.sessionId} request={request.value} active={!locked} inline onAccepted={adopt} />}
        {request?.kind === 'signin' && <div className="rounded-lg border border-border px-4 pt-3 pb-4 text-sm">
            <p className="font-medium">Sign in to {request.value.name}</p>
            <p className="mt-1 text-muted-foreground">{request.value.reason}</p>
            <p role="status" className="mt-2 text-muted-foreground">Authenticated MCP sign-in continuation is unavailable. No sign-in, connection or continuation was assumed.</p>
        </div>}
        {view.phase === 'pending' && <Button type="button" size="sm" variant="ghost" disabled={!active || state.busy} onClick={() => { void state.stop().catch(() => {}) }}>Stop</Button>}
    </section>
}
export function DesktopWebhookHumanRequest(props: DesktopWebhookHumanRequestProps) {
    return <WebhookHumanRequest key={props.initial.key} {...props} />
}
