import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { afterEach, expect, it, vi } from 'vitest'
import { remoteMcpStore, remoteMcpSchema, remoteMcpOAuthSchema, bindRemoteTransportDrain } from '../mcp/store'
import { migrateDesktopSse } from './schema'
import { createDesktopSseBinding } from './binding'
import type { SseNetwork, SseWireRequest } from './types'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture() {
    const folder = await mkdtemp(join(tmpdir(), 'sse-binding-'))
    const db = createClient({ url: `file:${join(folder, 'app.db')}` })
    cleanups.push(async () => { db.close(); await rm(folder, { recursive: true, force: true }) })
    await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('owner');" + remoteMcpSchema + remoteMcpOAuthSchema)
    await migrateDesktopSse(db)
    const store = remoteMcpStore(db, () => Buffer.alloc(32, 7))
    const run = { engineAgentId: 'engine-owner', sessionId: 'chat', runId: 'run' }
    const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
    const wires: SseWireRequest[] = []
    let number = 0, effects = 0, allowed = true
    const network: SseNetwork = async request => {
        await request.guard(); wires.push(request)
        if (request.method === 'GET') {
            const session = `session_${++number}`.padEnd(24, 'x')
            let closed = false
            const body = new ReadableStream<Uint8Array>({ start(controller) {
                streams.set(session, controller)
                controller.enqueue(new TextEncoder().encode(`event: endpoint\ndata: /messages?sessionId=${session}\n\n`))
            }, cancel() { closed = true; streams.delete(session) } })
            return { status: 200, contentType: 'text/event-stream', body, async close() {
                if (!closed) { closed = true; streams.get(session)?.close(); streams.delete(session) }
            } }
        }
        const input = JSON.parse(request.body!), session = new URL(request.url).searchParams.get('sessionId')!
        let result: unknown
        if (input.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        if (input.method === 'tools/list') result = { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }
        if (input.method === 'tools/call') { effects++; result = { content: [{ type: 'text', text: 'private-fixture reply' }] } }
        if (result) streams.get(session)!.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: input.id, result })}\n\n`))
        return { status: 202, contentType: 'text/plain', body: null, async close() {} }
    }
    const deps = { db, store, key: () => Buffer.alloc(32, 7), shutdownSignal: new AbortController().signal,
        access: async (owner: string) => { if (owner !== 'owner') throw new Error('owner'); return { enabled: true, granted: allowed } },
        authorizeRun: async (identity: typeof run, signal: AbortSignal) => { signal.throwIfAborted(); if (!allowed || JSON.stringify(identity) !== JSON.stringify(run)) throw new Error('run'); return 'owner' },
        manage: async () => () => {}, refreshCredential: async () => null, validateToolNames: vi.fn(async () => {}), network }
    const binding = createDesktopSseBinding(deps); cleanups.push(binding.shutdown)
    bindRemoteTransportDrain(store, async (owner, name) => { const row = await store.read(owner, name); await binding.dispose(owner, row.id) })
    const saved = await binding.settings.mutate({ kind: 'save', agentId: 'owner', requestId: crypto.randomUUID(), serverId: null, expectedRevision: null, configuration: { name: 'fixture', transport: 'sse', url: 'https://example.com/sse' } }, new AbortController().signal)
    if (saved.status !== 'saved' || !saved.reference) throw new Error('not saved')
    const ref = saved.reference
    await store.save('owner', { name: ref.name, url: 'https://example.com/sse', revision: ref.expectedRevision, bearer: 'private-fixture' })
    const row = (await store.list('owner'))[0]
    return { deps, binding, wires, run, store, db, ref: { ...ref, expectedRevision: row.revision }, effects: () => effects, revoke: () => { allowed = false } }
}

it('the real store binding sanitizes replies and keeps immutable call receipts across a fresh runtime', async () => {
    const f = await fixture(), signal = new AbortController().signal
    const definitions = await f.binding.tools('owner', f.run, signal)
    expect(definitions.map(tool => tool.name)).toEqual(['fixture_echo'])
    const first = await definitions[0].execute({ text: 'hello' }, signal, 'same-tool-call')
    expect(JSON.stringify(first)).toContain('[REDACTED] reply')
    expect(JSON.stringify(first)).not.toContain('private-fixture')
    await f.binding.shutdown()
    const restarted = createDesktopSseBinding(f.deps); cleanups.push(restarted.shutdown)
    const next = await restarted.tools('owner', f.run, signal)
    const replay = await next[0].execute({ text: 'hello' }, signal, 'same-tool-call')
    expect(JSON.stringify(replay)).toContain('uncertain')
    expect(f.effects()).toBe(1)
    expect((await f.db.execute('SELECT count(*) AS n FROM desktop_mcp_sse_calls')).rows[0].n).toBe(1)
})

it('a connected stream remains usable after its initial connect deadline', async () => {
    const f = await fixture(), signal = new AbortController().signal
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const definitions = await f.binding.tools('owner', f.run, signal)
    await vi.advanceTimersByTimeAsync(21_000)
    expect(() => f.wires[0].authority.check()).not.toThrow()
    expect(JSON.stringify(await definitions[0].execute({}, signal, 'late-call'))).toContain('[REDACTED] reply')
    expect(f.effects()).toBe(1)
})

it('revoked or mismatched runs cannot dispatch a discovered tool', async () => {
    const f = await fixture(), signal = new AbortController().signal
    await expect(f.binding.tools('owner', { ...f.run, sessionId: 'sibling' }, signal)).rejects.toThrow()
    expect(f.wires).toHaveLength(0)
    const definitions = await f.binding.tools('owner', f.run, signal)
    f.revoke()
    await expect(definitions[0].execute({}, signal, 'revoked-call')).rejects.toThrow()
    expect(f.effects()).toBe(0)
})
