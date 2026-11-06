import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, test } from 'vitest'
import { desktopMcpSecretReferenceCanonical, type DesktopMcpSecretReferenceConfig } from '../../../../../../packages/contracts/src/desktop-mcp-secret-references'
import { secretReferenceFingerprint } from '../../../../components/desktop/mcp-secret-references/editor-state'
import { ensureDesktopMcpSecretReferenceSchema } from './schema'
import { createDesktopMcpSecretReferenceStore, DesktopMcpSecretReferenceConflict } from './store'

let db: Client
afterEach(() => db?.close())

const config = (overrides: Partial<DesktopMcpSecretReferenceConfig> = {}): DesktopMcpSecretReferenceConfig => ({
    name: 'linear',
    transport: 'http',
    args: [],
    url: 'https://mcp.example/mcp',
    env: {},
    headers: { Authorization: 'Bearer ${LINEAR_API_KEY}' },
    oauth: false,
    literalAuthorization: false,
    preservedLiteralKeys: [],
    ...overrides,
})

const BEARER = 'Bearer mine-token-value'
const SEALED = 'sealed-row-must-stay-unread'

async function setup() {
    db = createClient({ url: ':memory:' })
    await db.executeMultiple(`
        CREATE TABLE desktop_agents (id TEXT PRIMARY KEY);
        CREATE TABLE desktop_secret_credentials (
            agent_id TEXT NOT NULL,
            key TEXT NOT NULL,
            version INTEGER NOT NULL,
            sealed_value TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (agent_id, key)
        );
        CREATE TABLE port_log (agent_id TEXT, server_name TEXT, revision INTEGER, public_json TEXT);
    `)
    await db.execute({ sql: 'INSERT INTO desktop_agents (id) VALUES (?)', args: ['coworker'] })
    await db.execute({ sql: 'INSERT INTO desktop_secret_credentials (agent_id, key, version, sealed_value, updated_at) VALUES (?, ?, ?, ?, ?)', args: ['coworker', 'LINEAR_API_KEY', 3, SEALED, '2026-11-05T00:00:00.000Z'] })
    await ensureDesktopMcpSecretReferenceSchema(db)
    const transaction = db.transaction.bind(db)
    db.transaction = (async mode => {
        const tx = await transaction(mode)
        const execute = tx.execute.bind(tx)
        tx.execute = (async statement => {
            const sql = typeof statement === 'string' ? statement : statement.sql
            if (/sealed_value/i.test(sql)) throw new Error('sealed value was read')
            return execute(statement)
        }) as typeof tx.execute
        return tx
    }) as typeof db.transaction
    let revision = 0
    let failAfterWrite = false
    const store = createDesktopMcpSecretReferenceStore(db, {
        authority: { currentOwner: async agentId => agentId === 'coworker' ? { agentId, enabled: true, deleting: false, selfMcpGranted: true, localMcpStdioGranted: true } : null },
        async commitPublicConfig(input) {
            await input.tx.execute({
                sql: 'INSERT INTO port_log (agent_id, server_name, revision, public_json) VALUES (?, ?, ?, ?)',
                args: [input.agentId, input.serverName, input.expectedConfigRevision, desktopMcpSecretReferenceCanonical(input.config)],
            })
            if (failAfterWrite) throw new DesktopMcpSecretReferenceConflict()
            if (input.expectedConfigRevision !== revision) throw new DesktopMcpSecretReferenceConflict()
            revision += 1
            return { configRevision: input.expectedConfigRevision }
        },
    })
    return { store, failNext() { failAfterWrite = true } }
}

async function saveBody(value: DesktopMcpSecretReferenceConfig, saveId = 'save-1', expectedConfigRevision = 0, expectedBindingRevision = 0) {
    return {
        saveId,
        agentId: 'coworker',
        serverName: value.name,
        expectedConfigRevision,
        expectedBindingRevision,
        origin: 'app://desktop',
        fingerprint: await secretReferenceFingerprint(value),
        config: value,
    }
}

test('a public save replays, conflicts on a changed body, and never stores the sealed credential', async () => {
    const { store } = await setup()
    const hiddenBearer = config({ headers: { Accept: 'application/json' }, literalAuthorization: true, preservedLiteralKeys: [{ field: 'header', key: 'Authorization' }] })
    const first = await store.save(await saveBody(hiddenBearer))
    expect(first.status).toBe('saved')
    expect(JSON.stringify(first)).not.toContain(BEARER)
    expect(JSON.stringify(first)).not.toContain(SEALED)
    const replay = await store.save(await saveBody(hiddenBearer))
    expect(replay.status).toBe('replayed')
    expect(replay.storedStatus).toBe('saved')
    const conflict = await store.save(await saveBody(config(), 'save-1'))
    expect(conflict.status).toBe('conflict')
    const head = await store.head('coworker', 'linear')
    expect(head?.publicJson).not.toContain(BEARER)
    expect(head?.publicJson).not.toContain(SEALED)
    expect(head?.publicJson).toContain('Authorization')
    const logs = await db.execute('SELECT public_json FROM port_log')
    expect(logs.rows).toHaveLength(1)
    expect(JSON.stringify(logs.rows)).not.toContain(SEALED)
})

test('a failed canonical config write rolls back the binding and the port row', async () => {
    const { store, failNext } = await setup()
    failNext()
    const result = await store.save(await saveBody(config()))
    expect(result.status).toBe('conflict')
    expect((await db.execute('SELECT * FROM port_log')).rows).toHaveLength(0)
    expect((await db.execute('SELECT * FROM desktop_mcp_secret_reference_heads')).rows).toHaveLength(0)
    expect((await db.execute('SELECT * FROM desktop_mcp_secret_references')).rows).toHaveLength(0)
})

test('a missing credential stays pending and records only its name and version slot', async () => {
    const { store } = await setup()
    const pendingConfig = config({ headers: { Authorization: 'Bearer ${OTHER_API_KEY}' } })
    const result = await store.save(await saveBody(pendingConfig))
    expect(result.status).toBe('pending')
    expect(result.pending).toEqual(['OTHER_API_KEY'])
    expect(result.bound).toEqual([])
    expect(result.message).toContain('not accepted')
    const rows = await db.execute('SELECT secret_name, secret_version, status FROM desktop_mcp_secret_references')
    expect(rows.rows).toHaveLength(1)
    expect(String(rows.rows[0]?.secret_name)).toBe('OTHER_API_KEY')
    expect(rows.rows[0]?.secret_version ?? null).toBeNull()
    expect(String(rows.rows[0]?.status)).toBe('pending')
})
