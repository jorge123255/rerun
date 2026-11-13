import { createClient } from '@libsql/client'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { desktopVaultMutation } from '../../vault'
import { DesktopHttpError } from '../auth'
import { initializeDesktopRound45 } from '../round45-schema'
import { initializeDesktopRound46 } from '../round46-schema'
import { initializeDesktopRound47 } from '../round47-schema'
import { initializeDesktopRound48 } from '../round48-schema'
import { initializeDesktopRound49 } from '../round49-schema'
import { initializeDesktopRound50 } from '../round50-schema'
import { initializeDesktopRound51 } from '../round51-schema'
import { initializeDesktopRound52 } from '../round52-schema'
import { initializeDesktopRound55 } from '../round55-schema'
import { initializeDesktopRound56 } from '../round56-schema'
import { initializeDesktopRound54 } from '../round54-schema'
import { initializeDesktopRound53 } from '../round53-schema'
import { desktopServicesSchema } from '../services/schema'
import { vaultCatalog } from './catalog'
import { stdioRuntime } from '../mcp-stdio/runtime'
import { stdioStore } from '../mcp-stdio/store'
import { assignedVaultMcpPrograms, vaultProgramMaterials } from './mcp-programs'
import { desktopVaultMcpRuntime } from './mcp-runtime'
import type { McpNetwork } from '../mcp/remote'
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

async function fixture(migrate = true, headerMigration = true, namedAccounts = true) {
    const root = await mkdtemp(join(tmpdir(), 'rerun-desktop-vault-'))
    const file = join(root, 'app.db')
    const open = () => createClient({ url: `file:${file}` })
    const db = open()
    await db.executeMultiple(`PRAGMA foreign_keys=ON;
        CREATE TABLE desktop_schema_migrations (version INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE);
        INSERT INTO desktop_schema_migrations VALUES (44,'keirolabs-search-credentials');
        CREATE TABLE desktop_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id INTEGER NOT NULL, engine_agent_id TEXT);
        CREATE TABLE desktop_deletions (agent_id TEXT NOT NULL, completed INTEGER NOT NULL, engine_agent_id TEXT);
        CREATE TABLE desktop_remote_mcp (agent_id TEXT NOT NULL,name TEXT NOT NULL);
        CREATE TABLE desktop_secret_credentials (agent_id TEXT NOT NULL,key TEXT NOT NULL,version INTEGER NOT NULL,sealed_value TEXT NOT NULL);
        CREATE TABLE desktop_mcp_stdio (owner TEXT NOT NULL,name TEXT NOT NULL,executable TEXT NOT NULL,args TEXT NOT NULL,revision TEXT NOT NULL);
        CREATE TABLE desktop_mcp_stdio_calls(owner TEXT NOT NULL,run_id TEXT NOT NULL,call_id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(owner,run_id,call_id));`)
    await db.batch([firstAgent, secondAgent, foreignAgent].map((id, i) => ({
        sql: 'INSERT INTO desktop_agents(id,name,workspace_id) VALUES (?,?,?)', args: [id, ['First', 'Second', 'Foreign'][i], i === 2 ? 2 : 1],
    })), 'write')
    await initializeDesktopRound45(db)
    if (migrate) await initializeDesktopRound46(db)
    await initializeDesktopRound47(db)
    if (headerMigration) await initializeDesktopRound48(db)
    await initializeDesktopRound49(db)
    await initializeDesktopRound50(db)
    await initializeDesktopRound51(db)
    await initializeDesktopRound52(db)
    if (namedAccounts) {
        await initializeDesktopRound53(db)
        await initializeDesktopRound54(db)
    }
    await initializeDesktopRound55(db)
    await initializeDesktopRound56(db)
    await db.executeMultiple(desktopServicesSchema)
    return { db, root, file, open, vault: desktopVault(db, crypto, 7) }
}

test('upgrades a prior workspace, saves redacted metadata, rotates ciphertext, and reopens without exposing values', async () => {
    const f = await fixture()
    try {
        const result = await f.vault.mutate({ operation: 'create', name: 'Team key', variable: 'TEAM_KEY', value: secret }, allow)
        const [entry] = result.entries
        if ('kind' in entry) throw new Error('Expected a standalone secret')
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
            expect((await reopened.execute('SELECT version FROM desktop_schema_migrations ORDER BY version')).rows).toEqual([{ version: 44 }, { version: 45 }, { version: 46 }, { version: 47 }, { version: 48 }, { version: 49 }, { version: 50 }, { version: 51 }, { version: 52 }, { version: 53 }, { version: 54 }, { version: 55 }, { version: 56 }])
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
        await f.db.execute({ sql: 'INSERT INTO desktop_deletions(agent_id,completed) VALUES (?,0)', args: [secondAgent] })
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

test('the coworker Vault changes just that owner and preserves entries, other assignments and shared-all policy', async () => {
    const f = await fixture()
    try {
        const [item] = (await f.vault.mutate({ operation: 'create', name: 'Deploy key', variable: 'DEPLOY_KEY', value: secret }, allow)).entries
        const target = { id: item.id, revision: item.revision }
        const first = await f.vault.assignCoworker(firstAgent, { ...target, attached: true }, allow)
        expect(first).toMatchObject({ agentId: firstAgent, available: [], attached: [{ id: item.id, name: item.name, sharedWithAll: false }] })
        expect(first.attached[0]).not.toHaveProperty('agentIds')
        expect(JSON.stringify(first)).not.toContain(secret)
        await expect(f.vault.assignCoworker(secondAgent, { ...target, attached: true }, allow)).rejects.toMatchObject({ status: 409 })
        const second = await f.vault.forCoworker(secondAgent)
        expect(second.attached).toEqual([])
        const both = await f.vault.assignCoworker(secondAgent, { ...second.available[0], attached: true }, allow)
        const detached = await f.vault.assignCoworker(firstAgent, { ...both.attached[0], attached: false }, allow)
        expect(detached).toMatchObject({ attached: [], available: [{ id: item.id }] })
        expect((await f.vault.list()).entries[0].agentIds).toEqual([secondAgent])
        const shared = await f.vault.mutate({ operation: 'share', ...target, revision: detached.available[0].revision, sharedWithAll: true, agentIds: [] }, allow)
        expect((await f.vault.forCoworker(firstAgent)).attached[0].sharedWithAll).toBe(true)
        await expect(f.vault.assignCoworker(firstAgent, { ...target, revision: shared.entries[0].revision, attached: false }, allow)).rejects.toMatchObject({ status: 409 })
        await expect(f.vault.forCoworker(foreignAgent)).rejects.toMatchObject({ status: 404 })
        await expect(f.vault.assignCoworker(foreignAgent, { ...target, attached: true }, allow)).rejects.toMatchObject({ status: 404 })
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})

test('a single Vault MCP credential lends tools to permitted coworkers and revokes old catalogs on changes', async () => {
    const f = await fixture()
    const shutdown = new AbortController()
    try {
        const token = 'synthetic-vault-server-token'
        const config = { operation: 'create-server' as const, name: 'release-notes', url: 'https://mcp.example.test/v1', bearer: token }
        await expect(f.vault.mutate({ ...config, url: 'https://mcp.example.test/v1?token=bad' }, allow)).rejects.toMatchObject({ status: 400 })
        const [saved] = (await f.vault.mutate(config, allow)).entries
        await expect(f.vault.mutate(config, allow)).rejects.toMatchObject({ code: 'vault_conflict' })
        expect(saved).toMatchObject({ kind: 'mcp', hasBearer: true, agentIds: [] })
        expect(JSON.stringify(saved)).not.toContain(token)
        const first = await f.vault.assignCoworker(firstAgent, { id: saved.id, revision: saved.revision, attached: true }, allow)
        const entry = first.attached[0]
        await f.vault.assignCoworker(secondAgent, { id: entry.id, revision: entry.revision, attached: true }, allow)
        const reopened = f.open()
        try {
            let granted = true
            let requests = 0
            let duringResolution: (() => Promise<void>) | undefined
            const network: McpNetwork = async (url, init, guard) => {
                expect(url).toBe(config.url)
                await duringResolution?.()
                await guard()
                requests++
                expect(new Headers(init.headers).get('authorization')).toBe('Bearer ' + token)
                const body = JSON.parse(init.body!)
                const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26' }
                    : body.method === 'tools/list' ? { tools: [{ name: 'list', inputSchema: { type: 'object' }, description: token }] }
                    : { content: [{ type: 'text', text: 'ready ' + token }] }
                return body.id === undefined ? new Response(null, { status: 202 }) : Response.json({ jsonrpc: '2.0', id: body.id, result })
            }
            const runtime = desktopVaultMcpRuntime(reopened, crypto, 7, async () => ({ enabled: true, granted }), shutdown.signal, network)
            const signal = new AbortController().signal
            expect(await runtime.tools(foreignAgent, signal)).toEqual([])
            granted = false
            await expect(runtime.tools(firstAgent, signal)).rejects.toThrow()
            expect(requests).toBe(0)
            granted = true
            const [one] = await runtime.tools(firstAgent, signal)
            expect(one.name).toBe('release-notes_list')
            expect(one.description).not.toContain(token)
            const [two] = await runtime.tools(secondAgent, signal)
            expect(JSON.stringify(await one.execute({}, signal))).toMatch(/ready.*redacted/i)
            const before = requests
            duringResolution = async () => {
                duringResolution = undefined
                const [current] = (await f.vault.forCoworker(firstAgent)).attached
                await f.vault.assignCoworker(firstAgent, { id: current.id, revision: current.revision, attached: false }, allow)
            }
            await expect(one.execute({}, signal)).rejects.toThrow()
            expect(requests).toBe(before)
            expect(await runtime.tools(firstAgent, signal)).toEqual([])
            await expect(two.execute({}, signal)).rejects.toThrow()
            const [stillAssigned] = await runtime.tools(secondAgent, signal)
            expect(stillAssigned.name).toBe(two.name)
            await f.db.execute({ sql: 'INSERT INTO desktop_remote_mcp VALUES(?,?)', args: [firstAgent, config.name] })
            const [available] = (await f.vault.forCoworker(firstAgent)).available
            await expect(f.vault.assignCoworker(firstAgent, { id: available.id, revision: available.revision, attached: true }, allow)).rejects.toMatchObject({ code: 'vault_conflict' })
            const [current] = (await f.vault.forCoworker(secondAgent)).attached
            await f.vault.mutate({ operation: 'replace-server-bearer', id: current.id, revision: current.revision, bearer: 'new-fixture-token' }, allow)
            await expect(stillAssigned.execute({}, signal)).rejects.toThrow()
            expect((await readFile(f.file)).includes(token)).toBe(false)
        } finally { shutdown.abort(); reopened.close() }
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})

test('Vault custom auth headers are endpoint-bound, redacted and revision fenced', async () => {
    const f = await fixture()
    const shutdown = new AbortController()
    try {
        const raw = 'fixture header value !'
        const draft = { operation: 'create-server', name: 'reports', url: 'https://mcp.example.test/rpc', bearer: '' } as const
        for (const name of ['Host', 'cookie', 'content-length', 'Mcp-Session-Id', 'Proxy-Authorization', 'x-rerun-vault-item', 'x-forwarded-for', 'bad name']) {
            expect(desktopVaultMutation.safeParse({ ...draft, header: { name, value: raw } }).success).toBe(false)
        }
        for (const value of [' a', 'a\r\nb', '']) {
            expect(desktopVaultMutation.safeParse({ ...draft, header: { name: 'X-Api-Key', value } }).success).toBe(false)
        }
        expect(desktopVaultMutation.safeParse({ ...draft, bearer: 'competing-token', header: { name: 'X-Api-Key', value: raw } }).success).toBe(false)
        const [entry] = (await f.vault.mutate(desktopVaultMutation.parse({ ...draft, header: { name: 'X-Api-Key', value: raw } }), allow)).entries
        expect(entry).toMatchObject({ kind: 'mcp', headerName: 'x-api-key', hasBearer: false })
        expect(JSON.stringify(entry)).not.toContain(raw)
        const [assigned] = (await f.vault.assignCoworker(firstAgent, { id: entry.id, revision: entry.revision, attached: true }, allow)).attached
        let requests = 0
        let expected: string | null = raw
        const network: McpNetwork = async (url, init, guard) => {
            await guard()
            requests++
            expect(url).toBe(draft.url)
            const headers = new Headers(init.headers)
            expect(headers.get('x-api-key')).toBe(expected)
            expect(headers.get('authorization')).toBeNull()
            const body = JSON.parse(init.body!)
            const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26' }
                : body.method === 'tools/list' ? { tools: [{ name: 'read', inputSchema: { type: 'object' }, description: Buffer.from(raw).toString('base64') }] }
                : { content: [{ type: 'text', text: encodeURIComponent(raw) }] }
            return body.id === undefined ? new Response(null, { status: 202 }) : Response.json({ jsonrpc: '2.0', id: body.id, result })
        }
        const runtime = desktopVaultMcpRuntime(f.db, crypto, 7, async () => ({ enabled: true, granted: true }), shutdown.signal, network)
        const [tool] = await runtime.tools(firstAgent, shutdown.signal)
        expect(tool.description).toBe('[redacted]')
        expect(JSON.stringify(await tool.execute({}, shutdown.signal))).toContain('[redacted]')
        expect((await readFile(f.file)).includes(raw)).toBe(false)
        const before = requests
        await f.db.execute({ sql: 'UPDATE desktop_vault_mcp_servers SET credential_header=? WHERE id=?', args: ['x-other-header', entry.id] })
        await runtime.tools(firstAgent, shutdown.signal).then(tools => expect(tools).toEqual([]))
        expect(requests).toBe(before)
        await f.db.execute({ sql: 'UPDATE desktop_vault_mcp_servers SET credential_header=? WHERE id=?', args: ['x-api-key', entry.id] })
        await f.vault.mutate({ operation: 'replace-server-bearer', id: entry.id, revision: assigned.revision, bearer: '' }, allow)
        await expect(tool.execute({}, shutdown.signal)).rejects.toThrow()
        expect(requests).toBe(before)
        expected = null
        expect(await runtime.tools(firstAgent, shutdown.signal)).toHaveLength(1)
        expect((await f.vault.forCoworker(firstAgent)).attached[0]).not.toHaveProperty('headerName')
    } finally { shutdown.abort(); f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})


test('round 48 retains the old bearer ciphertext and its workspace revision', async () => {
    const f = await fixture(true, false)
    try {
        const id = randomUUID(), revision = randomUUID(), url = 'https://mcp.example.test/legacy'
        const context = { domain: 'vault' as const, agentId: id, key: url, version: 1, workspaceId: 7, revision }
        const value = 'previous-release-bearer-fixture'
        const sealed = await crypto.seal(context, Buffer.from(value))
        await f.db.execute({
            sql: 'INSERT INTO desktop_vault_mcp_servers(id,name,url,revision,credential_revision,sealed) VALUES(?,?,?,?,?,?)',
            args: [id, 'legacy', url, revision, revision, sealed],
        })
        await initializeDesktopRound48(f.db)
        await initializeDesktopRound48(f.db)
        expect((await f.db.execute('SELECT revision,credential_revision,sealed,credential_header FROM desktop_vault_mcp_servers')).rows)
            .toEqual([{ revision, credential_revision: revision, sealed, credential_header: null }])
        expect((await f.vault.list()).entries).toEqual([{ kind: 'mcp', id, name: 'legacy', url, revision, sharedWithAll: false, agentIds: [], hasBearer: true }])
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})

test('Vault local programs use the existing run grant, are pinned to the reviewed executable, and refuse detached calls', async () => {
    const f = await fixture()
    const root = await realpath(f.root)
    const executable = join(root, 'qa-mcp-program')
    const alias = join(root, 'program-alias')
    const signal = AbortSignal.timeout(15000)
    const identity = { engineAgentId: 'fixture-engine', sessionId: 'fixture-chat', runId: 'fixture-run' }
    let granted = false
    const store = stdioStore(f.db)
    const runtime = stdioRuntime(store, async (owner, action, run) => {
        if (action === 'use' && (!granted || owner !== firstAgent || !run)) throw new Error('Local MCP grant is off')
        return { cwd: root }
    }, undefined, undefined, owner => assignedVaultMcpPrograms(f.db, owner))
    try {
        const node = await realpath(process.execPath)
        const fixtureBody = `#!${node}
const lines = require('node:readline').createInterface({ input: process.stdin })
lines.on('line', line => {
    const { id, method } = JSON.parse(line)
    if (id === undefined) return
    const result = method === 'initialize' ? { protocolVersion: '2025-03-26' }
        : method === 'tools/list' ? { tools: [{ name: 'check', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: process.argv[2] }] }
    console.log(JSON.stringify({ jsonrpc: '2.0', id, result }))
})
`
        await writeFile(executable, fixtureBody, { mode: 0o700 })
        await symlink(executable, alias)
        const draft = { operation: 'create-program', name: 'qa-check', executable, args: ['two words'] } as const
        expect(desktopVaultMutation.safeParse({ ...draft, executable: 'relative/path' }).success).toBe(false)
        expect(desktopVaultMutation.safeParse({ ...draft, args: ['${VAULT_TOKEN}'] }).success).toBe(false)
        for (const path of [alias, '/bin/sh']) {
            await expect(f.vault.mutate(desktopVaultMutation.parse({ ...draft, executable: path }), allow)).rejects.toMatchObject({ status: 400 })
        }
        const [saved] = (await f.vault.mutate(desktopVaultMutation.parse(draft), allow)).entries
        expect(saved).toMatchObject({ kind: 'program', executable, args: ['two words'], agentIds: [] })
        const [attached] = (await f.vault.assignCoworker(firstAgent, { id: saved.id, revision: saved.revision, attached: true }, allow)).attached
        expect(attached).not.toHaveProperty('args')
        expect(attached).not.toHaveProperty('approvedExecutable')
        await expect(runtime.tools(firstAgent, identity, signal)).rejects.toThrow()
        expect(await runtime.tools(secondAgent, identity, signal)).toEqual([])
        expect(await runtime.tools(foreignAgent, identity, signal)).toEqual([])
        granted = true
        const [tool] = await runtime.tools(firstAgent, identity, signal)
        expect(tool.name).toBe('qa-check_check')
        expect(JSON.stringify(await tool.execute({}, 'first', signal))).toContain('two words')
        await f.vault.assignCoworker(firstAgent, { id: saved.id, revision: attached.revision, attached: false }, allow)
        await expect(tool.execute({}, 'detached', signal)).rejects.toThrow()
        expect(await runtime.tools(firstAgent, identity, signal)).toEqual([])
        const [available] = (await f.vault.forCoworker(firstAgent)).available
        const [reattached] = (await f.vault.assignCoworker(firstAgent, { id: saved.id, revision: available.revision, attached: true }, allow)).attached
        await writeFile(executable, fixtureBody + '\n// replacement\n')
        await chmod(executable, 0o700)
        await expect(runtime.tools(firstAgent, identity, signal)).rejects.toThrow()
        await f.vault.mutate({ operation: 'replace-program', id: saved.id, revision: reattached.revision, executable, args: ['reviewed'] }, allow)
        const [reviewed] = await runtime.tools(firstAgent, { ...identity, runId: 'after-review' }, signal)
        expect(JSON.stringify(await reviewed.execute({}, 'reviewed', signal))).toContain('reviewed')
        expect((await store.list(firstAgent))).toEqual([])
    } finally { await runtime.shutdown(); f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})

test('local program credentials stay scoped to the assigned entry and revisions', async () => {
    const f = await fixture()
    try {
        const programPath = await realpath(process.execPath)
        const create = (name: string) => f.vault.mutate({ operation: 'create-program', name, executable: programPath, args: [] }, allow)
        const [initial] = (await create('a')).entries
        await create('b')
        for (const variable of ['PATH', 'NODE_OPTIONS', 'PYTHONPATH', 'RERUN_API_KEY', 'DYLD_INSERT_LIBRARIES']) {
            expect(desktopVaultMutation.safeParse({ operation: 'set-program-credential', id: initial.id, revision: initial.revision, variable, value: secret }).success).toBe(false)
        }
        const variable = 'SERVICE_API_KEY'
        const [saved] = (await f.vault.mutate({ operation: 'set-program-credential', id: initial.id, revision: initial.revision, variable, value: secret }, allow)).entries
        expect(saved).toMatchObject({ credentialNames: [variable] })
        expect(JSON.stringify(saved)).not.toContain(secret)
        const [attached] = (await f.vault.assignCoworker(firstAgent, { id: saved.id, revision: saved.revision, attached: true }, allow)).attached
        expect(attached).not.toHaveProperty('credentialNames')
        const [other] = (await f.vault.forCoworker(firstAgent)).available
        const both = await f.vault.assignCoworker(firstAgent, { id: other.id, revision: other.revision, attached: true }, allow)
        const currentOther = both.attached.find(entry => entry.id === other.id)!
        const reopen = f.open()
        try {
            const signal = AbortSignal.timeout(5000)
            const materials = vaultProgramMaterials(reopen, crypto, 7)
            await expect(materials(secondAgent, 'a', attached.revision, 'discovery', signal)).rejects.toThrow()
            const unrelated = await materials(firstAgent, 'b', currentOther.revision, 'discovery', signal)
            expect(unrelated.material.env).toEqual({})
            await unrelated.release()
            const lease = await materials(firstAgent, 'a', attached.revision, 'discovery', signal)
            try {
                expect(lease.material.env).toEqual({ [variable]: secret })
                expect(lease.material.inheritEnv).toBe(false)
                expect(lease.protect({ text: Buffer.from(secret).toString('base64') })).toEqual({ text: '[redacted]' })
                await expect(vaultProgramMaterials(reopen, crypto, 8)(firstAgent, 'a', attached.revision, 'discovery', signal)).rejects.toThrow()
                await f.db.execute({ sql: 'UPDATE desktop_vault_mcp_programs SET args=? WHERE id=?', args: ['["--version"]', saved.id] })
                await expect(materials(firstAgent, 'a', attached.revision, 'discovery', signal)).rejects.toThrow()
                await f.db.execute({ sql: 'UPDATE desktop_vault_mcp_programs SET args=? WHERE id=?', args: ['[]', saved.id] })
                const [rotated] = (await f.vault.mutate({ operation: 'set-program-credential', id: saved.id, revision: attached.revision, variable, value: 'rotated-local-fixture' }, allow)).entries
                await expect(lease.check()).rejects.toThrow()
                const [changed] = (await f.vault.mutate({ operation: 'replace-program', id: saved.id, revision: rotated.revision, executable: programPath, args: ['--version'] }, allow)).entries
                expect(changed).toMatchObject({ credentialNames: [] })
                const current = await materials(firstAgent, 'a', changed.revision, 'discovery', signal)
                expect(current.material.env).toEqual({})
                await current.release()
            } finally { await lease.release() }
            expect(lease.material.env).toEqual({})
            expect((await readFile(f.file)).includes(secret)).toBe(false)
        } finally { reopen.close() }
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})

test.each(['custom', 'catalog'] as const)('%s Vault browser sign-in shares a credential and refuses stale callbacks', async mode => {
    const f = await fixture()
    const shutdown = new AbortController()
    const signal = AbortSignal.timeout(10000)
    const resource = mode === 'catalog' ? 'https://mcp.linear.app/mcp' : 'https://93.184.216.34/mcp'
    const issuer = 'https://93.184.216.34/'
    const firstToken = 'fixture-access-before-refresh'
    const refreshToken = 'fixture-refresh-private'
    const rotatedToken = 'fixture-access-after-refresh'
    let exchanges = 0, refreshes = 0, networkRequests = 0
    let opened: ReturnType<typeof f.open> | undefined
    const json: import('../mcp/oauth-network').OAuthJson = async (url, _signal, body) => {
        if (url.includes('oauth-protected-resource')) return { resource, authorization_servers: [issuer] }
        if (url.includes('oauth-authorization-server')) return {
            issuer, authorization_endpoint: issuer + 'authorize', token_endpoint: issuer + 'token', registration_endpoint: issuer + 'register',
            token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], response_types_supported: ['code'],
            authorization_response_iss_parameter_supported: true,
        }
        if (url.endsWith('/register')) return { client_id: 'fixture-public-client', token_endpoint_auth_method: 'none', redirect_uris: (body as Record<string, unknown>).redirect_uris }
        if (body instanceof URLSearchParams && body.get('grant_type') === 'authorization_code') {
            exchanges++
            expect(body.get('code_verifier')).toHaveLength(43)
            return { access_token: firstToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 30 }
        }
        expect((body as URLSearchParams).get('refresh_token')).toBe(refreshToken)
        refreshes++
        return { access_token: rotatedToken, refresh_token: 'fixture-rotated-refresh', token_type: 'Bearer', expires_in: 3600 }
    }
    const network: McpNetwork = async (_url, init, guard) => {
        await guard()
        networkRequests++
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer ' + rotatedToken)
        const body = JSON.parse(init.body!)
        const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26' }
            : body.method === 'tools/list' ? { tools: [{ name: 'check', inputSchema: { type: 'object' }, description: rotatedToken }] }
            : { content: [{ type: 'text', text: rotatedToken }] }
        return body.id === undefined ? new Response(null, { status: 202 }) : Response.json({ jsonrpc: '2.0', id: body.id, result })
    }
    const access = async () => ({ enabled: true, granted: true })
    try {
        const [entry] = (await f.vault.mutate(mode === 'catalog'
            ? { operation: 'add-app', slug: 'linear', methodId: 'oauth', values: {} }
            : { operation: 'create-server', name: 'browser', url: resource, bearer: '', browserSignIn: true }, allow)).entries
        expect(entry).toMatchObject({ kind: 'mcp', url: resource, browserSignIn: true })
        if (mode === 'catalog') expect(entry).toHaveProperty('catalog.methodId', 'oauth')
        const toolsMode = mode === 'catalog' ? 'catalog' : 'mcp'
        const [one] = (await f.vault.assignCoworker(firstAgent, { id: entry.id, revision: entry.revision, attached: true }, allow)).attached
        const [two] = (await f.vault.assignCoworker(secondAgent, { id: entry.id, revision: one.revision, attached: true }, allow)).attached
        const original = desktopVaultMcpRuntime(f.db, crypto, 7, access, shutdown.signal, network, allow, json)
        const caller = mode === 'catalog'
            ? desktopVaultMcpRuntime(f.db, crypto, 7, access, shutdown.signal, network, allow, undefined, toolsMode, original.oauth)
            : original
        expect(await caller.tools(firstAgent, signal)).toEqual([])
        expect(networkRequests).toBe(0)
        const started = await original.oauth.start(entry.id, entry.name, two.revision, signal)
        const authorization = new URL(started.authorizationUrl!)
        expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
        const callback = new URL(authorization.searchParams.get('redirect_uri')!)
        callback.search = new URLSearchParams({ code: 'test-code', iss: issuer, state: 'wrong-state' }).toString()
        expect((await fetch(callback, { signal })).status).toBe(400)
        expect(exchanges).toBe(0)
        callback.searchParams.set('state', authorization.searchParams.get('state')!)
        expect((await fetch(callback, { signal })).status).toBe(200)
        expect(exchanges).toBe(1)
        opened = f.open()
        const restartedOwner = desktopVaultMcpRuntime(opened, crypto, 7, access, shutdown.signal, network, allow, json)
        const restarted = mode === 'catalog'
            ? desktopVaultMcpRuntime(opened, crypto, 7, access, shutdown.signal, network, allow, undefined, toolsMode, restartedOwner.oauth)
            : restartedOwner
        expect(await restarted.oauth.status(entry.id, entry.name, two.revision, signal)).toEqual({ state: 'connected' })
        const [[toolA], [toolB]] = await Promise.all([restarted.tools(firstAgent, signal), restarted.tools(secondAgent, signal)])
        expect(refreshes).toBe(1)
        expect(toolA.description).toBe('[redacted]')
        expect(JSON.stringify(await toolB.execute({}, signal))).toContain('[redacted]')
        expect(await restarted.tools(foreignAgent, signal)).toEqual([])
        const encrypted = await readFile(f.file)
        for (const token of [firstToken, refreshToken, rotatedToken]) expect(encrypted.includes(token)).toBe(false)

        const reconnect = await restarted.oauth.start(entry.id, entry.name, two.revision, signal)
        const pending = new URL(reconnect.authorizationUrl!)
        const [cleared] = (await f.vault.mutate({ operation: 'clear-server-oauth', id: entry.id, revision: two.revision }, allow)).entries
        const stale = new URL(pending.searchParams.get('redirect_uri')!)
        stale.search = new URLSearchParams({ code: 'old-code', iss: issuer, state: pending.searchParams.get('state')! }).toString()
        expect((await fetch(stale, { signal })).status).toBe(400)
        expect(exchanges).toBe(1)
        await expect(toolA.execute({}, signal)).rejects.toThrow()
        expect(await restarted.oauth.status(entry.id, entry.name, cleared.revision, signal)).toEqual({ state: 'idle' })
        expect(cleared.agentIds).toEqual([firstAgent, secondAgent].sort())
        if (mode === 'catalog') {
            const [keyMode] = (await f.vault.mutate({ operation: 'configure-app', id: entry.id, revision: cleared.revision,
                methodId: 'api-key', values: { LINEAR_API_KEY: 'lin_test-fixture' } }, allow)).entries
            expect(keyMode).toMatchObject({ hasBearer: true, catalog: { methodId: 'api-key' }, agentIds: cleared.agentIds })
            expect(keyMode).not.toHaveProperty('browserSignIn')
            await expect(restarted.oauth.status(entry.id, entry.name, keyMode.revision, signal)).rejects.toThrow()
            const [browserMode] = (await f.vault.mutate({ operation: 'configure-app', id: entry.id, revision: keyMode.revision,
                methodId: 'oauth', values: {} }, allow)).entries
            expect(browserMode).toMatchObject({ hasBearer: false, browserSignIn: true, catalog: { methodId: 'oauth' }, agentIds: cleared.agentIds })
            expect(await restarted.oauth.status(entry.id, entry.name, browserMode.revision, signal)).toEqual({ state: 'idle' })
        }
    } finally { shutdown.abort(); opened?.close(); f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})

test('a catalog app keeps its encrypted key and limits tools to current Apps grants and assignments', async () => {
    const f = await fixture()
    const shutdown = new AbortController()
    try {
        const slug = 'agentmail', methodId = 'api-key'
        const token = 'am_synthetic-catalog-fixture'
        const values = { AGENTMAIL_API_KEY: token }
        const [catalog] = vaultCatalog('agentmail').filter(app => app.slug === slug)
        expect(catalog.name).toBe('AgentMail')
        const microsoft = vaultCatalog('microsoft').find(app => app.slug === 'microsoft')!
        expect(microsoft.methods).toHaveLength(1)
        expect(microsoft.methods[0].inputs).toEqual([])
        const [keyless] = (await f.vault.mutate({ operation: 'add-app', slug: microsoft.slug, methodId: microsoft.methods[0].id, values: {} }, allow)).entries
        expect(keyless).toMatchObject({ name: 'microsoft-learn', hasBearer: false, catalog: { name: 'Microsoft Learn' } })
        expect(vaultCatalog('linear').find(app => app.slug === 'linear')?.methods.map(method => method.kind)).toEqual(['oauth', 'key'])
        expect(catalog.methods.map(method => method.id)).toContain(methodId)
        await expect(f.vault.mutate({ operation: 'add-app', slug, methodId: 'oauth', values }, allow)).rejects.toMatchObject({ status: 400 })
        const saved = (await f.vault.mutate({ operation: 'add-app', slug, methodId, values }, allow)).entries.find(item => item.name === 'agentmail')!
        expect(saved).toMatchObject({ catalog: { slug, methodId, name: catalog.name }, headerName: 'x-api-key', hasBearer: false, agentIds: [] })
        const [entry] = (await f.vault.assignCoworker(firstAgent, { id: saved.id, revision: saved.revision, attached: true }, allow)).attached
        await expect(f.vault.mutate({ operation: 'replace-server-bearer', id: entry.id, revision: entry.revision, bearer: token }, allow)).rejects.toMatchObject({ status: 400 })
        const reopened = f.open()
        try {
            let granted = false, requests = 0, expectedToken = token
            const network: McpNetwork = async (url, init, guard) => {
                expect(url).toBe('https://mcp.agentmail.to/mcp')
                await guard()
                requests++
                expect(new Headers(init.headers).get('x-api-key')).toBe(expectedToken)
                const body = JSON.parse(init.body!)
                const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26' }
                    : body.method === 'tools/list' ? { tools: [{ name: 'list', inputSchema: { type: 'object' } }] }
                    : { content: [{ type: 'text', text: 'ready ' + expectedToken }] }
                return body.id === undefined ? new Response(null, { status: 202 }) : Response.json({ jsonrpc: '2.0', id: body.id, result })
            }
            const services = desktopVaultMcpRuntime(reopened, crypto, 7, async () => ({ enabled: true, granted }), shutdown.signal, network, allow, undefined, 'catalog')
            const mcp = desktopVaultMcpRuntime(reopened, crypto, 7, async () => ({ enabled: true, granted: true }), shutdown.signal, network)
            expect(await mcp.tools(firstAgent, shutdown.signal)).toEqual([])
            expect(await services.tools(secondAgent, shutdown.signal)).toEqual([])
            expect(await services.tools(foreignAgent, shutdown.signal)).toEqual([])
            await expect(services.tools(firstAgent, shutdown.signal)).rejects.toThrow()
            expect(requests).toBe(0)
            granted = true
            let active = true
            const [tool] = await services.tools(firstAgent, shutdown.signal, async () => {
                if (!active) throw new Error('Service run stopped')
            })
            expect(tool.name).toBe('agentmail_list')
            const result = JSON.stringify(await tool.execute({}, shutdown.signal))
            expect(result).toMatch(/ready.*redacted/i)
            expect(result).not.toContain(token)
            granted = false
            const before = requests
            await expect(tool.execute({}, shutdown.signal)).rejects.toThrow()
            expect(requests).toBe(before)
            granted = true
            active = false
            await expect(tool.execute({}, shutdown.signal)).rejects.toThrow()
            expect(requests).toBe(before)
            active = true
            expectedToken = 'am_rotated-catalog-fixture'
            const [rotated] = (await f.vault.mutate({ operation: 'configure-app', id: entry.id, revision: entry.revision, methodId, values: { AGENTMAIL_API_KEY: expectedToken } }, allow)).entries
            expect(rotated.agentIds).toEqual([firstAgent])
            await expect(tool.execute({}, shutdown.signal)).rejects.toThrow()
            expect(requests).toBe(before)
            const [updatedTool] = await services.tools(firstAgent, shutdown.signal)
            expect(JSON.stringify(await updatedTool.execute({}, shutdown.signal))).toMatch(/ready.*redacted/i)
            await f.vault.assignCoworker(firstAgent, { id: rotated.id, revision: rotated.revision, attached: false }, allow)
            await expect(updatedTool.execute({}, shutdown.signal)).rejects.toThrow()
            expect(await services.tools(firstAgent, shutdown.signal)).toEqual([])
            expect((await readFile(f.file)).includes(token)).toBe(false)
            expect((await readFile(f.file)).includes(expectedToken)).toBe(false)
        } finally { shutdown.abort(); reopened.close() }
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})


test('named catalog accounts keep independent credentials, revisions and assignments after reopening', async () => {
    const f = await fixture()
    const shutdown = new AbortController()
    try {
        const add = { operation: 'add-app' as const, slug: 'linear', methodId: 'api-key' }
        const salesKey = 'lin_sales-isolated-fixture-key'
        const supportKey = 'lin_support-isolated-fixture-key'
        const [sales] = (await f.vault.mutate({ ...add, values: { LINEAR_API_KEY: salesKey } }, allow)).entries
        const second = { ...add, label: 'Support Linear', expectedAccounts: 1, values: { LINEAR_API_KEY: supportKey } }
        await expect(f.vault.mutate({ ...second, expectedAccounts: 0 }, allow)).rejects.toMatchObject({ status: 409 })
        await expect(f.vault.mutate({ ...second, label: 'linear' }, allow)).rejects.toMatchObject({ status: 409 })
        const results = await Promise.allSettled([f.vault.mutate(second, allow), f.vault.mutate(second, allow)])
        expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
        const [support] = (await f.vault.list()).entries.filter(entry => entry.id !== sales.id)
        expect(sales.name).toBe('linear')
        expect(support).toMatchObject({ name: expect.stringMatching(/^linear-[a-z0-9]{6}$/),
            catalog: { slug: 'linear', name: 'Linear', label: 'Support Linear', instanceId: expect.stringMatching(/^[a-z0-9]{6}$/) } })
        await f.vault.assignCoworker(firstAgent, { id: sales.id, revision: sales.revision, attached: true }, allow)
        const [assignedSupport] = (await f.vault.assignCoworker(secondAgent, { id: support.id, revision: support.revision, attached: true }, allow)).attached
        const reopened = f.open()
        try {
            await initializeDesktopRound53(reopened)
            const vault = desktopVault(reopened, crypto, 7)
            const requestedKeys: string[] = []
            const network: McpNetwork = async (url, init, guard) => {
                expect(url).toBe('https://mcp.linear.app/mcp')
                await guard()
                requestedKeys.push(new Headers(init.headers).get('authorization') ?? '')
                const body = JSON.parse(init.body!)
                const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26' }
                    : body.method === 'tools/list' ? { tools: [{ name: 'read', inputSchema: { type: 'object' } }] }
                    : { content: [] }
                return body.id === undefined ? new Response(null, { status: 202 }) : Response.json({ jsonrpc: '2.0', id: body.id, result })
            }
            const runtime = desktopVaultMcpRuntime(reopened, crypto, 7, async () => ({ enabled: true, granted: true }), shutdown.signal,
                network, allow, undefined, 'catalog')
            const [salesTool] = await runtime.tools(firstAgent, shutdown.signal)
            expect(salesTool.name).toBe('linear_read')
            expect([...new Set(requestedKeys.splice(0))]).toEqual(['Bearer ' + salesKey])
            const [supportTool] = await runtime.tools(secondAgent, shutdown.signal)
            expect(supportTool.name).toBe(support.name + '_read')
            expect([...new Set(requestedKeys.splice(0))]).toEqual(['Bearer ' + supportKey])
            await expect(vault.mutate({ operation: 'rename-app', id: support.id, revision: support.revision, label: 'Support' }, allow))
                .rejects.toMatchObject({ status: 409 })
            const renamed = (await vault.mutate({ operation: 'rename-app', id: support.id, revision: assignedSupport.revision, label: 'Support' }, allow))
                .entries.find(entry => entry.id === support.id)!
            expect(renamed).toMatchObject({ name: support.name, catalog: { label: 'Support' }, agentIds: [secondAgent] })
            await expect(supportTool.execute({}, shutdown.signal)).rejects.toThrow()
            expect(requestedKeys).toEqual([])
            expect(await salesTool.execute({}, shutdown.signal)).toMatchObject({ result: { content: [] } })
            expect([...new Set(requestedKeys.splice(0))]).toEqual(['Bearer ' + salesKey])
            const switched = (await vault.mutate({ operation: 'configure-app', id: support.id, revision: renamed.revision, methodId: 'oauth', values: {} }, allow))
                .entries.find(entry => entry.id === support.id)
            expect(switched).toMatchObject({ name: support.name, browserSignIn: true, catalog: { label: 'Support', methodId: 'oauth' }, agentIds: [secondAgent] })
            expect(await runtime.tools(secondAgent, shutdown.signal)).toEqual([])
            expect(requestedKeys).toEqual([])
        } finally { shutdown.abort(); reopened.close() }
        for (const key of [salesKey, supportKey]) expect((await readFile(f.file)).includes(key)).toBe(false)
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})


test('the named-account migration keeps the original Vault app and OAuth identity', async () => {
    const f = await fixture(true, true, false)
    try {
        const id = randomUUID(), revision = randomUUID()
        await f.db.execute({
            sql: 'INSERT INTO desktop_vault_mcp_servers(id,name,url,revision,credential_revision,oauth_enabled,catalog_slug,catalog_method,catalog_name) VALUES(?,?,?,?,?,1,?,?,?)',
            args: [id, 'linear', 'https://mcp.linear.app/mcp', revision, revision, 'linear', 'oauth', 'Linear'],
        })
        await f.db.execute({ sql: 'INSERT INTO desktop_vault_mcp_attachments(item_id,agent_id) VALUES(?,?)', args: [id, firstAgent] })
        await initializeDesktopRound53(f.db)
        await initializeDesktopRound53(f.db)
        await initializeDesktopRound54(f.db)
        await initializeDesktopRound54(f.db)
        expect((await f.vault.list()).entries).toEqual([{
            id, name: 'linear', url: 'https://mcp.linear.app/mcp', revision, kind: 'mcp', browserSignIn: true, hasBearer: false,
            catalog: { slug: 'linear', methodId: 'oauth', name: 'Linear' }, agentIds: [firstAgent], sharedWithAll: false,
        }])
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})

test('explicit Vault checks report only the current account revision and launch, without invoking a tool', async () => {
    const f = await fixture()
    const shutdown = new AbortController()
    try {
        const token = 'am_fixture-connection-check-only'
        const [entry] = (await f.vault.mutate({ operation: 'add-app', slug: 'agentmail', methodId: 'api-key',
            values: { AGENTMAIL_API_KEY: token } }, allow)).entries
        const active = new AbortController()
        const operations: string[] = []
        let fail = false
        let onResponse: (() => Promise<unknown>) | undefined
        const network: McpNetwork = async (url, init, guard) => {
            await guard()
            expect(url).toBe('https://mcp.agentmail.to/mcp')
            expect(new Headers(init.headers).get('x-api-key')).toBe(token)
            const body = JSON.parse(init.body!)
            operations.push(body.method)
            if (fail) throw new Error(token)
            const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26' }
                : { tools: [{ name: 'lookup', description: token, inputSchema: { type: 'object' } }] }
            if (body.method === 'tools/list') await onResponse?.()
            return body.id === undefined ? new Response(null, { status: 202 }) : Response.json({ jsonrpc: '2.0', id: body.id, result })
        }
        const runtime = desktopVaultMcpRuntime(f.db, crypto, 7, async () => ({ enabled: false, granted: false }),
            shutdown.signal, network, allow, undefined, 'catalog')
        const check = runtime.catalogHealth('launch-one')
        const list = () => desktopVault(f.db, crypto, 7, 'launch-one').list()
        expect(await list()).not.toHaveProperty('entries.0.catalog.health')
        expect(await check(entry.id, entry.revision, active.signal)).toMatchObject({ state: 'healthy', toolCount: 1 })
        expect(operations).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
        expect(await list()).toHaveProperty('entries.0.catalog.health.state', 'healthy')
        expect(await desktopVault(f.db, crypto, 7, 'launch-two').list()).not.toHaveProperty('entries.0.catalog.health')
        expect(JSON.stringify(await list())).not.toContain(token)

        fail = true
        expect(await check(entry.id, entry.revision, active.signal)).toMatchObject({ state: 'error' })
        expect(JSON.stringify(await list())).not.toContain(token)
        fail = false
        onResponse = async () => {
            await expect(check(entry.id, entry.revision, active.signal)).rejects.toMatchObject({ status: 409 })
            await f.vault.mutate({ operation: 'rename-app', id: entry.id, revision: entry.revision, label: 'Current AgentMail' }, allow)
        }
        await expect(check(entry.id, entry.revision, active.signal)).rejects.toMatchObject({ status: 409 })
        expect(await list()).not.toHaveProperty('entries.0.catalog.health')

        const [current] = (await list()).entries
        const cancel = new AbortController()
        onResponse = async () => { cancel.abort() }
        await expect(check(current.id, current.revision, cancel.signal)).rejects.toThrow()
        expect(await list()).not.toHaveProperty('entries.0.catalog.health')

        const saved = (await f.vault.mutate({ operation: 'add-app', slug: 'linear', methodId: 'oauth', values: {} }, allow)).entries
        const browser = saved.find(item => item.name === 'linear')!
        const requests = operations.length
        expect(await check(browser.id, browser.revision, active.signal)).toMatchObject({ state: 'disconnected' })
        expect(operations).toHaveLength(requests)
        await f.db.execute({ sql: 'INSERT INTO desktop_vault_mcp_oauth(item_id,generation,sealed) VALUES(?,?,?)',
            args: [browser.id, randomUUID(), 'opaque-new-generation'] })
        expect((await list()).entries.find(item => item.id === browser.id)).not.toHaveProperty('catalog.health')
    } finally { shutdown.abort(); f.db.close(); await rm(f.root, { recursive: true, force: true }) }
})
