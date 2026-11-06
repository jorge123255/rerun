import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, it, vi } from 'vitest'
import { remoteMcpStore, remoteMcpSchema, remoteMcpOAuthSchema } from '../mcp/store'
import { createSseSettings } from './settings'
import { migrateDesktopSse } from './schema'
import { desktopSseClient } from '../../mcp-sse-client'
import { sseEditorSlot } from '@/components/desktop/mcp-sse/editor-state'

const mock = vi.hoisted(() => ({ db: undefined as Client | undefined, settings: undefined as ReturnType<typeof createSseSettings> | undefined, authenticated: true }))
vi.mock('../auth', async importOriginal => ({ ...await importOriginal<typeof import('../auth')>(), authenticateDesktopRequest: async () => { if (!mock.authenticated) throw new Error('refused'); return { dataRoot: 'test' } } }))
vi.mock('../database', () => ({ openDesktopDatabase: async () => mock.db }))
vi.mock('../mcp-binding', () => ({ getDesktopRemoteMcpService: async () => ({ access: async (owner: string) => { if (owner !== 'owner') throw new Error('owner'); return { enabled: true, granted: false } }, sse: { settings: mock.settings } }) }))
import { handleDesktopSse } from './api'
const resources: Array<{ db: Client; folder: string }> = []
afterEach(async () => { vi.unstubAllGlobals(); mock.authenticated = true; for (const resource of resources.splice(0)) { resource.db.close(); await rm(resource.folder, { recursive: true, force: true }) } })
async function fixture() {
    const folder = await mkdtemp(join(tmpdir(), 'sse-api-')), db = createClient({ url: `file:${join(folder, 'app.db')}` })
    resources.push({ db, folder }); mock.db = db
    await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('owner');" + remoteMcpSchema + remoteMcpOAuthSchema)
    await migrateDesktopSse(db)
    const store = remoteMcpStore(db, () => Buffer.alloc(32, 1))
    mock.settings = createSseSettings(db, store, async () => () => {}, async () => {})
    return { db, store }
}

it('the concrete API and client recover one saved server across a new app origin after a lost acknowledgement', async () => {
    const f = await fixture(), signal = new AbortController().signal
    let lose = true, origin = 'http://127.0.0.1:3001'
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
        const request = new Request(origin + url, options), response = await handleDesktopSse(request, 'owner')
        if (lose && JSON.parse(String(options.body)).action === 'mutate') { lose = false; throw new Error('connection lost') }
        return response
    })
    const first = desktopSseClient('owner'), slot = sseEditorSlot('owner')
    const change = { agentId: 'owner', requestId: crypto.randomUUID(), serverId: null, expectedRevision: null, configuration: { name: 'fixture', transport: 'sse' as const, url: 'https://example.com/sse' } }
    await first.editor.journal.put(slot, { kind: 'save', change }, signal)
    await expect(first.editor.save(change, signal)).rejects.toThrow('connection lost')
    expect(await f.store.list('owner')).toHaveLength(1)
    origin = 'http://127.0.0.1:4002'
    const reopened = desktopSseClient('owner')
    expect(await reopened.editor.journal.read(slot, signal)).toEqual({ kind: 'save', change })
    const outcome = await reopened.editor.reconcile('owner', change.requestId, signal)
    expect(outcome).toMatchObject({ requestId: change.requestId, status: 'saved' })
    await reopened.editor.journal.clear(slot, change.requestId, signal)
    expect(await reopened.editor.journal.read(slot, signal)).toBeNull()
    expect(await f.store.list('owner')).toHaveLength(1)
})

it('rejects unauthenticated requests and crossed owners or editor slots before mutation', async () => {
    const f = await fixture()
    const input = { kind: 'save', agentId: 'other', requestId: crypto.randomUUID(), serverId: null, expectedRevision: null, configuration: { name: 'fixture', transport: 'sse', url: 'https://example.com/sse' } }
    const send = (body: unknown) => handleDesktopSse(new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body) }), 'owner')
    expect((await send({ action: 'mutate', input })).ok).toBe(false)
    expect((await send({ action: 'journal-put', slot: sseEditorSlot('other'), input: { ...input, agentId: 'owner' } })).ok).toBe(false)
    mock.authenticated = false
    expect((await send({ action: 'mutate', input: { ...input, agentId: 'owner' } })).ok).toBe(false)
    expect(await f.store.list('owner')).toEqual([])
    expect((await f.db.execute('SELECT * FROM desktop_mcp_sse_editors')).rows).toEqual([])
})
