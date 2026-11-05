import 'server-only'
import type { DesktopSecretRequestDecision, DesktopSecretRequestReceipt, DesktopSecretRequestSource, DesktopSecretRequestView } from '../../../../../../packages/contracts/src/desktop-secret-requests'
import { DesktopHttpError } from '../auth'
import type { DesktopSecretRequestAuthority, DesktopSecretRequestStore } from './store'

export type DesktopSecretFollowUpResponse = {
    status: number
    code?: string
    sessionId: string | null
    runId: string | null
    contentType?: string | null
    body?: ReadableStream<Uint8Array> | null
}

export type DesktopSecretContinuationPorts = {
    send: (receipt: DesktopSecretRequestReceipt & { requestId: string }, source: DesktopSecretRequestSource, mode: 'send' | 'replay') => Promise<DesktopSecretFollowUpResponse>
}

function identified(receipt: DesktopSecretRequestReceipt & { requestId: string }, source: DesktopSecretRequestSource, response?: DesktopSecretFollowUpResponse): Response {
    const headers = new Headers({
        'content-type': response?.contentType ?? 'text/event-stream',
        'x-vercel-ai-ui-message-stream': 'v1',
        'x-secret-request-id': receipt.requestId,
        'x-session-id': source.sessionId,
        'x-run-id': receipt.continuationRequestId,
    })
    return new Response(response?.status === 200 && response.body ? response.body : 'data: [DONE]\n\n', { status: 200, headers })
}

export function createDesktopSecretRequestContinuation(store: DesktopSecretRequestStore, ports: DesktopSecretContinuationPorts) {
    async function deliver(receipt: DesktopSecretRequestReceipt & { requestId: string }, source: DesktopSecretRequestSource): Promise<Response> {
        if (receipt.accepted) return identified(receipt, source)
        for (const mode of ['replay', 'send'] as const) {
            let response: DesktopSecretFollowUpResponse
            try { response = await ports.send(receipt, source, mode) }
            catch { throw new DesktopHttpError(502, 'Could not confirm this credential result. Retry the same decision.') }
            if (response.status === 404 && response.code === 'queued_turn_not_found' && mode === 'replay') continue
            if (response.status === 403 || response.status === 409) throw new DesktopHttpError(response.status, 'This credential result could not be admitted. Reload the conversation and retry the saved decision.')
            if ((response.status !== 200 && response.status !== 204) || response.sessionId !== source.sessionId || response.runId !== receipt.continuationRequestId) {
                throw new DesktopHttpError(502, 'Could not confirm this credential result. Retry the same decision.')
            }
            await store.markAccepted(receipt.requestId, receipt.continuationRequestId)
            return identified(receipt, source, response)
        }
        throw new DesktopHttpError(502, 'Could not send this credential result. Retry the same decision.')
    }
    return {
        async decide(input: DesktopSecretRequestDecision, authority: DesktopSecretRequestAuthority): Promise<Response> {
            const receipt = await store.decide(input, authority)
            return deliver(receipt, input.source)
        },
        async recover(input: DesktopSecretRequestDecision, authority: DesktopSecretRequestAuthority): Promise<Response> {
            const receipt = await store.decide(input, authority)
            return deliver(receipt, input.source)
        },
    }
}

export type DesktopSecretRequestAttention = {
    pending: boolean
    canMarkRead: boolean
    requestId?: string
    revision?: string
    toolCallId?: string
    summary: string
}

export function desktopSecretRequestAttention(view: DesktopSecretRequestView | null): DesktopSecretRequestAttention {
    if (!view) return { pending: false, canMarkRead: true, summary: '' }
    const first = view.fields[0]
    const summary = view.receipt?.summary ?? `Needs ${first.label}${view.fields.length > 1 ? ` (+${view.fields.length - 1} more)` : ''}`
    return {
        pending: view.status !== 'accepted',
        canMarkRead: view.status === 'accepted',
        requestId: view.requestId,
        revision: view.revision,
        toolCallId: view.source.toolCallId,
        summary,
    }
}

export function canMarkDesktopSecretRequestRead(view: DesktopSecretRequestView | null, expected: { requestId: string; revision: string }): boolean {
    return view?.status === 'accepted' && view.requestId === expected.requestId && view.revision === expected.revision
}
