import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./vault/binding', () => ({ openDesktopVault: vi.fn() }))
vi.mock('./database', () => ({ openDesktopDatabase: vi.fn() }))
const { desktopConnectorApps, readConnectorSources } = await import('./coworker-connectors')

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const AGENT = id(1)
const entry = { revision: id(9), sharedWithAll: false }

test('names each server after its app with bundled artwork, and leaves unknown servers plain', () => {
    const listing = desktopConnectorApps(AGENT, {
        vault: [
            { ...entry, id: id(2), name: 'linear-2', kind: 'mcp', url: 'https://mcp.linear.app/mcp', hasBearer: true, catalog: { slug: 'linear', methodId: 'key', name: 'Linear', label: 'Work' } },
            { ...entry, id: id(3), name: 'internal', kind: 'mcp', url: 'https://internal.example/mcp', hasBearer: false },
            { ...entry, id: id(4), name: 'local-db', kind: 'program', executable: '/usr/bin/db-mcp' },
            { ...entry, id: id(5), name: 'API key', variable: 'API_KEY' },
        ],
        services: [{ serverName: 'notion', slug: 'notion', name: 'Notion', category: 'productivity', icon: 'https://remote.example/notion.png' }],
        servers: ['notion', 'scratch'],
        managed: [],
    })
    const linear = listing.servers.find(row => row.server === 'linear-2')
    expect(linear).toMatchObject({ slug: 'linear', name: 'Linear', label: 'Work' })
    expect(linear?.icon).toMatch(/^\/services\/linear\./)
    // A service keeps its own entry over the plain server of the same name; a remote picture is never passed on.
    expect(listing.servers.filter(row => row.server === 'notion')).toHaveLength(1)
    expect(listing.servers.find(row => row.server === 'notion')?.icon ?? '').not.toContain('https://')
    for (const name of ['internal', 'local-db', 'scratch']) expect(listing.servers.find(row => row.server === name)).toMatchObject({ custom: true, icon: null })
    expect(listing.servers.map(row => row.server)).not.toContain('API key')
    // No Composio and no managed account: no toolkit can name a row.
    expect(listing.toolkits).toEqual([])
    expect(JSON.stringify(listing)).not.toMatch(/https?:\/\//)
})

test('a managed account names its toolkit, and Composio brings the bundled apps', () => {
    const managed = desktopConnectorApps(AGENT, { vault: [], services: [], servers: [], managed: [{ toolkit: 'gmail', name: 'Gmail', label: 'Personal' }, { toolkit: 'UNLISTED_APP', name: 'Unlisted', label: '' }] })
    expect(managed.toolkits.find(row => row.key === 'gmail')).toMatchObject({ name: 'Gmail', label: 'Personal' })
    expect(managed.toolkits.find(row => row.key === 'gmail')?.icon).toMatch(/^\/services\//)
    expect(managed.toolkits.find(row => row.key === 'unlistedapp')).toMatchObject({ name: 'Unlisted', icon: null })
    const connect = desktopConnectorApps(AGENT, { vault: [{ ...entry, id: id(6), name: 'composio', kind: 'mcp', url: 'https://connect.composio.dev/mcp', hasBearer: false, headerName: 'x-consumer-api-key' }], services: [], servers: [], managed: [] })
    expect(connect.servers).toEqual([expect.objectContaining({ server: 'composio', name: 'Composio' })])
    expect(connect.toolkits.find(row => row.key === 'googlecalendar')).toMatchObject({ slug: 'google-calendar' })
    expect(connect.toolkits.every(row => row.icon === null || row.icon.startsWith('/services/'))).toBe(true)
})

let db: Client, dir: string
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'coworker-connectors-'))
    db = createClient({ url: `file:${join(dir, 'app.db')}` })
})
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

test('reads only this coworker’s rows, and a profile without the tables has none', async () => {
    expect(await readConnectorSources(db, AGENT)).toEqual({ services: [], servers: [], managed: [] })
    await db.executeMultiple(`
        CREATE TABLE desktop_service_installs (owner TEXT, key TEXT, id TEXT, state TEXT, plan TEXT, installed_at TEXT);
        CREATE TABLE desktop_vault_catalog_adoptions (installation_id TEXT);
        CREATE TABLE desktop_remote_mcp (agent_id TEXT, name TEXT);
        CREATE TABLE desktop_mcp_stdio (owner TEXT, name TEXT);
        CREATE TABLE desktop_managed_app_accounts (id TEXT, toolkit TEXT, name TEXT, label TEXT);
        CREATE TABLE desktop_managed_app_attachments (account_id TEXT, agent_id TEXT);
    `)
    const plan = (slug: string) => JSON.stringify({ slug, name: slug.toUpperCase(), category: 'dev', icon: null, serverName: slug })
    await db.batch([
        { sql: 'INSERT INTO desktop_service_installs VALUES(?,?,?,?,?,?)', args: [AGENT, 'a', 'i1', 'ready', plan('github'), '2026-01-02'] },
        { sql: 'INSERT INTO desktop_service_installs VALUES(?,?,?,?,?,?)', args: [AGENT, 'b', 'i2', 'disconnected', plan('sentry'), '2026-01-03'] },
        { sql: 'INSERT INTO desktop_service_installs VALUES(?,?,?,?,?,?)', args: [AGENT, 'c', 'i3', 'ready', plan('adopted'), '2026-01-04'] },
        { sql: 'INSERT INTO desktop_service_installs VALUES(?,?,?,?,?,?)', args: [AGENT, 'd', 'i4', 'ready', 'not json', '2026-01-05'] },
        { sql: 'INSERT INTO desktop_service_installs VALUES(?,?,?,?,?,?)', args: [id(7), 'a', 'i5', 'ready', plan('other'), '2026-01-06'] },
        "INSERT INTO desktop_vault_catalog_adoptions VALUES('i3')",
        { sql: 'INSERT INTO desktop_remote_mcp VALUES(?,?),(?,?)', args: [AGENT, 'remote', id(7), 'theirs'] },
        { sql: 'INSERT INTO desktop_mcp_stdio VALUES(?,?)', args: [AGENT, 'local'] },
        "INSERT INTO desktop_managed_app_accounts VALUES('acc1','gmail','Gmail','Work'),('acc2','slack','Slack','')",
        { sql: 'INSERT INTO desktop_managed_app_attachments VALUES(?,?),(?,?)', args: ['acc1', AGENT, 'acc2', id(7)] },
    ])
    expect(await readConnectorSources(db, AGENT)).toEqual({
        services: [{ serverName: 'github', slug: 'github', name: 'GITHUB', category: 'dev', icon: null }],
        servers: ['remote', 'local'],
        managed: [{ toolkit: 'gmail', name: 'Gmail', label: 'Work' }],
    })
})
