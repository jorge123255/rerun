import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession, findDesktopAgent, listDesktopSessions } from '@/lib/desktop/server/store'
import { GET as list } from '../route'
import { PATCH } from './route'

const origin = 'http://127.0.0.1:3101'
const sessionToken = 'r'.repeat(40)
const headers = { origin, host: '127.0.0.1:3101', cookie: `rerun-desktop-session=${sessionToken}`, 'content-type': 'application/json' }
const env = { ...process.env }
let root: string, server: Server, connected = true, loseReply = false
let afterEnginePatch: (() => Promise<void>) | undefined
const engine = new Map<string, { name: string; displayName: string }>()
const patches: { id: string; body: unknown }[] = []

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-rename-'))
    connected = true
    loseReply = false
    afterEnginePatch = undefined
    patches.length = 0
    engine.clear()
    engine.set('owner-a', { name: 'alice-12345678', displayName: 'Alice' })
    engine.set('owner-b', { name: 'studio', displayName: 'Studio' })
    engine.set('outside-board', { name: 'studio_2', displayName: 'Other' })
    server = createServer(async (req, res) => {
        const json = (code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
        if (!connected) return json(503, { error: 'unavailable' })
        if (req.url === '/agents' && req.method === 'GET') return json(200, { agents: [...engine].map(([id, config]) => ({ id, name: config.name })) })
        const id = req.url?.slice('/agents/'.length) ?? ''
        if (!engine.has(id)) return json(404, {})
        if (req.method === 'PATCH') {
            let raw = ''
            for await (const chunk of req) raw += chunk
            const body = JSON.parse(raw)
            patches.push({ id, body })
            const applied = { ...engine.get(id)!, ...body }
            engine.set(id, applied)
            if (loseReply) { connected = false; res.destroy(); return }
            await afterEnginePatch?.()
            return json(200, { id, config: applied, soul: '' })
        }
        return json(200, { id, config: engine.get(id), soul: '' })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    process.env.RERUN_DESKTOP_APP = '1'
    process.env.RERUN_DESKTOP_DATA_DIR = root
    process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
    await writeFile(process.env.RERUN_DESKTOP_RUNTIME_FILE, JSON.stringify({
        protocolVersion: 1, launchNonce: 'rename-launch', buildId: 'rename-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'fixture' },
    }), { mode: 0o600 })
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...env }
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
})

function rename(id: string, name: unknown, withHeaders = true) {
    return PATCH(new Request(`${origin}/api/desktop/agents/${id}`, { method: 'PATCH', headers: withHeaders ? headers : {}, body: JSON.stringify({ name }) }), { params: Promise.resolve({ agentId: id }) })
}

it('uses the engine handle namespace, preserves both owner IDs and returns the updated board row', async () => {
    const db = await openDesktopDatabase(root)
    const a = await createDesktopAgent(db, { engineAgentId: 'owner-a', name: 'Alice' })
    const b = await createDesktopAgent(db, { engineAgentId: 'owner-b', name: 'Studio' })
    const chat = await createDesktopSession(db, { agentId: a.id, engineSessionId: 'chat-a', title: 'Keep my chat' })
    const response = await rename(a.id, '  Studio  ')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ agent: { id: a.id, name: 'Studio' } })
    expect(patches).toEqual([{ id: 'owner-a', body: { name: 'studio_3', displayName: 'Studio' } }])
    expect(await findDesktopAgent(db, a.id)).toMatchObject({ engineAgentId: 'owner-a', name: 'Studio' })
    expect(await findDesktopAgent(db, b.id)).toEqual(b)
    expect(await listDesktopSessions(db, a.id)).toEqual([chat])
    expect((await rename(a.id, 'Studio')).status).toBe(200)
    expect(patches).toHaveLength(1)
    expect((await rename(a.id, 'STUDIO')).status).toBe(200)
    expect(patches.at(-1)?.body).toEqual({ name: 'studio_3', displayName: 'STUDIO' })
})

it('allocates distinct handles for simultaneous requests and keeps invalid requests out of the engine', async () => {
    const db = await openDesktopDatabase(root)
    const a = await createDesktopAgent(db, { engineAgentId: 'owner-a', name: 'Alice' })
    const b = await createDesktopAgent(db, { engineAgentId: 'owner-b', name: 'Studio' })
    for (const name of ['', '  ', 'a'.repeat(61), 4]) expect((await rename(a.id, name)).status).toBe(400)
    expect((await rename('owner-a', 'Hidden')).status).toBe(404)
    expect((await rename(a.id, 'Hidden', false)).ok).toBe(false)
    expect(patches).toEqual([])
    const responses = await Promise.all([rename(a.id, 'Écho'), rename(b.id, 'Écho')])
    expect(responses.map(r => r.status)).toEqual([200, 200])
    expect([...new Set([engine.get('owner-a')!.name, engine.get('owner-b')!.name])].sort()).toEqual(['echo', 'echo_2'])
})

it('recovers a committed engine rename after a lost reply without a second engine write', async () => {
    const db = await openDesktopDatabase(root)
    const a = await createDesktopAgent(db, { engineAgentId: 'owner-a', name: 'Alice' })
    const b = await createDesktopAgent(db, { engineAgentId: 'owner-b', name: 'Studio' })
    connected = false
    expect((await rename(a.id, 'New')).status).toBe(502)
    expect((await findDesktopAgent(db, a.id))?.name).toBe('Alice')
    expect(patches).toHaveLength(0)
    connected = true
    loseReply = true
    expect((await rename(a.id, 'New')).status).toBe(502)
    expect(engine.get('owner-a')).toEqual({ name: 'new', displayName: 'New' })
    expect((await findDesktopAgent(db, a.id))?.name).toBe('Alice')
    await closeDesktopDatabase(root)
    connected = true
    loseReply = false
    const restored = await list(new Request(`${origin}/api/desktop/agents`, { headers }))
    expect(restored.status).toBe(200)
    expect((await restored.json()).agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: a.id, name: 'New' }), expect.objectContaining({ id: b.id, name: 'Studio' })]))
    expect((await rename(a.id, 'New')).ok).toBe(true)
    expect(patches).toHaveLength(1)
})

it('ignores a stale engine acknowledgement when a newer operation owns the projection', async () => {
    const db = await openDesktopDatabase(root)
    const a = await createDesktopAgent(db, { engineAgentId: 'owner-a', name: 'Alice' })
    afterEnginePatch = async () => {
        // Another bundle persisted a newer intent while the old engine response was in flight.
        await db.execute({
            sql: 'UPDATE desktop_rename_checks SET operation_id = ?, name = ?, handle = ? WHERE agent_id = ?',
            args: ['newer-operation', 'Newest', 'newest', a.id],
        })
        engine.set('owner-a', { name: 'newest', displayName: 'Newest' })
    }
    const stale = await rename(a.id, 'Older')
    expect((await stale.json()).agent.name).toBe('Alice')
    expect((await db.execute('SELECT operation_id FROM desktop_rename_checks')).rows[0]?.operation_id).toBe('newer-operation')
    const refreshed = await list(new Request(`${origin}/api/desktop/agents`, { headers }))
    expect((await refreshed.json()).agents[0]).toMatchObject({ id: a.id, name: 'Newest' })
})
