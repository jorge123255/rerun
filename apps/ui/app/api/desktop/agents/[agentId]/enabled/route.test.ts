import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession, findDesktopAgent, listDesktopSessions } from '@/lib/desktop/server/store'
import { writeDesktopTabs } from '@/lib/desktop/server/session-tabs'
import { POST as chat } from '../../../chat/route'
import { GET as roster } from '../../route'
import { PATCH } from './route'

const origin = 'http://127.0.0.1:3101'
const token = 'e'.repeat(40)
const headers = { origin, host: '127.0.0.1:3101', cookie: `rerun-desktop-session=${token}`, 'content-type': 'application/json' }
const originalEnv = { ...process.env }
let root: string, server: Server, connected: boolean, loseReply: boolean
const engine = new Map<string, boolean>()
const patches: { id: string; enabled: boolean }[] = []
const requests: string[] = []
let patchGate: Promise<void> | undefined

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-enabled-'))
    connected = true
    patchGate = undefined
    loseReply = false
    patches.length = 0
    requests.length = 0
    engine.clear()
    engine.set('owner', true)
    engine.set('peer', true)
    server = createServer(async (req, res) => {
        requests.push(`${req.method} ${req.url}`)
        const json = (code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
        if (!connected) return json(503, {})
        const setup = req.url?.match(/^\/agents\/([^/]+)\/setup$/)
        if (req.method === 'GET' && setup && engine.has(setup[1])) return json(200, {
            required: false, prompt: '', completedAt: null, sessionId: null, pending: false, revision: 'fixture-setup',
        })
        if (req.url === '/connections' && req.method === 'GET') return json(200, {
            connections: [{ id: 'local', name: 'Local', provider: 'openrouter', models: ['local-model'], extraModels: [],
                createdAt: '2026-01-01T00:00:00.000Z', connected: true, credentialRejected: false, planLimits: null }],
            default: { connectionId: 'local', model: 'local-model' },
        })
        const id = req.url?.slice('/agents/'.length) ?? ''
        if (!engine.has(id)) return json(404, {})
        if (req.method === 'PATCH') {
            let raw = ''
            for await (const chunk of req) raw += chunk
            const body = JSON.parse(raw)
            patches.push({ id, ...body })
            await patchGate
            engine.set(id, body.enabled)
            if (loseReply) { connected = false; res.destroy(); return }
        }
        return json(200, { id, config: { name: id, enabled: engine.get(id) }, soul: '' })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'enabled-launch', buildId: 'enabled-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'fixture' } }), { mode: 0o600 })
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
})

const toggle = (id: string, enabled: unknown, authenticated = true, extra = {}) => PATCH(new Request(`${origin}/api/desktop/agents/${id}/enabled`, {
    method: 'PATCH', headers: authenticated ? headers : {}, body: JSON.stringify({ enabled, ...extra }),
}), { params: Promise.resolve({ agentId: id }) })

it('persists off and on across database reopen without changing owner identities or saved chats', async () => {
    let db = await openDesktopDatabase(root)
    const owner = await createDesktopAgent(db, { engineAgentId: 'owner', name: 'Alice' })
    const peer = await createDesktopAgent(db, { engineAgentId: 'peer', name: 'Bob' })
    const saved = await createDesktopSession(db, { agentId: owner.id, engineSessionId: 'saved-chat', title: 'Keep this chat' })
    expect(owner.enabled).toBe(true)
    expect((await toggle(owner.id, false)).status).toBe(200)
    expect((await toggle(owner.id, false)).status).toBe(200)
    expect(patches).toEqual([{ id: 'owner', enabled: false }])
    await closeDesktopDatabase(root)
    db = await openDesktopDatabase(root)
    expect(await findDesktopAgent(db, owner.id)).toMatchObject({ engineAgentId: 'owner', enabled: false })
    expect(await listDesktopSessions(db, owner.id)).toEqual([saved])
    expect(await findDesktopAgent(db, peer.id)).toEqual(peer)
    const enabled = await toggle(owner.id, true)
    expect((await enabled.json()).agent).toMatchObject({ id: owner.id, enabled: true })
    await closeDesktopDatabase(root)
    db = await openDesktopDatabase(root)
    expect((await findDesktopAgent(db, owner.id))?.enabled).toBe(true)
    expect(await listDesktopSessions(db, owner.id)).toEqual([saved])
})

it('rejects disabled new sends and regenerations before creating any chat reservations', async () => {
    const db = await openDesktopDatabase(root)
    const owner = await createDesktopAgent(db, { engineAgentId: 'owner', name: 'Alice' })
    const saved = await createDesktopSession(db, { agentId: owner.id, engineSessionId: 'saved-chat', title: 'Keep this chat' })
    expect((await toggle(owner.id, false)).status).toBe(200)
    const bodies = [
        { agentId: owner.id, text: 'Do not start', tabUid: 'blocked-first-turn' },
        { agentId: owner.id, sessionId: saved.id, text: 'Do not add a reply' },
        { agentId: owner.id, sessionId: saved.id, regenerateMessageId: 'engine-reply', requestId: crypto.randomUUID() },
    ]
    for (const body of bodies) {
        const response = await chat(new Request(origin + '/api/desktop/chat', { method: 'POST', headers, body: JSON.stringify(body) }))
        expect(response.status).toBe(403)
        expect((await response.json()).error).toContain('switched off')
    }
    expect(await listDesktopSessions(db, owner.id)).toEqual([saved])
    expect((await db.execute('SELECT * FROM desktop_tab_starts')).rows).toEqual([])
    expect((await db.execute('SELECT * FROM desktop_regeneration_requests')).rows).toEqual([])
})

it('recovers canonical engine state after a lost acknowledgement and keeps failures honest', async () => {
    const db = await openDesktopDatabase(root)
    const owner = await createDesktopAgent(db, { engineAgentId: 'owner', name: 'Alice' })
    connected = false
    expect((await toggle(owner.id, false)).status).toBe(502)
    expect((await findDesktopAgent(db, owner.id))?.enabled).toBe(true)
    connected = true
    loseReply = true
    expect((await toggle(owner.id, false)).status).toBe(502)
    expect(engine.get('owner')).toBe(false)
    await closeDesktopDatabase(root)
    connected = true
    patchGate = undefined
    loseReply = false
    const response = await roster(new Request(origin + '/api/desktop/agents', { headers }))
    expect((await response.json()).agents[0]).toMatchObject({ id: owner.id, enabled: false })
    expect((await toggle(owner.id, false)).status).toBe(200)
    expect(patches).toHaveLength(1)
})

it('checks the canonical enabled flag before reservations even when a chat overrides the model', async () => {
    const db = await openDesktopDatabase(root)
    const owner = await createDesktopAgent(db, { engineAgentId: 'owner', name: 'Alice' })
    const model = { connectionId: 'local', model: 'local-model' }
    const saved = await createDesktopSession(db, { agentId: owner.id, engineSessionId: 'saved-chat', title: 'Kept', model })
    const layout = await writeDesktopTabs(db, owner.id, {
        baseRevision: 0, activeIndex: 1, tabs: [{ uid: 'saved', id: saved.id }, { uid: 'stale-flag', id: null }],
    })
    expect(layout.conflict).toBe(false)
    expect(layout.tabs?.tabs[1]).toMatchObject({ uid: 'stale-flag', id: null })
    engine.set('owner', false)
    expect((await findDesktopAgent(db, owner.id))?.enabled).toBe(true)
    for (const body of [
        { agentId: owner.id, text: 'Blocked first turn', tabUid: 'stale-flag', modelChoice: model },
        { agentId: owner.id, sessionId: saved.id, text: 'Blocked override' },
        { agentId: owner.id, sessionId: saved.id, regenerateMessageId: 'engine-reply', requestId: crypto.randomUUID() },
    ]) {
        const response = await chat(new Request(origin + '/api/desktop/chat', { method: 'POST', headers, body: JSON.stringify(body) }))
        expect(response.status).toBe(403)
    }
    expect(requests.filter(path => path.endsWith('/chat'))).toEqual([])
    expect(await listDesktopSessions(db, owner.id)).toEqual([saved])
    expect((await db.execute('SELECT * FROM desktop_tab_starts')).rows).toEqual([])
    expect((await db.execute('SELECT * FROM desktop_regeneration_requests')).rows).toEqual([])
})

it('validates ownership and boolean input, then orders rapid off/on writes', async () => {
    const db = await openDesktopDatabase(root)
    const owner = await createDesktopAgent(db, { engineAgentId: 'owner', name: 'Alice' })
    for (const value of [null, '', 'false', 0, undefined]) expect((await toggle(owner.id, value)).status).toBe(400)
    expect((await toggle(owner.id, false, true, { name: 'Injected' })).status).toBe(400)
    expect((await toggle('owner', false)).status).toBe(404)
    expect((await toggle(owner.id, false, false)).status).toBe(403)
    expect(patches).toEqual([])
    // Establish arrival order at the write boundary, not by the creation order of two
    // asynchronous HTTP/auth/body reads. Hold the first write while queuing the second.
    let release!: () => void
    patchGate = new Promise<void>(resolve => { release = resolve })
    const off = toggle(owner.id, false)
    await expect.poll(() => patches.length).toBe(1)
    const on = toggle(owner.id, true)
    release()
    const results = await Promise.all([off, on])
    expect(results.map(response => response.status)).toEqual([200, 200])
    expect(patches).toEqual([{ id: 'owner', enabled: false }, { id: 'owner', enabled: true }])
    expect((await findDesktopAgent(db, owner.id))?.enabled).toBe(true)
})
