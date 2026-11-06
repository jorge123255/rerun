import 'server-only'
import { createHash } from 'node:crypto'
import {
    DESKTOP_MCP_SSE_LIMITS as L, desktopMcpSseRefSchema, desktopMcpSseRequestSchema, desktopMcpSseCallSchema,
    type DesktopMcpSseRef, type DesktopMcpSseRequest, type DesktopMcpSseSnapshot, type DesktopMcpSseOutcome, type DesktopMcpSseCall, type DesktopMcpSseTool,
} from '@rerun/contracts'
import type { McpRunIdentity } from '../mcp/bridge'
import { endpoint } from '../mcp/model'
import { createLegacySseConnection } from './connection'
import { sseEndpointDisplay } from './endpoint'
import { SseFailure, safeFailure, wait } from './errors'
import { boundedJson } from './validation'
import type { SseAuthority, SseDependencies, SseTicket } from './types'

export type SseEntry = {
    key: string; ref: DesktopMcpSseRef; controller: AbortController; ticket: SseTicket
    opening: Promise<DesktopMcpSseTool[]>; connection?: ReturnType<typeof createLegacySseConnection>
    authority?: SseAuthority; display: string; tools: DesktopMcpSseTool[]; users: Set<string>; drain?: Promise<void>
    ready: boolean; released: boolean
}
export type SsePoolState = { entries: Map<string, SseEntry>; retired: Set<SseEntry>; closed: boolean }
export const createSsePoolState = (): SsePoolState => ({ entries: new Map(), retired: new Set(), closed: false })
const slot = (ref: DesktopMcpSseRef) => JSON.stringify([ref.agentId, ref.serverId])
const runKey = (run: McpRunIdentity) => JSON.stringify([run.engineAgentId, run.sessionId, run.runId])
const reference = (value: DesktopMcpSseRef): DesktopMcpSseRef => ({ agentId: value.agentId, serverId: value.serverId, name: value.name, expectedRevision: value.expectedRevision })
const uncertain = (call: DesktopMcpSseCall, error: unknown): DesktopMcpSseOutcome => ({
    requestId: call.requestId, status: 'uncertain', failure: safeFailure(error).code,
    message: 'The tool may have run; its acknowledgement is unknown. Inspect the outcome. Never automatically retry this attempt.',
})

export function createSseRuntime(deps: SseDependencies, pool: SsePoolState) {
    async function authorize(ref: DesktopMcpSseRef, action: 'read' | 'use' | 'call' | 'close', signal: AbortSignal, run?: McpRunIdentity) {
        ref = reference(ref)
        const result = await wait(deps.authorize({ ref, action, run }, signal), signal)
        signal.throwIfAborted(); result.check()
        if (result.server.id !== ref.serverId || result.server.name !== ref.name || result.server.revision !== ref.expectedRevision || result.server.transport !== 'sse'
            || !result.credentialGeneration || result.server.url.length > L.endpointChars || endpoint(result.server.url) !== result.server.url) throw new SseFailure('changed')
        return result
    }
    function snapshot(entry: SseEntry, state: DesktopMcpSseSnapshot['state'], error?: unknown): DesktopMcpSseSnapshot {
        const failure = error ? safeFailure(error) : undefined
        return { ...entry.ref, transport: 'sse', endpointDisplay: entry.display, state,
            observation: 'live',
            tools: state === 'connected' ? entry.tools : [], ...(failure ? { failure: failure.code, message: failure.message } : {}) }
    }
    async function retire(entry: SseEntry) {
        if (entry.released) return
        pool.retired.add(entry)
        if (pool.entries.get(entry.key) === entry) pool.entries.delete(entry.key)
        entry.controller.abort()
        if (!entry.drain) {
            const work = (async () => {
                await wait(entry.opening.catch(() => []), AbortSignal.timeout(L.closeMs))
                await entry.connection?.drain()
                entry.ticket.release(); entry.released = true; pool.retired.delete(entry)
            })()
            entry.drain = work
            void work.catch(() => { if (entry.drain === work) entry.drain = undefined })
        }
        return entry.drain
    }
    async function guard(entry: SseEntry, signal: AbortSignal, run?: McpRunIdentity) {
        entry.ticket.assertCurrent(); signal.throwIfAborted()
        if (pool.closed || pool.entries.get(entry.key) !== entry) throw new SseFailure('changed')
        const current = await authorize(entry.ref, run ? 'call' : 'use', signal, run)
        entry.ticket.assertCurrent(); signal.throwIfAborted()
        if (entry.authority && (current.server.url !== entry.authority.server.url || current.credentialGeneration !== entry.authority.credentialGeneration)) throw new SseFailure('changed')
        return current
    }
    function begin(ref: DesktopMcpSseRef, scopeKey = slot(ref), run?: McpRunIdentity) {
        run = run ? { ...run } : undefined
        ref = reference(ref)
        if (pool.closed || pool.entries.size + pool.retired.size >= L.connections) throw new SseFailure('unavailable')
        const controller = new AbortController(), ticket = deps.lifecycle.admit(ref.agentId, ref.name, controller)
        const entry: SseEntry = { key: scopeKey, ref, controller, ticket, display: '', tools: [], users: new Set(), ready: false, released: false, opening: undefined as unknown as SseEntry['opening'] }
        pool.entries.set(scopeKey, entry)
        entry.opening = Promise.resolve().then(async () => {
            const signal = AbortSignal.any([controller.signal, deps.shutdownSignal, AbortSignal.timeout(L.connectMs)])
            const authority = await guard(entry, signal, run)
            entry.authority = authority; entry.display = sseEndpointDisplay(authority.server.url)
            const connection = createLegacySseConnection({ ref, authority, deps, signal: controller.signal, guard: stop => guard(entry, stop, run), onFailure: () => controller.abort() })
            entry.connection = connection
            const tools = await connection.open(signal)
            await guard(entry, signal, run); entry.tools = tools; entry.ready = true
            return tools
        })
        controller.signal.addEventListener('abort', () => { void retire(entry).catch(() => {}) }, { once: true })
        void entry.opening.catch(() => { void retire(entry).catch(() => {}) })
        return entry
    }
    async function acquire(ref: DesktopMcpSseRef, signal: AbortSignal, run?: McpRunIdentity) {
        signal.throwIfAborted()
        const key = run ? JSON.stringify([slot(ref), 'run', runKey(run)]) : slot(ref)
        for (const old of [...pool.retired].filter(entry => entry.key === key)) await retire(old)
        signal.throwIfAborted()
        let entry = pool.entries.get(key)
        if (entry && (entry.ref.name !== ref.name || entry.ref.expectedRevision !== ref.expectedRevision || entry.connection?.failure())) { await retire(entry); entry = undefined }
        if (entry?.authority) {
            const current = await authorize(reference(ref), run ? 'call' : 'use', signal, run)
            if (current.server.url !== entry.authority.server.url) { await retire(entry); throw new SseFailure('changed') }
            if (current.credentialGeneration !== entry.authority.credentialGeneration) { await retire(entry); entry = undefined }
        }
        entry ??= begin(ref, key, run)
        if (run) entry.users.add(runKey(run))
        try { await wait(entry.opening, signal); await guard(entry, signal, run); return entry }
        catch (error) { await retire(entry).catch(() => {}); throw error }
    }
    async function connect(input: DesktopMcpSseRequest, stop: AbortSignal): Promise<DesktopMcpSseSnapshot> {
        const request = desktopMcpSseRequestSchema.parse(input), signal = AbortSignal.any([stop, deps.shutdownSignal, AbortSignal.timeout(L.connectMs)])
        if (request.operation !== 'connect') throw new SseFailure('unsupported')
        const entry = await acquire(request, signal)
        await guard(entry, signal)
        return snapshot(entry, 'connected')
    }
    async function status(input: DesktopMcpSseRef, stop: AbortSignal): Promise<DesktopMcpSseSnapshot> {
        const ref = desktopMcpSseRefSchema.parse(input), signal = AbortSignal.any([stop, deps.shutdownSignal, AbortSignal.timeout(L.connectMs)])
        const authority = await authorize(ref, 'read', signal)
        const entry = pool.entries.get(slot(ref)) ?? [...pool.entries.values(), ...pool.retired].find(item => slot(item.ref) === slot(ref))
        if (!entry) return { ...ref, transport: 'sse', endpointDisplay: sseEndpointDisplay(authority.server.url), state: 'unchecked', tools: [], observation: 'saved' }
        if (pool.retired.has(entry)) return snapshot(entry, 'closing', new SseFailure('close-unconfirmed'))
        if (entry.authority && (entry.authority.credentialGeneration !== authority.credentialGeneration || entry.ref.expectedRevision !== ref.expectedRevision || entry.authority.server.url !== authority.server.url)) {
            await retire(entry); return { ...ref, transport: 'sse', endpointDisplay: sseEndpointDisplay(authority.server.url), state: 'disconnected', tools: [] }
        }
        const failure = entry.connection?.failure()
        if (failure) return snapshot(entry, failure.code === 'auth-needed' ? 'needs_auth' : failure.code === 'unsupported' ? 'unsupported' : 'error', failure)
        return snapshot(entry, entry.ready ? 'connected' : 'connecting')
    }
    async function disconnect(input: DesktopMcpSseRequest, stop: AbortSignal): Promise<DesktopMcpSseSnapshot> {
        const ref = desktopMcpSseRequestSchema.parse(input)
        if (ref.operation !== 'disconnect') throw new SseFailure('unsupported')
        const authority = await authorize(ref, 'close', AbortSignal.any([stop, AbortSignal.timeout(L.connectMs)]))
        const selected = [...new Set([...pool.entries.values(), ...pool.retired])].filter(entry => slot(entry.ref) === slot(ref) && entry.ref.expectedRevision === ref.expectedRevision && entry.ref.name === ref.name)
        try { await Promise.all(selected.map(retire)) }
        catch { return { ...reference(ref), transport: 'sse', endpointDisplay: sseEndpointDisplay(authority.server.url), state: 'closing', tools: [], failure: 'close-unconfirmed', message: new SseFailure('close-unconfirmed').message } }
        return { ...reference(ref), transport: 'sse', endpointDisplay: sseEndpointDisplay(authority.server.url), state: 'disconnected', tools: [],
            message: 'Local SSE connection closed. A dispatched remote tool may still be running; its attempt will not be replayed.' }
    }
    async function probe(input: DesktopMcpSseRequest, stop: AbortSignal) {
        const request = desktopMcpSseRequestSchema.parse(input), signal = AbortSignal.any([stop, deps.shutdownSignal, AbortSignal.timeout(L.connectMs)])
        if (request.operation !== 'probe') throw new SseFailure('unsupported')
        await authorize(request, 'use', signal)
        for (const old of [...pool.retired].filter(entry => slot(entry.ref) === slot(request))) await retire(old)
        const key = JSON.stringify([slot(request), 'probe', request.requestId])
        if (pool.entries.has(key)) throw new SseFailure('unavailable')
        const entry = begin(request, key)
        try {
            await wait(entry.opening, signal)
            const result = { ...snapshot(entry, 'connected'), observation: 'probe' as const }
            await retire(entry)
            const final = await authorize(request, 'use', signal)
            if (final.server.url !== entry.authority?.server.url || final.credentialGeneration !== entry.authority?.credentialGeneration) throw new SseFailure('changed')
            return result
        }
        catch (error) { await retire(entry).catch(() => {}); throw safeFailure(error) }
    }
    async function call(input: DesktopMcpSseCall, run: McpRunIdentity, stop: AbortSignal): Promise<DesktopMcpSseOutcome> {
        const call = desktopMcpSseCallSchema.parse(input), signal = AbortSignal.any([stop, deps.shutdownSignal, AbortSignal.timeout(L.requestMs)])
        if (run.runId !== call.runId || run.sessionId !== call.sessionId) throw new SseFailure('changed')
        const ref = desktopMcpSseRefSchema.parse({ agentId: call.agentId, serverId: call.serverId, name: call.name, expectedRevision: call.expectedRevision })
        boundedJson(call.arguments, L.requestBytes)
        await authorize(ref, 'call', signal, run)
        const digest = createHash('sha256').update(boundedJson(call, L.requestBytes + 4096)).digest('hex')
        try { if (await wait(deps.ledger.claim(call, digest, signal), signal) !== 'new') return uncertain(call, new SseFailure('changed')) }
        catch (error) { return uncertain(call, error) }
        let entry: SseEntry | undefined
        const cancel = () => entry?.controller.abort()
        signal.addEventListener('abort', cancel, { once: true })
        let outcome: DesktopMcpSseOutcome
        try {
            entry = await acquire(ref, signal, run)
            await guard(entry, signal, run)
            if (!entry.tools.some(tool => tool.name === call.tool)) throw new SseFailure('changed')
            const result = await entry.connection!.call(call.tool, call.arguments, signal, async current => { await guard(entry!, current, run) })
            await guard(entry, signal, run)
            outcome = { requestId: call.requestId, status: 'completed', result }
        } catch (error) {
            if (entry) await retire(entry).catch(() => {})
            outcome = uncertain(call, error)
        } finally { signal.removeEventListener('abort', cancel) }
        // The durable claim is retained even if settlement or the caller's acknowledgement fails.
        try { await wait(deps.ledger.settle(call, digest, outcome), AbortSignal.timeout(L.closeMs)) }
        catch { return uncertain(call, new SseFailure('unavailable')) }
        if (signal.aborted) return uncertain(call, new SseFailure('cancelled'))
        try { if (entry) await guard(entry, signal, run) } catch (error) { if (entry) await retire(entry).catch(() => {}); return uncertain(call, error) }
        return outcome
    }
    async function dispose(agentId?: string, serverId?: string) {
        const selected = [...new Set([...pool.entries.values(), ...pool.retired])].filter(entry => (!agentId || entry.ref.agentId === agentId) && (!serverId || entry.ref.serverId === serverId))
        const results = await Promise.allSettled(selected.map(retire))
        if (results.some(result => result.status === 'rejected')) throw new SseFailure('close-unconfirmed')
    }
    return { connect, probe, status, disconnect, call, dispose,
        async tools(ref: DesktopMcpSseRef, run: McpRunIdentity, signal: AbortSignal) {
            await authorize(ref, 'call', signal, run)
            const entry = await acquire(ref, signal, run)
            await guard(entry, signal, run)
            return snapshot(entry, 'connected')
        },
        async releaseRun(agentId: string, run: McpRunIdentity) {
            await Promise.all([...new Set([...pool.entries.values(), ...pool.retired])].filter(entry => entry.ref.agentId === agentId && entry.users.has(runKey(run))).map(retire))
        },
        async shutdown() { pool.closed = true; await dispose() },
    }
}
