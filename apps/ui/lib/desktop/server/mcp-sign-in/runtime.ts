import 'server-only'
import type { DesktopMcpSignInDecision, DesktopMcpSignInOAuthView, DesktopMcpSignInRequestInput, DesktopMcpSignInResponse, DesktopMcpSignInServer, DesktopMcpSignInSource } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { DesktopHttpError } from '../auth'
import { createDesktopMcpSignInContinuation, type DesktopMcpSignInContinuationPorts } from './service'
import type { DesktopMcpSignInAuthority, DesktopMcpSignInStore } from './store'

export type DesktopMcpSignInOAuthPorts = {
    start: (server: DesktopMcpSignInServer, signal: AbortSignal) => Promise<DesktopMcpSignInOAuthView>
    status: (server: DesktopMcpSignInServer, signal: AbortSignal) => Promise<DesktopMcpSignInOAuthView>
    cancel: (server: DesktopMcpSignInServer, signal: AbortSignal) => Promise<void>
}

export type DesktopMcpSignInRuntimePorts = {
    store: DesktopMcpSignInStore
    source: (sessionId: string, signal: AbortSignal) => Promise<(DesktopMcpSignInRequestInput & { source: DesktopMcpSignInSource }) | null>
    authority: (sessionId: string) => DesktopMcpSignInAuthority
    oauth: DesktopMcpSignInOAuthPorts
    send: DesktopMcpSignInContinuationPorts['send']
}

export function createDesktopMcpSignInRuntimePorts(ports: DesktopMcpSignInRuntimePorts) {
    const continuation = createDesktopMcpSignInContinuation(ports.store, { send: ports.send })
    const authority = (sessionId: string, signal: AbortSignal): DesktopMcpSignInAuthority => {
        const current = ports.authority(sessionId)
        return { check: () => { signal.throwIfAborted(); current.check() } }
    }
    const ready = async (input: DesktopMcpSignInDecision, signal: AbortSignal): Promise<DesktopMcpSignInAuthority> => {
        const status = await ports.oauth.status(input.source.server, signal)
        if (status.state !== 'connected') throw new DesktopHttpError(409, 'This MCP server is not connected. Finish authorization before continuing.')
        return authority(input.source.sessionId, signal)
    }
    return {
        async read(sessionId: string, signal: AbortSignal): Promise<DesktopMcpSignInResponse> {
            const source = await ports.source(sessionId, signal)
            return { request: source ? await ports.store.publish(source) : null }
        },
        async connect(input: DesktopMcpSignInDecision, signal: AbortSignal): Promise<DesktopMcpSignInResponse> {
            try {
                const request = await ports.store.begin(input, authority(input.source.sessionId, signal))
                if (request.receipt) return { request }
                const oauth = await ports.oauth.start(input.source.server, signal)
                return { request: (await ports.store.read(input.requestId))!, oauth }
            } catch (cause) {
                const request = await ports.store.fail(input, cause instanceof Error ? cause.message : 'Authorization failed. Retry.')
                return { request, oauth: { state: 'error', message: 'Authorization unavailable. Check this coworker’s MCP permission and retry.' } }
            }
        },
        async status(input: DesktopMcpSignInDecision, signal: AbortSignal): Promise<DesktopMcpSignInResponse> {
            const [request, oauth] = await Promise.all([ports.store.read(input.requestId), ports.oauth.status(input.source.server, signal)])
            return { request, oauth }
        },
        async complete(input: DesktopMcpSignInDecision, signal: AbortSignal): Promise<Response> {
            return continuation.complete(input, await ready(input, signal))
        },
        async decline(input: DesktopMcpSignInDecision, signal: AbortSignal): Promise<Response> {
            return continuation.decline(input, authority(input.source.sessionId, signal))
        },
        async cancel(input: DesktopMcpSignInDecision, signal: AbortSignal): Promise<DesktopMcpSignInResponse> {
            await ports.oauth.cancel(input.source.server, signal)
            return { request: await ports.store.cancel(input), oauth: { state: 'idle' } }
        },
        async recover(input: DesktopMcpSignInDecision): Promise<Response> {
            return continuation.recover(input)
        },
    }
}

export type DesktopMcpSignInRuntimeApi = ReturnType<typeof createDesktopMcpSignInRuntimePorts>
