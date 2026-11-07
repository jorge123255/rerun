import { abortable } from '../web-fetch/transport.js'
import { loginRequestSchema, loginResponseSchema, safeVerificationUri, type DeviceView, type LoginIdentity, type LoginRequest, type LoginResponse } from './contract.js'

type Registration = { name: string; revision: string; url: string; transport?: 'http' | 'sse'; hasBearer: boolean }
type Target = { owner: string; identity: LoginIdentity; name: string; revision: string; url: string }

/** Must bind to the canonical human decision, encrypted custody and durable attempt receipts. */
export type ApprovedDeviceFallback = {
    authorize(target: Target, signal: AbortSignal): Promise<{ approvalId: string } | null>
    start(target: Target & { approvalId: string; requestId: string }, signal: AbortSignal): Promise<DeviceView>
    complete(target: Target & { approvalId: string; requestId: string }, signal: AbortSignal): Promise<DeviceView>
}

export type RemoteLoginService = {
    authorizeRun(identity: LoginIdentity, signal: AbortSignal, grant: 'mcp'): Promise<string>
    shutdownSignal: AbortSignal
    store: {
        list(owner: string): Promise<Registration[]>
        lifecycle: { watch(owner: string, name: string): () => void }
    }
    runtime: { probe(owner: string, name: string, revision: string, signal: AbortSignal): Promise<{ tools?: { name: string }[] }> }
}

function modelNames(server: string, tools: { name: string }[]): string[] {
    if (tools.length > 256) throw new Error('MCP tool count exceeds limit')
    const names = tools.map(tool => `${server}_${tool.name}`)
    if (new Set(names).size !== names.length || names.some(name => !/^[\w.-]{1,128}$/.test(name))) throw new Error('Invalid MCP tool names')
    return names
}

/** Uses the existing remote-MCP store and probe; never reads tokens or creates a second connection pool. */
export function createDesktopMcpLoginBackend(service: RemoteLoginService, watchOwner: (owner: string) => () => void, device?: ApprovedDeviceFallback) {
    return async function dispatch(raw: unknown, stop: AbortSignal): Promise<LoginResponse> {
        const request: LoginRequest = loginRequestSchema.parse(raw)
        const signal = AbortSignal.any([stop, service.shutdownSignal, AbortSignal.timeout(60_000)])
        signal.throwIfAborted()
        const owner = await abortable(service.authorizeRun(request.identity, signal, 'mcp'), signal)
        const ownerCurrent = watchOwner(owner)
        async function guard(server?: Registration, current?: () => void) {
            signal.throwIfAborted(); ownerCurrent(); current?.()
            if (await abortable(service.authorizeRun(request.identity, signal, 'mcp'), signal) !== owner) throw new Error('MCP owner changed')
            signal.throwIfAborted(); ownerCurrent(); current?.()
            if (server) {
                const latest = (await abortable(service.store.list(owner), signal)).find(row => row.name === server.name)
                signal.throwIfAborted(); ownerCurrent(); current?.()
                if (!latest || latest.revision !== server.revision || latest.url !== server.url || latest.transport !== server.transport || latest.hasBearer !== server.hasBearer) throw new Error('MCP registration changed')
            }
        }
        await guard()
        const servers = await abortable(service.store.list(owner), signal)
        await guard()
        if (servers.length > 16 || new Set(servers.map(row => row.name)).size !== servers.length) throw new Error('MCP inventory exceeds limit')
        const guards = servers.map(server => service.store.lifecycle.watch(owner, server.name))
        const listIdentity = JSON.stringify(servers.map(row => [row.name, row.revision, row.url, row.transport, row.hasBearer]))
        async function finalGuard() {
            await guard()
            const latest = await abortable(service.store.list(owner), signal)
            signal.throwIfAborted(); ownerCurrent(); guards.forEach(check => check())
            if (JSON.stringify(latest.map(row => [row.name, row.revision, row.url, row.transport, row.hasBearer])) !== listIdentity) throw new Error('MCP inventory changed')
            await guard()
            guards.forEach(check => check())
        }
        let result: LoginResponse['result']
        if (request.action === 'status') {
            const rows: Extract<LoginResponse['result'], { action: 'status' }>['servers'] = []
            for (let index = 0; index < servers.length; index++) {
                const server = servers[index]!, current = guards[index]!
                await guard(server, current)
                if (server.transport === 'sse') {
                    rows.push({ name: server.name, revision: server.revision, transport: 'sse', status: 'unavailable', tools: [], reason: 'transport_unavailable' })
                    continue
                }
                let names: string[] | null = null
                try {
                    const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
                    const probe = await abortable(service.runtime.probe(owner, server.name, server.revision, probeSignal), probeSignal)
                    if (!Array.isArray(probe.tools)) throw new Error('Probe returned no tool inventory')
                    names = modelNames(server.name, probe.tools)
                } catch { signal.throwIfAborted() }
                await guard(server, current)
                rows.push(names ? { name: server.name, revision: server.revision, transport: 'http', status: 'connected', tools: names }
                    : { name: server.name, revision: server.revision, transport: 'http', status: 'failed', tools: [], reason: 'probe_failed' })
            }
            result = { action: 'status', servers: rows }
        } else {
            const index = servers.findIndex(row => row.name === request.name)
            const server = servers[index]
            if (!server) throw new Error('MCP server is not registered')
            const current = guards[index]!
            await guard(server, current)
            let view: DeviceView = { state: request.action === 'complete' ? 'no_pending' : 'unsupported' }
            if (device && server.transport !== 'sse' && !server.hasBearer) {
                const target = { owner, identity: request.identity, name: server.name, revision: server.revision, url: server.url }
                const approval = await abortable(device.authorize(target, signal), signal)
                await guard(server, current)
                if (!approval || !approval.approvalId || approval.approvalId.length > 256) view = { state: 'approval_required' }
                else {
                    const effect = { ...target, approvalId: approval.approvalId, requestId: request.toolCallId }
                    // The bound authority owns reservation, exact-payload replay and unknown outcomes; never retry here.
                    view = await abortable(request.action === 'start' ? device.start(effect, signal) : device.complete(effect, signal), signal)
                    await guard(server, current)
                    if (view.state === 'waiting') view = { ...view, verificationUri: safeVerificationUri(view.verificationUri) }
                    if (view.state === 'connected') {
                        try {
                            const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
                            const probe = await abortable(service.runtime.probe(owner, server.name, server.revision, probeSignal), probeSignal)
                            if (!Array.isArray(probe.tools)) throw new Error('Probe returned no tools')
                            view = { state: 'connected', tools: modelNames(server.name, probe.tools) }
                        } catch { signal.throwIfAborted(); view = { state: 'failed' } }
                        await guard(server, current)
                    }
                }
            }
            result = { action: request.action, name: server.name, view }
        }
        await finalGuard()
        const response = loginResponseSchema.parse({ identity: request.identity, toolCallId: request.toolCallId, result })
        if (Buffer.byteLength(JSON.stringify(response)) > 90_000) throw new Error('MCP status exceeds limit')
        return response
    }
}
