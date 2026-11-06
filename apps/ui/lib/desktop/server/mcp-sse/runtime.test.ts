import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSseRuntime, createSsePoolState } from './runtime'
import { SseFailure } from './errors'
import type { SseDependencies, SseWireRequest, SseWireResponse } from './types'
import type { DesktopMcpSseRef, DesktopMcpSseCall } from '../../../../../../packages/contracts/src/desktop-mcp-sse'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map(close => close())) })
function fixture() {
    const ref: DesktopMcpSseRef = { agentId: 'local-owner', serverId: 'server-id', name: 'sample', expectedRevision: 'rev-1' }
    const run = { engineAgentId: 'engine-private', sessionId: 'session', runId: 'run' }
    const wires: SseWireRequest[] = [], tickets: AbortController[] = [], claims = new Map<string, string>()
    const streams = new Map<string, { controller: ReadableStreamDefaultController<Uint8Array>; closed: boolean }>()
    let generation = 'credential-1', allowed = true, effects = 0, holdCall = false, closeFails = false, catalog: unknown[] = [{ name: 'echo', inputSchema: { type: 'object' } }], streamNumber = 0
    const send = (session: string, value: unknown) => {
        const stream = streams.get(session)
        if (stream && !stream.closed) stream.controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(value)}\n\n`))
    }
    const deps: SseDependencies = {
        authorize: vi.fn(async scope => {
            const correctOwner = scope.ref.agentId === ref.agentId && scope.ref.serverId === ref.serverId || scope.ref.agentId === 'owner-b' && scope.ref.serverId === 'server-b'
            if (!allowed || !correctOwner || scope.ref.expectedRevision !== ref.expectedRevision
                || scope.run && (scope.run.engineAgentId !== run.engineAgentId || scope.run.runId !== run.runId || scope.run.sessionId !== run.sessionId)) throw new SseFailure('changed')
            return { server: { id: scope.ref.serverId, name: ref.name, revision: ref.expectedRevision, transport: 'sse', url: 'https://example.com/sse', hasBearer: true },
                credentialGeneration: generation, credentialHandle: {}, check() {} }
        }),
        lifecycle: { admit(_agent, _name, controller) { tickets.push(controller); return { assertCurrent() { controller.signal.throwIfAborted() }, release: vi.fn() } } },
        protect: value => JSON.parse(JSON.stringify(value).split('fixture-bearer').join('[REDACTED]')),
        normalizeTool: tool => ({ ...tool, inputSchema: { ...tool.inputSchema, type: 'object' } }),
        ledger: { claim: async (call, digest) => { const key = JSON.stringify([call.agentId, call.serverId, call.runId, call.toolCallId]); if (claims.has(key)) return 'existing'; claims.set(key, digest); return 'new' }, settle: vi.fn(async () => {}) },
        shutdownSignal: new AbortController().signal,
        network: async input => {
            await input.guard(); wires.push(input)
            if (input.method === 'GET') {
                const session = `fixture_session_${++streamNumber}`.padEnd(24, 'x')
                let stream!: { controller: ReadableStreamDefaultController<Uint8Array>; closed: boolean }
                const body = new ReadableStream<Uint8Array>({ start(controller) { stream = { controller, closed: false }; streams.set(session, stream); controller.enqueue(new TextEncoder().encode(`event: endpoint\r\ndata: /messages?sessionId=${session}\r\n\r\n`)) }, cancel() { stream.closed = true } })
                return { status: 200, contentType: 'text/event-stream', body, async close() { if (closeFails) throw new Error('close not acknowledged'); if (!stream.closed) { stream.closed = true; stream.controller.close() } } }
            }
            const request = JSON.parse(input.body!), session = new URL(input.url).searchParams.get('sessionId')!
            if (request.method === 'initialize') send(session, { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } })
            else if (request.method === 'tools/list') send(session, { jsonrpc: '2.0', id: request.id, result: { tools: catalog } })
            else if (request.method === 'tools/call') { effects++; if (!holdCall) send(session, { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: `fixture-bearer ${session}` }] } }) }
            return { status: 202, contentType: 'text/plain', body: null, close: async () => { if (closeFails) throw new Error('close not acknowledged') } }
        },
    }
    const pool = createSsePoolState(), runtime = createSseRuntime(deps, pool)
    cleanups.push(runtime.shutdown)
    const call = (): DesktopMcpSseCall => ({ ...ref, requestId: randomUUID(), sessionId: run.sessionId, runId: run.runId, toolCallId: randomUUID(), tool: 'echo', arguments: {} })
    return { ref, run, deps, pool, runtime, wires, streams, tickets, claims, call, send, effects: () => effects,
        rotate: () => { generation = 'credential-2' }, revoke: () => { allowed = false; for (const controller of tickets) controller.abort() },
        hold: () => { holdCall = true }, closeFails: (value: boolean) => { closeFails = value }, catalog: (value: unknown[]) => { catalog = value } }
}

describe('owned legacy GET/endpoint/POST lifecycle (fixture network only)', () => {
    it('initializes, lists and calls over POST while receiving JSON-RPC messages from the GET stream', async () => {
        const f = fixture(), outcome = await f.runtime.call(f.call(), f.run, new AbortController().signal)
        expect(outcome.status).toBe('completed'); expect(f.effects()).toBe(1)
        expect(f.wires.map(wire => wire.method)).toEqual(['GET', 'POST', 'POST', 'POST', 'POST'])
        expect(JSON.stringify(outcome)).not.toContain('fixture-bearer'); expect(JSON.stringify(outcome)).not.toContain('fixture_session_')
        expect((await f.runtime.status(f.ref, new AbortController().signal)).endpointDisplay).toBe('https://example.com')
    })
    it('hydrates status without connecting and never replays a claimed call after a new runtime', async () => {
        const f = fixture(), signal = new AbortController().signal
        expect((await f.runtime.status(f.ref, signal)).state).toBe('unchecked'); expect(f.wires).toHaveLength(0)
        const call = f.call(); await f.runtime.call(call, f.run, signal); await f.runtime.shutdown()
        const restarted = createSseRuntime(f.deps, createSsePoolState()); cleanups.push(restarted.shutdown)
        expect((await restarted.status(f.ref, signal)).state).toBe('unchecked')
        expect((await restarted.call(call, f.run, signal)).status).toBe('uncertain'); expect(f.effects()).toBe(1)
    })
    it('does not make a partial malformed catalog callable', async () => {
        const f = fixture(); f.catalog([{ name: 'good', inputSchema: { type: 'object' } }, { name: 'bad', inputSchema: [] }])
        await expect(f.runtime.connect({ ...f.ref, requestId: randomUUID(), operation: 'connect' }, new AbortController().signal)).rejects.toThrow()
        expect(f.effects()).toBe(0)
    })
    it('requires exact run/owner/revision and current credential generation', async () => {
        const f = fixture(), signal = new AbortController().signal
        await expect(f.runtime.call(f.call(), { ...f.run, engineAgentId: 'another-engine' }, signal)).rejects.toThrow()
        await expect(f.runtime.call({ ...f.call(), agentId: 'other-owner' }, f.run, signal)).rejects.toThrow()
        await expect(f.runtime.call({ ...f.call(), expectedRevision: 'old-revision' }, f.run, signal)).rejects.toThrow()
        await f.runtime.connect({ ...f.ref, requestId: randomUUID(), operation: 'connect' }, signal)
        f.rotate()
        expect((await f.runtime.call(f.call(), f.run, signal)).status).toBe('completed'); expect(f.effects()).toBe(1)
        expect(f.streams.size).toBe(2)
    })
    it('Stop/lost tool acknowledgement stays uncertain and never sends the same attempt twice', async () => {
        const f = fixture(), stop = new AbortController(); f.hold()
        const call = f.call(), pending = f.runtime.call(call, f.run, stop.signal)
        await vi.waitFor(() => expect(f.effects()).toBe(1)); stop.abort()
        expect((await pending).status).toBe('uncertain')
        expect((await f.runtime.call(call, f.run, new AbortController().signal)).status).toBe('uncertain'); expect(f.effects()).toBe(1)
    })
    it('matches concurrent JSON-RPC IDs even when responses arrive in reverse order', async () => {
        const f = fixture(), signal = new AbortController().signal; f.hold()
        const first = f.runtime.call({ ...f.call(), arguments: { tag: 'first' } }, f.run, signal)
        const second = f.runtime.call({ ...f.call(), arguments: { tag: 'second' } }, f.run, signal)
        await vi.waitFor(() => expect(f.effects()).toBe(2))
        const sent = f.wires.filter(wire => wire.body && JSON.parse(wire.body).method === 'tools/call').map(wire => JSON.parse(wire.body!))
        const session = [...f.streams.keys()][0]!
        for (const request of sent.reverse()) f.send(session, { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: request.params.arguments.tag }] } })
        expect((await first).result?.content).toEqual([{ type: 'text', text: 'first' }])
        expect((await second).result?.content).toEqual([{ type: 'text', text: 'second' }])
    })
    it('revocation/deletion admission aborts owned inflight work without a completed claim', async () => {
        const f = fixture(), signal = new AbortController().signal; f.hold()
        const work = f.runtime.call(f.call(), f.run, signal)
        await vi.waitFor(() => expect(f.effects()).toBe(1)); f.revoke()
        expect((await work).status).toBe('uncertain')
        await f.runtime.dispose(f.ref.agentId, f.ref.serverId)
        expect(f.pool.entries.size).toBe(0)
    })
    it('retains failed close ownership for an explicit retry', async () => {
        const f = fixture(), signal = new AbortController().signal
        await f.runtime.connect({ ...f.ref, requestId: randomUUID(), operation: 'connect' }, signal); f.closeFails(true)
        const request = { ...f.ref, requestId: randomUUID(), operation: 'disconnect' as const }
        expect((await f.runtime.disconnect(request, signal)).state).toBe('closing'); expect(f.pool.retired.size).toBe(1)
        f.closeFails(false)
        expect((await f.runtime.disconnect(request, signal)).state).toBe('disconnected'); expect(f.pool.retired.size).toBe(0)
    })
    it('rejects duplicate and foreign responses on the exact stream generation', async () => {
        for (const id of [1, 999]) {
            const f = fixture(), signal = new AbortController().signal
            await f.runtime.connect({ ...f.ref, requestId: randomUUID(), operation: 'connect' }, signal)
            f.send([...f.streams.keys()][0]!, { jsonrpc: '2.0', id, result: {} })
            await vi.waitFor(() => expect(f.pool.entries.size).toBe(0))
            expect(f.effects()).toBe(0)
        }
    })
    it('disconnects only the named immutable coworker/server connection', async () => {
        const f = fixture(), signal = new AbortController().signal, other = { ...f.ref, agentId: 'owner-b', serverId: 'server-b' }
        await f.runtime.connect({ ...f.ref, requestId: randomUUID(), operation: 'connect' }, signal)
        await f.runtime.connect({ ...other, requestId: randomUUID(), operation: 'connect' }, signal)
        await f.runtime.disconnect({ ...f.ref, requestId: randomUUID(), operation: 'disconnect' }, signal)
        expect((await f.runtime.status(other, signal)).state).toBe('connected')
        expect(f.pool.entries.size).toBe(1)
    })
    it('does not follow GET redirects or send credentials after a generation change at POST admission', async () => {
        const f = fixture(), signal = new AbortController().signal
        f.deps.network = vi.fn(async () => ({ status: 302, contentType: 'text/event-stream', body: null, close: async () => {} }))
        await expect(f.runtime.connect({ ...f.ref, requestId: randomUUID(), operation: 'connect' }, signal)).rejects.toThrow()
        expect(f.deps.network).toHaveBeenCalledTimes(1)
        const g = fixture(), original = g.deps.network
        g.deps.network = async request => {
            if (request.method === 'POST' && JSON.parse(request.body!).method === 'tools/call') g.rotate()
            return original(request)
        }
        expect((await g.runtime.call(g.call(), g.run, signal)).status).toBe('uncertain')
        expect(g.effects()).toBe(0)
    })
    it('closes a late GET open after Stop instead of publishing a connected snapshot', async () => {
        const f = fixture(), stop = new AbortController()
        let finish!: (response: SseWireResponse) => void
        const close = vi.fn(async () => {})
        f.deps.network = vi.fn(() => new Promise<SseWireResponse>(resolve => { finish = resolve }))
        const work = f.runtime.connect({ ...f.ref, requestId: randomUUID(), operation: 'connect' }, stop.signal)
        const refused = expect(work).rejects.toThrow()
        await vi.waitFor(() => expect(f.deps.network).toHaveBeenCalledOnce())
        stop.abort(); finish({ status: 200, contentType: 'text/event-stream', body: null, close })
        await refused
        expect(close).toHaveBeenCalled()
        expect(f.effects()).toBe(0)
    })
})
