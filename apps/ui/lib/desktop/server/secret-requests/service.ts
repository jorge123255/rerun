import 'server-only'
import type { DesktopSecretRequestDecision, DesktopSecretRequestRecovery, DesktopSecretRequestReceipt, DesktopSecretRequestSource, DesktopSecretRequestView } from '@rerun/contracts'
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
    send: (receipt: DesktopSecretRequestReceipt & { requestId: string }, source: DesktopSecretRequestSource, mode: 'send' | 'replay', authority: DesktopSecretRequestAuthority) => Promise<DesktopSecretFollowUpResponse>
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
    async function deliver(receipt: DesktopSecretRequestReceipt & { requestId: string }, source: DesktopSecretRequestSource, authority: DesktopSecretRequestAuthority, replayOnly = false): Promise<Response> {
        await authority.check()
        if (receipt.accepted) {
            await store.markAccepted(receipt.requestId, receipt.continuationRequestId, authority)
            return identified(receipt, source)
        }
        const modes: Array<'replay' | 'send'> = replayOnly ? ['replay'] : ['replay', 'send']
        for (const mode of modes) {
            let response: DesktopSecretFollowUpResponse
            await authority.check()
            try { response = await ports.send(receipt, source, mode, authority) }
            catch { throw new DesktopHttpError(502, 'Could not confirm this credential result. Retry the same decision.') }
            if (response.status === 404 && response.code === 'queued_turn_not_found' && mode === 'replay') continue
            if (response.status === 403 || response.status === 409) throw new DesktopHttpError(response.status, 'This credential result could not be admitted. Reload the conversation and retry the saved decision.')
            if ((response.status !== 200 && response.status !== 204) || (response.status === 200 && !response.body) || response.sessionId !== source.sessionId || response.runId !== receipt.continuationRequestId) {
                throw new DesktopHttpError(502, 'Could not confirm this credential result. Retry the same decision.')
            }
            await authority.check()
            await store.markAccepted(receipt.requestId, receipt.continuationRequestId, authority)
            return identified(receipt, source, response)
        }
        throw new DesktopHttpError(502, 'Could not send this credential result. Retry the same decision.')
    }
    return {
        async decide(input: DesktopSecretRequestDecision, authority: DesktopSecretRequestAuthority, continuationAuthority = authority): Promise<Response> {
            const existing = await store.read(input.requestId)
            const receipt = await store.decide(input, authority)
            return deliver(receipt, input.source, continuationAuthority, !!existing?.receipt)
        },
        async recover(input: DesktopSecretRequestRecovery, authority: DesktopSecretRequestAuthority, continuationAuthority = authority): Promise<Response> {
            const recovered = await store.recover(input, authority)
            return deliver(recovered.receipt, input.source, continuationAuthority, recovered.replayOnly)
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
