import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Client } from '@libsql/client'
vi.mock('server-only', () => ({}))
const runtime = vi.hoisted(() => ({ dataRoot: '', app: { origin: 'http://127.0.0.1:3189', sessionToken: 'preference-session' } }))
vi.mock('./runtime', () => ({ readDesktopRuntime: async () => runtime }))
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { createDesktopAgent } from './store'
import { readDesktopDataPreference, writeDesktopDataPreference } from './data-preferences'
import { desktopDataPreferenceRoute } from './data-preference-route'

let root: string, db: Client, a: string, b: string
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'desktop-preferred-view-'))
    runtime.dataRoot = root
    db = await openDesktopDatabase(root)
    a = (await createDesktopAgent(db, { engineAgentId: 'pref-a', name: 'A' })).id
    b = (await createDesktopAgent(db, { engineAgentId: 'pref-b', name: 'B' })).id
})
afterEach(async () => { await closeDesktopDatabase(root); await rm(root, { recursive: true, force: true }) })

it('persists independently for each coworker, shared scope and table across a real close/reopen', async () => {
    await writeDesktopDataPreference(db, { kind: 'agent', agentId: a }, { table: 'notes', viewId: 'a-gallery' })
    await writeDesktopDataPreference(db, { kind: 'agent', agentId: b }, { table: 'notes', viewId: 'b-list' })
    await writeDesktopDataPreference(db, { kind: 'shared' }, { table: 'notes', viewId: 'shared-board' })
    await writeDesktopDataPreference(db, { kind: 'agent', agentId: a }, { table: 'other', viewId: '__all' })
    await closeDesktopDatabase(root)
    db = await openDesktopDatabase(root)
    expect(await readDesktopDataPreference(db, { kind: 'agent', agentId: a }, 'notes')).toBe('a-gallery')
    expect(await readDesktopDataPreference(db, { kind: 'agent', agentId: b }, 'notes')).toBe('b-list')
    expect(await readDesktopDataPreference(db, { kind: 'shared' }, 'notes')).toBe('shared-board')
    expect(await readDesktopDataPreference(db, { kind: 'agent', agentId: a }, 'other')).toBe('__all')
})

it('clears only its table, rejects nonexistent/deleting owners and cascades only the removed owner', async () => {
    await writeDesktopDataPreference(db, { kind: 'agent', agentId: a }, { table: 'notes', viewId: 'saved' })
    await writeDesktopDataPreference(db, { kind: 'shared' }, { table: 'notes', viewId: 'shared' })
    await writeDesktopDataPreference(db, { kind: 'agent', agentId: a }, { table: 'notes', viewId: null })
    expect(await readDesktopDataPreference(db, { kind: 'agent', agentId: a }, 'notes')).toBeNull()
    expect(await readDesktopDataPreference(db, { kind: 'shared' }, 'notes')).toBe('shared')
    await expect(writeDesktopDataPreference(db, { kind: 'agent', agentId: 'missing' }, { table: 'notes', viewId: 'bad' })).rejects.toThrow()
    await db.execute({ sql: 'INSERT INTO desktop_deletions(agent_id,engine_agent_id,name) VALUES (?,?,?)', args: [b, 'pref-b', 'B'] })
    await expect(writeDesktopDataPreference(db, { kind: 'agent', agentId: b }, { table: 'notes', viewId: 'bad' })).rejects.toThrow()
    await writeDesktopDataPreference(db, { kind: 'agent', agentId: a }, { table: 'notes', viewId: 'saved' })
    await db.execute({ sql: 'DELETE FROM desktop_agents WHERE id=?', args: [a] })
    expect((await db.execute('SELECT scope_key FROM desktop_data_preferences')).rows).toEqual([{ scope_key: 'shared' }])
})

it('refuses scope injection and invalid/internal table identifiers', async () => {
    await expect(writeDesktopDataPreference(db, { kind: 'agent', agentId: a }, { table: 'notes', viewId: 'saved', agentId: b })).rejects.toThrow('Invalid preferred view')
    await expect(writeDesktopDataPreference(db, { kind: 'shared' }, { table: '_rerun_views', viewId: 'saved' })).rejects.toThrow('Invalid preferred view')
    expect((await db.execute('SELECT * FROM desktop_data_preferences')).rows).toHaveLength(0)
})

it('authenticates the real preference endpoint and keeps route-selected ownership fixed', async () => {
    const request = (method: string, body?: unknown, extra?: Record<string, string>) => new Request(`${runtime.app.origin}/api/desktop/shared-data/preferred-view?table=notes`, {
        method, headers: { host: '127.0.0.1:3189', origin: runtime.app.origin, cookie: 'rerun-desktop-session=preference-session', 'content-type': 'application/json', ...extra },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    expect((await desktopDataPreferenceRoute(request('GET', undefined, { cookie: '' }), { kind: 'shared' })).status).toBe(401)
    expect((await desktopDataPreferenceRoute(request('PUT', { table: 'notes', viewId: 'bad' }, { origin: 'https://foreign.example' }), { kind: 'shared' })).status).toBe(403)
    const saved = await desktopDataPreferenceRoute(request('PUT', { table: 'notes', viewId: 'gallery' }), { kind: 'agent', agentId: a })
    expect(await saved.json()).toEqual({ saved: true })
    expect(await (await desktopDataPreferenceRoute(request('GET'), { kind: 'shared' })).json()).toEqual({ viewId: null })
    expect(await (await desktopDataPreferenceRoute(request('GET'), { kind: 'agent', agentId: a })).json()).toEqual({ viewId: 'gallery' })
    expect((await desktopDataPreferenceRoute(request('PUT', { table: 'notes', viewId: 'gallery', agentId: b }), { kind: 'agent', agentId: a })).status).toBe(400)
    expect((await desktopDataPreferenceRoute(request('PUT', { table: 'notes', viewId: 'x'.repeat(3_000) }), { kind: 'shared' })).status).toBe(413)
})
