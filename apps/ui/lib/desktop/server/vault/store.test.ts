import { createClient } from '@libsql/client'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { desktopVaultMutation } from '../../vault'
import { DesktopHttpError } from '../auth'
import { initializeDesktopRound45 } from '../round45-schema'
import { initializeDesktopRound46 } from '../round46-schema'
import { createCanonicalMcpSecretReferences } from '../mcp-secret-references/binding'
import { ensureDesktopMcpSecretReferenceSchema } from '../mcp-secret-references/schema'
import { desktopMcpSecretReferenceCanonical, type DesktopMcpSecretReferenceConfig } from '@rerun/contracts'
import { createDesktopSecretCrypto } from '../secret-requests/crypto'
import { desktopVault } from './store'

const key = Buffer.alloc(32, 7)
const crypto = createDesktopSecretCrypto(() => key)
const allow = () => {}
const firstAgent = randomUUID(), secondAgent = randomUUID(), foreignAgent = randomUUID()
const secret = 'fixture-value-never-in-a-projection'

async function fixture(migrate = true) {
    const root = await mkdtemp(join(tmpdir(), 'rerun-desktop-vault-'))
    const file = join(root, 'app.db')
    const open = () => createClient({ url: `file:${file}` })
    const db = open()
    await db.executeMultiple(`PRAGMA foreign_keys=ON;
        CREATE TABLE desktop_schema_migrations (version INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE);
        INSERT INTO desktop_schema_migrations VALUES (44,'keirolabs-search-credentials');
        CREATE TABLE desktop_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id INTEGER NOT NULL);
        CREATE TABLE desktop_deletions (agent_id TEXT NOT NULL, completed INTEGER NOT NULL);
        CREATE TABLE desktop_secret_credentials (agent_id TEXT NOT NULL,key TEXT NOT NULL,version INTEGER NOT NULL,sealed_value TEXT NOT NULL);
        CREATE TABLE desktop_mcp_stdio (owner TEXT NOT NULL,name TEXT NOT NULL,executable TEXT NOT NULL,args TEXT NOT NULL,revision TEXT NOT NULL);`)
    await db.batch([firstAgent, secondAgent, foreignAgent].map((id, i) => ({
        sql: 'INSERT INTO desktop_agents VALUES (?,?,?)', args: [id, ['First', 'Second', 'Foreign'][i], i === 2 ? 2 : 1],
    })), 'write')
    await initializeDesktopRound45(db)
    if (migrate) await initializeDesktopRound46(db)
    return { db, root, file, open, vault: desktopVault(db, crypto, 7) }
}

test('upgrades a prior workspace, saves redacted metadata, rotates ciphertext, and reopens without exposing values', async () => {
    const f = await fixture()
    try {
        const result = await f.vault.mutate({ operation: 'create', name: 'Team key', variable: 'TEAM_KEY', value: secret }, allow)
        const [entry] = result.entries
        expect(result).toEqual({ coworkers: [{ id: firstAgent, name: 'First' }, { id: secondAgent, name: 'Second' }],
            entries: [{ id: entry.id, revision: entry.revision, name: 'Team key', variable: 'TEAM_KEY', agentIds: [], sharedWithAll: false }] })
        const row = async () => (await f.db.execute('SELECT sealed,value_revision FROM desktop_vault_secrets')).rows[0]
        const before = await row()
        const context = { domain: 'vault' as const, agentId: entry.id, key: entry.variable, workspaceId: 7, version: 1, revision: String(before.value_revision) }
        expect(Buffer.from(await crypto.open(context, String(before.sealed))).toString()).toBe(secret)
        await expect(crypto.open({ ...context, workspaceId: 8 }, String(before.sealed))).rejects.toThrow()
        const updated = await f.vault.mutate({ operation: 'replace', id: entry.id, revision: entry.revision, value: 'rotated-fixture' }, allow)
        const after = await row()
        expect(after.sealed).not.toBe(before.sealed)
        await expect(crypto.open({ ...context, revision: String(after.value_revision) }, String(before.sealed))).rejects.toThrow()
        const reopened = f.open()
        try {
            await initializeDesktopRound45(reopened)
            await initializeDesktopRound46(reopened)
            expect(await desktopVault(reopened, crypto, 7).list()).toEqual(updated)
            expect((await reopened.execute('SELECT version FROM desktop_schema_migrations ORDER BY version')).rows).toEqual([{ version: 44 }, { version: 45 }, { version: 46 }])
            expect((await reopened.execute('PRAGMA foreign_key_check')).rows).toEqual([])
        } finally { reopened.close() }
        expect((await readFile(f.file)).includes(secret)).toBe(false)
        expect((await readFile(f.file)).includes('rotated-fixture')).toBe(false)
        expect(desktopVaultMutation.safeParse({ operation: 'replace', id: entry.id, revision: entry.revision, value: '•••' }).success).toBe(false)
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})

test('serializes conflicting assignments, rejects foreign and stale targets, and detaches safely', async () => {
    const f = await fixture()
    try {
        for (const name of ['First key', 'Second key']) await f.vault.mutate({ operation: 'create', name, variable: 'SAME_KEY', value: secret }, allow)
        const [first, second] = (await f.vault.list()).entries
        const share = (entry: typeof first, agentIds: string[], sharedWithAll = false) =>
            f.vault.mutate({ operation: 'share', id: entry.id, revision: entry.revision, agentIds, sharedWithAll }, allow)
        await expect(share(first, [foreignAgent])).rejects.toMatchObject({ status: 409 })
        const outcomes = await Promise.allSettled([share(first, [firstAgent]), share(second, [firstAgent])])
        expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
        expect(outcomes[1]).toMatchObject({ reason: { status: 409, code: 'vault_conflict' } })
        await expect(share(second, [], true)).rejects.toMatchObject({ code: 'vault_conflict' })
        const [a, b] = (await share(second, [secondAgent])).entries
        expect(b.agentIds).toEqual([secondAgent])
        await expect(share(first, [])).rejects.toMatchObject({ status: 409 })
        await share(a, [])
        await f.db.execute({ sql: 'INSERT INTO desktop_deletions VALUES (?,0)', args: [secondAgent] })
        expect((await f.vault.list()).entries.find(entry => entry.id === b.id)?.agentIds).toEqual([])
        await f.vault.mutate({ operation: 'delete', id: b.id, revision: b.revision }, allow)
        expect((await f.vault.list()).entries).toHaveLength(1)
        expect((await f.db.execute('SELECT * FROM desktop_vault_attachments')).rows).toEqual([])
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})

test('a freeze before commit discards the secret and its metadata', async () => {
    const f = await fixture()
    try {
        let checks = 0
        const assertCurrent = () => {
            if (++checks === 3) throw new DesktopHttpError(409, 'Workspace changed')
        }
        await expect(f.vault.mutate({ operation: 'create', name: 'Key', variable: 'TEAM_KEY', value: secret }, assertCurrent)).rejects.toMatchObject({ status: 409 })
        expect((await f.vault.list()).entries).toEqual([])
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})

const server: DesktopMcpSecretReferenceConfig = {
    name: 'vault-fixture', transport: 'stdio', command: '/usr/local/bin/vault-fixture', args: [],
    env: { TEST_TOKEN: '${TEAM_KEY}' }, headers: {}, oauth: false, literalAuthorization: false, preservedLiteralKeys: [],
}
const origin = 'desktop-workspace-1'

function canonical(db: Awaited<ReturnType<typeof fixture>>['db']) {
    let granted = true
    const signal = new AbortController().signal
    const references = createCanonicalMcpSecretReferences({
        db, origin, workspaceId: 7, key: () => key, shutdown: signal,
        owner: async agentId => ({ agentId, enabled: true, deleting: false, selfMcpGranted: granted, localMcpStdioGranted: granted, remoteMcpGranted: false, check: allow }),
        mutate: async (_owner, _server, work) => work(),
        async configuration(owner, name) {
            const row = (await db.execute({ sql: 'SELECT revision FROM desktop_mcp_stdio WHERE owner=? AND name=?', args: [owner, name] })).rows[0]
            return { revision: String(row?.revision), config: { ...server, env: {} } }
        },
    })
    return {
        ...references,
        setGranted(value: boolean) { granted = value },
        async saveReference(agentId: string, revision: string, bindingRevision: number) {
            return references.save({
                saveId: randomUUID(), agentId, serverName: server.name, origin,
                expectedConfigRevision: revision, expectedBindingRevision: bindingRevision,
                config: server, fingerprint: createHash('sha256').update(desktopMcpSecretReferenceCanonical(server)).digest('hex'),
            }, signal)
        },
        snapshotFor: (agentId: string) => references.snapshot(agentId, server.name, signal),
        materialFor: (agentId: string, revision: string) => references.material(agentId, server.name, revision, 'invocation', signal),
    }
}

test('round 46 upgrades an attached secret from an existing Vault, binds it, and reopens the same credential generation', async () => {
    const f = await fixture(false)
    try {
        // These two writes use the original round 45 schema, before credential generations existed.
        const [item] = (await f.vault.mutate({ operation: 'create', name: 'Key', variable: 'TEAM_KEY', value: secret }, allow)).entries
        await f.vault.mutate({ operation: 'share', id: item.id, revision: item.revision, agentIds: [firstAgent], sharedWithAll: false }, allow)
        await initializeDesktopRound46(f.db)
        await f.db.execute({ sql: 'INSERT INTO desktop_mcp_stdio VALUES(?,?,?,?,?)', args: [firstAgent, server.name, server.command!, '[]', 'original'] })
        await ensureDesktopMcpSecretReferenceSchema(f.db)
        const saved = await canonical(f.db).saveReference(firstAgent, 'original', 0)
        expect(saved).toMatchObject({ status: 'saved', bound: [{ name: 'TEAM_KEY', version: expect.any(Number) }] })
        expect(JSON.stringify(saved)).not.toContain(secret)
        const reopened = f.open()
        try {
            await initializeDesktopRound46(reopened)
            const runtime = canonical(reopened)
            expect((await runtime.snapshotFor(firstAgent)).presence).toEqual([{ name: 'TEAM_KEY', configured: true }])
            expect(await runtime.lookup.version(secondAgent, 'TEAM_KEY', { check: allow })).toEqual({ state: 'missing' })
            const lease = await runtime.materialFor(firstAgent, saved.configRevision)
            try {
                expect(lease.material.env).toEqual({ TEST_TOKEN: secret })
                expect(lease.material.inheritEnv).toBe(false)
                expect(JSON.stringify(lease.protect({ result: secret }))).not.toContain(secret)
                runtime.setGranted(false)
                await expect(lease.check()).rejects.toThrow('permission is off')
            } finally { await lease.release() }
            await expect(runtime.materialFor(firstAgent, saved.configRevision)).rejects.toThrow()
        } finally { reopened.close() }
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})

test('rotation, detach, reattach, and deletion fence already reviewed MCP bindings', async () => {
    const f = await fixture()
    try {
        const create = () => f.vault.mutate({ operation: 'create', name: 'Key', variable: 'TEAM_KEY', value: secret }, allow)
        let [entry] = (await create()).entries
        const share = async (agentIds: string[], sharedWithAll = false) => {
            [entry] = (await f.vault.mutate({ operation: 'share', id: entry.id, revision: entry.revision, agentIds, sharedWithAll }, allow)).entries
        }
        await share([], true)
        await f.db.execute({ sql: 'INSERT INTO desktop_mcp_stdio VALUES(?,?,?,?,?)', args: [firstAgent, server.name, server.command!, '[]', 'original'] })
        await ensureDesktopMcpSecretReferenceSchema(f.db)
        const runtime = canonical(f.db)
        expect(await runtime.lookup.version(foreignAgent, 'TEAM_KEY', { check: allow })).toEqual({ state: 'missing' })
        const saved = await runtime.saveReference(firstAgent, 'original', 0)
        expect(saved.status).toBe('saved')
        const lease = await runtime.materialFor(firstAgent, saved.configRevision)
        try {
            [entry] = (await f.vault.mutate({ operation: 'replace', id: entry.id, revision: entry.revision, value: 'rotated-fixture' }, allow)).entries
            await expect(lease.check()).rejects.toThrow('review the reference again')
        } finally { await lease.release() }
        expect((await runtime.snapshotFor(firstAgent)).presence).toEqual([{ name: 'TEAM_KEY', configured: false }])
        const reviewed = await runtime.saveReference(firstAgent, saved.configRevision, saved.bindingRevision)
        const reviewedVersion = reviewed.bound[0].version
        expect(reviewedVersion).not.toBe(saved.bound[0].version)
        await share([secondAgent])
        await expect(runtime.materialFor(firstAgent, reviewed.configRevision)).rejects.toThrow()
        await share([firstAgent])
        expect(await runtime.lookup.version(firstAgent, 'TEAM_KEY', { check: allow })).not.toEqual({ state: 'present', version: reviewedVersion })
        await expect(runtime.materialFor(firstAgent, reviewed.configRevision)).rejects.toThrow()
        await f.vault.mutate({ operation: 'delete', id: entry.id, revision: entry.revision }, allow)
        const recreated = await create()
        entry = recreated.entries[0]
        await share([firstAgent])
        await expect(runtime.materialFor(firstAgent, reviewed.configRevision)).rejects.toThrow()
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})

test('a private credential still resolves and cannot be silently replaced by an assigned Vault entry', async () => {
    const f = await fixture()
    try {
        const version = 4
        const sealed = await crypto.seal({ domain: 'credential', agentId: firstAgent, key: 'TEAM_KEY', version }, Buffer.from('private-fixture'))
        const writePrivate = () => f.db.execute({ sql: 'INSERT INTO desktop_secret_credentials VALUES(?,?,?,?)', args: [firstAgent, 'TEAM_KEY', version, sealed] })
        await writePrivate()
        const runtime = canonical(f.db)
        const gate = { check: allow }
        const consume = async (bytes: Uint8Array) => Buffer.from(bytes).toString()
        expect(await runtime.lookup.open(firstAgent, 'TEAM_KEY', version, gate, consume)).toEqual({ state: 'present', version, produced: 'private-fixture' })
        const [entry] = (await f.vault.mutate({ operation: 'create', name: 'Key', variable: 'TEAM_KEY', value: secret }, allow)).entries
        const share = () => f.vault.mutate({ operation: 'share', id: entry.id, revision: entry.revision, agentIds: [firstAgent], sharedWithAll: false }, allow)
        await expect(share()).rejects.toMatchObject({ code: 'vault_conflict' })
        await f.db.execute('DELETE FROM desktop_secret_credentials')
        await share()
        const assigned = await runtime.lookup.version(firstAgent, 'TEAM_KEY', gate)
        expect(assigned.state).toBe('present')
        if (assigned.state !== 'present') throw new Error('Missing Vault fixture')
        await writePrivate()
        expect(await runtime.lookup.version(firstAgent, 'TEAM_KEY', gate)).toEqual({ state: 'forbidden' })
        let consumed = false
        expect(await runtime.lookup.open(firstAgent, 'TEAM_KEY', assigned.version, gate, async () => { consumed = true })).toEqual({ state: 'forbidden' })
        expect(consumed).toBe(false)
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})
