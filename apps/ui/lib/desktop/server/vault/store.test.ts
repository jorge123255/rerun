import { createClient } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { desktopVaultMutation } from '../../vault'
import { DesktopHttpError } from '../auth'
import { initializeDesktopRound45 } from '../round45-schema'
import { createDesktopSecretCrypto } from '../secret-requests/crypto'
import { desktopVault } from './store'

const key = Buffer.alloc(32, 7)
const crypto = createDesktopSecretCrypto(() => key)
const allow = () => {}
const firstAgent = randomUUID(), secondAgent = randomUUID(), foreignAgent = randomUUID()
const secret = 'fixture-value-never-in-a-projection'

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rerun-desktop-vault-'))
    const file = join(root, 'app.db')
    const open = () => createClient({ url: `file:${file}` })
    const db = open()
    await db.executeMultiple(`PRAGMA foreign_keys=ON;
        CREATE TABLE desktop_schema_migrations (version INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE);
        INSERT INTO desktop_schema_migrations VALUES (44,'keirolabs-search-credentials');
        CREATE TABLE desktop_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id INTEGER NOT NULL);
        CREATE TABLE desktop_deletions (agent_id TEXT NOT NULL, completed INTEGER NOT NULL);`)
    await db.batch([firstAgent, secondAgent, foreignAgent].map((id, i) => ({
        sql: 'INSERT INTO desktop_agents VALUES (?,?,?)', args: [id, ['First', 'Second', 'Foreign'][i], i === 2 ? 2 : 1],
    })), 'write')
    await initializeDesktopRound45(db)
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
            expect(await desktopVault(reopened, crypto, 7).list()).toEqual(updated)
            expect((await reopened.execute('SELECT version FROM desktop_schema_migrations ORDER BY version')).rows).toEqual([{ version: 44 }, { version: 45 }])
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
