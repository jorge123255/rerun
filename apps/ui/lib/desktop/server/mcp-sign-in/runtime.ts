import 'server-only'
import type { DesktopMcpSignInDecision, DesktopMcpSignInOAuthView, DesktopMcpSignInRequestInput, DesktopMcpSignInResponse, DesktopMcpSignInSource, DesktopMcpSignInView } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { DesktopHttpError } from '../auth'
import { createDesktopMcpSignInContinuation, type DesktopMcpSignInContinuationPorts } from './service'
import type { DesktopMcpSignInAuthority, DesktopMcpSignInBrowserCapture, DesktopMcpSignInStore } from './store'

export type DesktopMcpSignInOAuthTarget = { requestId: string; attemptId?: string; source: DesktopMcpSignInSource }
export type DesktopMcpSignInOAuthPorts = {
    start: (target: DesktopMcpSignInOAuthTarget, signal: AbortSignal) => Promise<DesktopMcpSignInOAuthView>
    status: (target: DesktopMcpSignInOAuthTarget, signal: AbortSignal) => Promise<DesktopMcpSignInOAuthView>
    cancel: (target: DesktopMcpSignInOAuthTarget, signal: AbortSignal) => Promise<void>
    ready: (target: DesktopMcpSignInOAuthTarget, signal: AbortSignal) => Promise<void>
}
export type DesktopMcpSignInRuntimePorts = {
    store: DesktopMcpSignInStore
    captureBrowserApproval?: DesktopMcpSignInBrowserCapture
    source: (sessionId: string, signal: AbortSignal) => Promise<(DesktopMcpSignInRequestInput & { source: DesktopMcpSignInSource }) | null>
    authority: (source: DesktopMcpSignInSource, signal: AbortSignal, mode?: 'decision' | 'replay' | 'read' | 'dismiss') => Promise<DesktopMcpSignInAuthority>
    oauth: DesktopMcpSignInOAuthPorts
    send: DesktopMcpSignInContinuationPorts['send']
}
const target = (view: DesktopMcpSignInView): DesktopMcpSignInOAuthTarget => ({ requestId: view.requestId, attemptId: view.activeAttemptId, source: view.source })
export function createDesktopMcpSignInRuntimePorts(ports: DesktopMcpSignInRuntimePorts) {
    const continuation = createDesktopMcpSignInContinuation(ports.store, { send: ports.send })
    async function validate(input: DesktopMcpSignInDecision, signal: AbortSignal, active = false, mode: 'decision' | 'dismiss' = 'decision') {
        const authority = await ports.authority(input.source, signal, mode)
        authority.check(); signal.throwIfAborted()
        const request = await ports.store.validate(input, active)
        authority.check(); signal.throwIfAborted()
        return { request, authority }
    }
    return {
        async read(sessionId: string, signal: AbortSignal, options?: { metadataOnly?: boolean }): Promise<DesktopMcpSignInResponse> {
            const found = await ports.source(sessionId, signal)
            if (!found) return { request: null }
            const authority = await ports.authority(found.source, signal, 'read')
            const request = await ports.store.publish(found, authority)
            const oauth = request.receipt || options?.metadataOnly ? undefined : await ports.oauth.status(target(request), signal)
            authority.check(); signal.throwIfAborted()
            return { request, oauth }
        },
        async connect(input: DesktopMcpSignInDecision, signal: AbortSignal): Promise<DesktopMcpSignInResponse> {
            const authority = await ports.authority(input.source, signal)
            const begun = await ports.store.beginAttempt(input, authority, ports.captureBrowserApproval), request = begun.request
            authority.check(); signal.throwIfAborted()
            if (request.receipt) return { request }
            const activeInput = { ...input, source: request.source, expectedRevision: request.revision }
            if (!begun.created) return { request, oauth: await ports.oauth.status(target(request), signal) }
            try {
                const oauth = await ports.oauth.start(target(request), signal)
                await validate(activeInput, signal, true)
                return { request, oauth }
            } catch {
                // Only this still-active attempt may publish a failure; a late callback never changes its replacement.
                const current = await validate(activeInput, signal, true)
                return { request: await ports.store.fail(activeInput, 'Authorization failed.', current.authority), oauth: { state: 'error', message: 'Authorization unavailable. Start a new sign-in attempt.' } }
            }
        },
        async status(input: DesktopMcpSignInDecision, signal: AbortSignal): Promise<DesktopMcpSignInResponse> {
            const current = await validate(input, signal)
            const oauth = await ports.oauth.status(target(current.request), signal)
            await validate(input, signal)
            return { request: current.request, oauth }
        },
        async complete(input: DesktopMcpSignInDecision, signal: AbortSignal): Promise<Response> {
            let current = await validate(input, signal)
            if (!current.request.activeAttemptId && !current.request.receipt) {
                const begun = await ports.store.beginAttempt(input, current.authority)
                input = { ...input, expectedRevision: begun.request.revision }
                current = { ...current, request: begun.request }
            }
            current = await validate(input, signal, true)
            const oauth = await ports.oauth.status(target(current.request), signal)
            if (oauth.state !== 'connected') throw new DesktopHttpError(409, 'Finish authorization before continuing.')
            await ports.oauth.ready(target(current.request), signal)
            const final = await validate(input, signal, true)
            return continuation.complete(input, final.authority)
        },
        async decline(input: DesktopMcpSignInDecision, signal: AbortSignal): Promise<Response> {
            const current = await validate(input, signal, false, 'dismiss')
            if (current.request.activeAttemptId) await ports.oauth.cancel(target(current.request), signal)
            const final = await validate(input, signal, false, 'dismiss')
            const receipt = await ports.store.seal(input, 'declined', final.authority)
            current.authority.check()
            return continuation.deliverInitial(receipt, current.request.source, current.authority)
        },
        async cancel(input: DesktopMcpSignInDecision, signal: AbortSignal): Promise<DesktopMcpSignInResponse> {
            const current = await validate(input, signal, true)
            const request = await ports.store.cancel(input, current.authority)
            await ports.oauth.cancel(target(current.request), signal)
            current.authority.check(); signal.throwIfAborted()
            return { request, oauth: { state: 'idle' } }
        },
        async recover(input: DesktopMcpSignInDecision, signal: AbortSignal): Promise<Response> {
            const authority = await ports.authority(input.source, signal, 'replay')
            authority.check(); signal.throwIfAborted()
            return continuation.recover(input, authority)
        },
    }
}
export type DesktopMcpSignInRuntimeApi = ReturnType<typeof createDesktopMcpSignInRuntimePorts>
