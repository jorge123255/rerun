import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('../auth', () => ({ authenticateDesktopEngineRequest: vi.fn(async () => { throw new Error('not the engine') }) }))
vi.mock('../database', () => ({ openDesktopDatabase: vi.fn() }))
vi.mock('../mcp-binding', () => ({ getDesktopRemoteMcpService: vi.fn() }))
const { initializeDesktopRound61 } = await import('../round61-schema')
const { handleDesktopBrowserPress } = await import('./browser-press')
const { decideConnectorApproval, readConnectorApprovals } = await import('./store')

let db: Client, dir: string
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'browser-press-'))
    db = createClient({ url: `file:${join(dir, 'app.db')}` })
    await db.execute('CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY, id TEXT NOT NULL)')
    await initializeDesktopRound61(db)
})
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

const identity = { engineAgentId: 'engine-1', sessionId: 'chat-1', runId: 'run-1' }
const press = { kind: 'pay', label: 'Pay now', host: 'checkout.example.test', via: 'click' }
const post = (body: unknown) => new Request('http://127.0.0.1/api/desktop/internal/browser-press', { method: 'POST', body: JSON.stringify(body) })
const ports = (authorize = vi.fn(async () => 'coworker-1')) => ({ authorize, db: async () => db })

it('holds a press, then admits exactly one after the person allows it', async () => {
    const wired = ports()
    const held = await (await handleDesktopBrowserPress(post({ identity, press }), wired)).json()
    expect(held.ok).toBe(false)
    expect(held.reason).toMatch(/Nothing was pressed/)
    expect(wired.authorize).toHaveBeenCalledWith(identity, expect.any(AbortSignal))
    const id = (await readConnectorApprovals(db, 'chat-1')).pending[0]!.id
    await decideConnectorApproval(db, 'chat-1', id, 'once')
    expect(await (await handleDesktopBrowserPress(post({ identity, press }), wired)).json()).toEqual({ ok: true })
    expect((await (await handleDesktopBrowserPress(post({ identity, press }), wired)).json()).ok).toBe(false)
})

it('admits nothing for a run that is not allowed to use the browser, a malformed request, or a caller that is not the engine', async () => {
    const refusedRun = ports(vi.fn(async () => { throw new Error('Run is no longer active') }))
    for (const response of [
        await handleDesktopBrowserPress(post({ identity, press }), refusedRun),
        await handleDesktopBrowserPress(post({ identity, press: { ...press, kind: 'share' } }), ports()),
        await handleDesktopBrowserPress(post({ identity, press: { ...press, label: 'x'.repeat(81) } }), ports()),
        await handleDesktopBrowserPress(post({ identity, press, allow: true }), ports()),
        await handleDesktopBrowserPress(post({ identity, press })),
    ]) {
        const body = await response.json()
        expect(body.ok).toBe(false)
        expect(body.reason).toMatch(/nothing was pressed/)
        expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect((await readConnectorApprovals(db, 'chat-1')).pending).toEqual([])
})
