import 'server-only'
import type { DesktopMcpSignInDecision, DesktopMcpSignInReceipt, DesktopMcpSignInSource, DesktopMcpSignInView } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { DesktopHttpError } from '../auth'
import type { DesktopMcpSignInAuthority, DesktopMcpSignInStore } from './store'

export type DesktopMcpSignInFollowUpResponse = {
    status: number
    code?: string
    sessionId: string | null
    runId: string | null
    contentType?: string | null
    body?: ReadableStream<Uint8Array> | null
}
export type DesktopMcpSignInContinuationPorts = {
    send: (receipt: DesktopMcpSignInReceipt & { requestId: string }, source: DesktopMcpSignInSource, mode: 'send' | 'replay') => Promise<DesktopMcpSignInFollowUpResponse>
}

function identified(receipt: DesktopMcpSignInReceipt & { requestId: string }, source: DesktopMcpSignInSource, response?: DesktopMcpSignInFollowUpResponse): Response {
    return new Response(response?.status === 200 && response.body ? response.body : 'data: [DONE]\n\n', {
        status: 200,
        headers: {
            'content-type': response?.contentType ?? 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1',
            'x-mcp-sign-in-request-id': receipt.requestId, 'x-session-id': source.sessionId, 'x-run-id': receipt.continuationRequestId,
        },
    })
}

export function createDesktopMcpSignInContinuation(store: DesktopMcpSignInStore, ports: DesktopMcpSignInContinuationPorts) {
    async function deliver(receipt: DesktopMcpSignInReceipt & { requestId: string }, source: DesktopMcpSignInSource, authority: DesktopMcpSignInAuthority, replayOnly = false): Promise<Response> {
        authority.check()
        if (receipt.accepted) return identified(receipt, source)
        for (const mode of (replayOnly ? ['replay'] : ['replay', 'send']) as ('replay' | 'send')[]) {
            let response: DesktopMcpSignInFollowUpResponse
            try { authority.check(); response = await ports.send(receipt, source, mode); authority.check() }
            catch { throw new DesktopHttpError(502, 'Could not confirm this MCP sign-in result. Retry the saved decision.') }
            if (response.status === 404 && response.code === 'queued_turn_not_found' && mode === 'replay') continue
            if (response.status === 403 || response.status === 409) throw new DesktopHttpError(response.status, 'This MCP sign-in result could not be admitted. Reload the conversation and retry the saved decision.')
            if ((response.status !== 200 && response.status !== 204) || response.sessionId !== source.sessionId || response.runId !== receipt.continuationRequestId) {
                throw new DesktopHttpError(502, 'Could not confirm this MCP sign-in result. Retry the saved decision.')
            }
            await store.markAccepted(receipt.requestId, receipt.continuationRequestId)
            return identified(receipt, source, response)
        }
        throw new DesktopHttpError(502, 'Could not send this MCP sign-in result. Retry the saved decision.')
    }
    return {
        deliverInitial: (receipt: DesktopMcpSignInReceipt & { requestId: string }, source: DesktopMcpSignInSource, authority: DesktopMcpSignInAuthority) => deliver(receipt, source, authority),
        async complete(input: DesktopMcpSignInDecision, authority: DesktopMcpSignInAuthority): Promise<Response> {
            const receipt = await store.seal(input, 'connected', authority)
            return deliver(receipt, input.source, authority)
        },
        async decline(input: DesktopMcpSignInDecision, authority: DesktopMcpSignInAuthority): Promise<Response> {
            const receipt = await store.seal(input, 'declined', authority)
            return deliver(receipt, input.source, authority)
        },
        async recover(input: DesktopMcpSignInDecision, authority: DesktopMcpSignInAuthority): Promise<Response> {
            authority.check()
            const receipt = await store.receipt(input)
            return deliver(receipt, input.source, authority, true)
        },
    }
}

export type DesktopMcpSignInAttention = {
    pending: boolean
    canMarkRead: boolean
    requestId?: string
    revision?: string
    toolCallId?: string
    agentId?: string
    sessionId?: string
    serverName?: string
    serverRevision?: string
    summary: string
}

export function desktopMcpSignInAttention(view: DesktopMcpSignInView | null): DesktopMcpSignInAttention {
    if (!view) return { pending: false, canMarkRead: true, summary: '' }
    return {
        pending: !view.receipt?.accepted,
        canMarkRead: !!view.receipt?.accepted,
        requestId: view.requestId, revision: view.revision, toolCallId: view.source.toolCallId,
        agentId: view.source.agentId, sessionId: view.source.sessionId,
        serverName: view.source.server.name, serverRevision: view.source.server.revision,
        summary: view.receipt?.summary ?? `Sign in to ${view.source.server.displayName}`,
    }
}

export function canMarkDesktopMcpSignInRead(view: DesktopMcpSignInView | null, expected: { requestId: string; revision: string }): boolean {
    return !!view?.receipt?.accepted && view.requestId === expected.requestId && view.revision === expected.revision
}
