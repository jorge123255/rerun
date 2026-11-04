import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { desktopBoardLayout } from '@/lib/desktop/board-layout'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession, listDesktopAgents, listDesktopSessions, type DesktopAgent } from '@/lib/desktop/server/store'
import { GET } from '../../route'
import { POST } from './route'

const origin = 'http://127.0.0.1:3101'
const token = 'd'.repeat(48)
const headers = { origin, host: '127.0.0.1:3101', cookie: `rerun-desktop-session=${token}`, 'content-type': 'application/json' }
const originalEnv = { ...process.env }
let root: string, server: Server, source: DesktopAgent, patches: string[], fail: 'lost' | 'rejected' | null
let position: { col: number; row: number }
const copies = new Map<string, { id: string; name: string; displayName: string; enabled: boolean }>()
let sourceEnabled = true

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-duplicate-route-'))
    copies.clear()
    patches = []
    fail = null
    sourceEnabled = true
    server = createServer(async (req, res) => {
        const reply = (code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
        if (req.method === 'GET' && req.url === '/agents') return reply(200, { agents: [
            { id: 'owner', name: 'source' }, { id: 'peer', name: 'source_copy' }, ...copies.values(),
        ] })
        if (req.method === 'GET' && req.url?.startsWith('/agents/copy-')) {
            const copy = [...copies.values()].find(item => '/agents/' + item.id === req.url)
            if (copy) return reply(200, { id: copy.id, config: copy, soul: '' })
        }
        if (req.method !== 'POST' || req.url !== '/agents/owner/duplicate') return reply(404, {})
        const id = String(req.headers['x-rerun-duplicate-id'])
        patches.push(id)
        if (fail === 'rejected') return reply(400, {})
        let raw = ''
        for await (const chunk of req) raw += chunk
        const copy = copies.get(id) ?? { ...JSON.parse(raw), id: 'copy-' + id, enabled: sourceEnabled }
        copies.set(id, copy)
        if (fail === 'lost') { res.destroy(); return }
        return reply(201, copy)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'duplicate-launch', buildId: 'duplicate-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'fixture' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    source = await createDesktopAgent(db, { name: 'Source', engineAgentId: 'owner', description: 'Research' })
    position = desktopBoardLayout([source]).suggested
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
})

const duplicate = (requestId: string, at = position, id = source.id, auth = true) =>
    POST(new Request(origin + '/api/desktop/agents/' + id + '/duplicate', { method: 'POST', headers: auth ? headers : {}, body: JSON.stringify({ requestId, position: at }) }),
        { params: Promise.resolve({ agentId: id }) })

it('allocates one independent coworker per placement and preserves its position and chats across DB reopen', async () => {
    let db = await openDesktopDatabase(root)
    await createDesktopSession(db, { agentId: source.id, engineSessionId: 'source-chat', title: 'Source history' })
    const requestId = crypto.randomUUID()
    const results = await Promise.all([duplicate(requestId), duplicate(requestId)])
    expect(results.map(r => r.status)).toEqual([201, 201])
    const [{ agent }, repeated] = await Promise.all(results.map(r => r.json()))
    expect(repeated.agent).toEqual(agent)
    expect(agent).toMatchObject({ name: 'Source copy', description: 'Research', position })
    expect(agent.id).not.toBe(source.id)
    expect(copies.get(requestId)?.name).toBe('source_copy_2')
    expect(patches).toEqual([requestId])
    expect(await listDesktopSessions(db, agent.id)).toEqual([])
    await createDesktopSession(db, { agentId: agent.id, engineSessionId: 'copy-chat', title: 'Copy history' })
    await closeDesktopDatabase(root)
    db = await openDesktopDatabase(root)
    expect((await listDesktopAgents(db)).find(a => a.id === agent.id)).toMatchObject({ engineAgentId: 'copy-' + requestId, position })
    expect((await listDesktopSessions(db, agent.id)).map(s => s.title)).toEqual(['Copy history'])
    expect((await listDesktopSessions(db, source.id)).map(s => s.title)).toEqual(['Source history'])
    const collision = await duplicate(crypto.randomUUID())
    expect(collision.status).toBe(409)
    expect(await collision.json()).toMatchObject({ code: 'position_occupied' })
    expect(copies.size).toBe(1)
})

it('repairs a lost engine response on the next roster read and cannot reuse the request for another owner', async () => {
    const requestId = crypto.randomUUID()
    fail = 'lost'
    expect((await duplicate(requestId)).status).toBe(502)
    expect((await listDesktopAgents(await openDesktopDatabase(root)))).toHaveLength(1)
    const blocked = await duplicate(crypto.randomUUID())
    expect(blocked.status).toBe(409)
    fail = null
    await closeDesktopDatabase(root)
    const roster = await GET(new Request(origin + '/api/desktop/agents', { headers }))
    expect(roster.status).toBe(200)
    const { agents } = await roster.json()
    expect(agents).toHaveLength(2)
    const copy = agents.find((a: DesktopAgent) => a.id !== source.id)
    expect(copy.position).toEqual(position)
    expect(copies.size).toBe(1)
    expect((await duplicate(requestId, position, copy.id)).status).toBe(409)
    expect((await duplicate(requestId)).status).toBe(201)
    expect(patches).toEqual([requestId, requestId])
})

it('keeps a disabled source disabled in its independent copy, including a lost acknowledgement', async () => {
    sourceEnabled = false
    const requestId = crypto.randomUUID()
    fail = 'lost'
    expect((await duplicate(requestId)).status).toBe(502)
    sourceEnabled = true
    fail = null
    const response = await duplicate(requestId)
    expect(response.status).toBe(201)
    const { agent } = await response.json()
    expect(agent.enabled).toBe(false)
    expect(await listDesktopSessions(await openDesktopDatabase(root), agent.id)).toEqual([])
})

it('rejects invalid input, missing owners, occupied positions and unauthenticated requests before copying', async () => {
    expect((await duplicate('invalid')).status).toBe(400)
    expect((await duplicate(crypto.randomUUID(), position, 'missing')).status).toBe(404)
    expect((await duplicate(crypto.randomUUID(), { col: 3, row: 3 })).status).toBe(409)
    expect((await duplicate(crypto.randomUUID(), position, source.id, false)).status).toBe(403)
    expect(patches).toEqual([])
    fail = 'rejected'
    expect((await duplicate(crypto.randomUUID())).status).toBe(400)
    fail = null
    expect((await duplicate(crypto.randomUUID())).status).toBe(201)
})
