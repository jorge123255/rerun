import { createClient, type Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { externalMcpDisplayedSecret, EXTERNAL_MCP_COPY, type ExternalMcpDispatchPort, type ExternalMcpToolResult } from '@rerun/contracts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { externalMcpHttpRefusal } from './http-guards.js'
import { createExternalMcpService, type ExternalMcpDb } from './service.js'
import type { ExternalMcpRuntimeSnapshot } from './authority.js'

const INSTALL = '11111111-1111-4111-8111-111111111111'
const LAUNCH = '22222222-2222-4222-8222-222222222222'
const REQUEST = '33333333-3333-4333-8333-333333333333'
const EFFECT = '44444444-4444-4444-8444-444444444444'

function database(client: Client): ExternalMcpDb {
    return {
        async execute(statement) {
            const result = await client.execute(statement)
            return { rows: result.rows as unknown as Array<Record<string, unknown>>, rowsAffected: Number(result.rowsAffected) }
        },
        batch: (statements, mode) => client.batch(statements, mode),
        executeMultiple: sql => client.executeMultiple(sql),
    }
}

function harness() {
    let snapshot: ExternalMcpRuntimeSnapshot | null = {
        installId: INSTALL, launchNonce: LAUNCH, workspaceId: 1, admissionsFrozen: false, stopping: false,
    }
    let clock = new Date('2026-11-05T12:00:00.000Z')
    let listens = 0
    let closed = 0
    let engineKey: string | undefined = 'a'.repeat(64)
    let calls = 0
    let openGate: () => void = () => {}
    let markStarted: () => void = () => {}
    const started = new Promise<void>(resolve => { markStarted = resolve })
    let gate: Promise<void> = Promise.resolve()
    const dispatch: ExternalMcpDispatchPort = {
        async listTools() {
            return [{ name: 'list_agents', description: 'List coworkers.', inputSchema: { type: 'object' }, scope: 'mcp:read', effect: false }, { name: 'send_message', description: 'Send.', inputSchema: { type: 'object' }, scope: 'runs:send', effect: true }]
        },
        callTool(_context, signal) {
            calls += 1
            return new Promise<ExternalMcpToolResult>((resolve, reject) => {
                const finish = () => resolve({ content: [{ type: 'text', text: 'sent' }] })
                const stop = () => reject(new Error('aborted'))
                if (signal.aborted) {
                    markStarted()
                    stop()
                    return
                }
                signal.addEventListener('abort', stop, { once: true })
                markStarted()
                void gate.then(() => { if (!signal.aborted) finish() })
            })
        },
    }
    const service = createExternalMcpService({
        db: () => database(client),
        authority: { read: () => snapshot },
        dispatch: () => dispatch,
        engineKey: () => engineKey,
        now: () => clock,
        listen: async () => {
            listens += 1
            return { origin: 'http://127.0.0.1:9', close: async () => { closed += 1 } }
        },
    })
    return {
        service, get calls() { return calls }, get listens() { return listens }, get closed() { return closed },
        setSnapshot: (next: ExternalMcpRuntimeSnapshot | null) => { snapshot = next },
        setClock: (next: Date) => { clock = next },
        setEngineKey: (next: string | undefined) => { engineKey = next },
        holdCall() { gate = new Promise<void>(resolve => { openGate = resolve }) },
        releaseCall() { openGate() },
        started,
    }
}

let client: Client
let root: string

async function setup() {
    root = await mkdtemp(join(tmpdir(), 'external-mcp-'))
    client = createClient({ url: `file:${join(root, 'external-mcp.db')}` })
    const box = harness()
    await box.service.initialize()
    return box
}

function response() {
    const state = { status: 0, body: '', headers: {} as Record<string, unknown> }
    const res = {
        headersSent: false,
        writableEnded: false,
        writeHead(status: number, headers: Record<string, unknown>) { state.status = status; state.headers = headers; this.headersSent = true },
        end(payload = '') { state.body = String(payload); this.writableEnded = true },
    }
    return { state, res: res as unknown as ServerResponse }
}

function request(body: unknown, headers: Record<string, string>): IncomingMessage {
    const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage
    stream.method = 'POST'
    stream.url = '/mcp'
    stream.headers = { host: '127.0.0.1:9', authorization: headers.authorization ?? '', ...headers }
    Object.defineProperty(stream, 'socket', { value: { remoteAddress: '127.0.0.1' } })
    stream.once = ((event: string, fn: () => void) => { if (event !== 'aborted') return stream; return stream }) as IncomingMessage['once']
    return stream
}

describe('external MCP authority', () => {
    it('stores only a hash and will not show the secret again', async () => {
        const box = await setup()
        const created = await box.service.create({ requestId: REQUEST, workspaceId: 1, name: 'Claude Code, MacBook' })
        expect(created.ok).toBe(true)
        if (!created.ok) return
        expect(externalMcpDisplayedSecret(created)).toMatch(/^rk_/)
        const rows = await client.execute('SELECT key_hash, key_prefix, name FROM desktop_external_mcp_keys')
        expect(JSON.stringify(rows.rows)).not.toContain(created.secret)
        expect(rows.rows[0]?.key_hash).toHaveLength(64)
        const again = await box.service.create({ requestId: REQUEST, workspaceId: 1, name: 'Claude Code, MacBook' })
        expect(again.ok && again.secretAvailable).toBe(false)
        expect(externalMcpDisplayedSecret(again.ok ? again : { secretAvailable: false, secret: null })).toBeNull()
        const columns = await client.execute('PRAGMA table_info(desktop_external_mcp_keys)')
        expect(columns.rows.map(row => row.name)).not.toContain('secret')
        await rm(root, { recursive: true, force: true })
    })

    it('refuses credential scope, the engine key, expiry, and another workspace', async () => {
        const box = await setup()
        expect((await box.service.create({ requestId: REQUEST, workspaceId: 1, name: 'CI', scopes: ['credentials'] })).ok).toBe(false)
        const created = await box.service.create({ requestId: REQUEST, workspaceId: 1, name: 'CI', expiresAt: '2026-11-05T12:05:00.000Z' })
        if (!created.ok || !created.secret) throw new Error('expected a secret')
        await box.service.enable({ requestId: '55555555-5555-4555-8555-555555555555', workspaceId: 1 })
        expect((await box.service.admit('a'.repeat(64))).ok).toBe(false)
        expect((await box.service.admit(created.secret)).ok).toBe(true)
        box.setEngineKey(created.secret)
        expect((await box.service.admit(created.secret)).ok).toBe(false)
        box.setEngineKey('b'.repeat(64))
        box.setClock(new Date('2026-11-05T12:06:00.000Z'))
        const expired = await box.service.admit(created.secret)
        expect(expired.ok).toBe(false)
        if (!expired.ok) expect(expired.code).toBe('expired')
        box.setClock(new Date('2026-11-05T12:00:00.000Z'))
        const fresh = await box.service.create({ requestId: '66666666-6666-4666-8666-666666666666', workspaceId: 1, name: 'Other' })
        if (!fresh.ok || !fresh.secret) throw new Error('expected a second secret')
        box.setSnapshot({ installId: INSTALL, launchNonce: LAUNCH, workspaceId: 2, admissionsFrozen: false, stopping: false })
        const admitted = await box.service.admit(fresh.secret)
        expect(admitted.ok).toBe(false)
        expect((await box.service.listener()).enabled).toBe(false)
        await rm(root, { recursive: true, force: true })
    })

    it('does not return a revoked in-flight result or run that request again', async () => {
        const box = await setup()
        box.holdCall()
        const created = await box.service.create({ requestId: REQUEST, workspaceId: 1, name: 'CI', scopes: ['mcp:read', 'runs:send'] })
        if (!created.ok || !created.secret) throw new Error('expected a secret')
        await box.service.enable({ requestId: '55555555-5555-4555-8555-555555555555', workspaceId: 1 })
        const first = response()
        const pending = box.service.handle(request({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'send_message', arguments: {} } }, { authorization: `Bearer ${created.secret}`, 'x-rerun-external-request-id': EFFECT }), first.res)
        await Promise.race([box.started, new Promise((_, reject) => setTimeout(() => reject(new Error('external call did not start')), 1000))])
        await box.service.revoke({ requestId: '77777777-7777-4777-8777-777777777777', workspaceId: 1, keyId: created.key.keyId })
        box.releaseCall()
        await pending
        expect(first.state.body).not.toContain('sent')
        expect(box.calls).toBe(1)
        const second = response()
        await box.service.handle(request({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'send_message', arguments: {} } }, { authorization: `Bearer ${created.secret}`, 'x-rerun-external-request-id': EFFECT }), second.res)
        expect(box.calls).toBe(1)
        expect(second.state.body).not.toContain('sent')
        await rm(root, { recursive: true, force: true })
    })

    it('keeps the listener off across restart and rejects a missing adapter, a bad host, and a URL token', async () => {
        const box = await setup()
        await box.service.enable({ requestId: REQUEST, workspaceId: 1 })
        expect(box.listens).toBe(1)
        await box.service.initialize()
        expect((await box.service.listener()).enabled).toBe(false)
        expect(box.listens).toBe(1)
        const created = await box.service.create({ requestId: '88888888-8888-4888-8888-888888888888', workspaceId: 1, name: 'CI' })
        if (!created.ok || !created.secret) throw new Error('expected a secret')
        await box.service.enable({ requestId: '99999999-9999-4999-8999-999999999999', workspaceId: 1 })
        const listed = response()
        const isolated = createExternalMcpService({
            db: () => database(client),
            authority: { read: () => ({ installId: INSTALL, launchNonce: LAUNCH, workspaceId: 1, admissionsFrozen: false, stopping: false }) },
            dispatch: () => null,
            engineKey: () => undefined,
            listen: async () => ({ origin: 'http://127.0.0.1:9', close: async () => {} }),
        })
        await isolated.initialize()
        await isolated.enable({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspaceId: 1 })
        await isolated.handle(request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${created.secret}` }), listed.res)
        expect(listed.state.body).toContain(EXTERNAL_MCP_COPY.adapterMissing)
        expect(listed.state.body).not.toContain('"tools":[]')
        expect(externalMcpHttpRefusal({ host: 'localhost:9', origin: null, path: '/mcp', search: '', remoteAddress: '127.0.0.1', boundHost: '127.0.0.1:9' })?.code).toBe('forbidden_host')
        expect(externalMcpHttpRefusal({ host: '127.0.0.1:9', origin: 'http://evil.example', path: '/mcp', search: '', remoteAddress: '127.0.0.1', boundHost: '127.0.0.1:9' })?.code).toBe('forbidden_origin')
        expect(externalMcpHttpRefusal({ host: '127.0.0.1:9', origin: null, path: '/mcp', search: '?token=rk_secret', remoteAddress: '127.0.0.1', boundHost: '127.0.0.1:9' })?.code).toBe('forbidden_url')
        await isolated.close()
        await rm(root, { recursive: true, force: true })
    })
})
