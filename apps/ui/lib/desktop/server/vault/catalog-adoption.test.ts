import { createClient } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { openDesktopDatabase, closeDesktopDatabase } from '../database'
import { serviceStore, type ServiceInstall } from '../services/store'
import { sealHeaderBundle } from '../services/accounts/header-secret-codec'
import { compileAccountService } from '../services/accounts/compiler'
import { getDesktopServiceManifest } from '../services/catalog'
import { createDesktopSecretCrypto } from '../secret-requests/crypto'
import { desktopVault } from './store'
import { adoptDesktopCatalogApps } from './catalog-adoption'
import { desktopVaultMcpRuntime } from './mcp-runtime'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const key = () => Buffer.alloc(32, 17)
const crypto = createDesktopSecretCrypto(key)
const first = randomUUID(), second = randomUUID(), third = randomUUID()
const firstKey = 'synthetic-linear-key-original'
const secondKey = 'synthetic-linear-key-distinct'
const abort = () => new AbortController()
const current = () => {}

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rerun-vault-adopt-'))
    const db = await openDesktopDatabase(root)
    const store = serviceStore(db, key)
    for (const [id, name, engine] of [[first, 'Alice', 'alice'], [second, 'Bob', 'bob'], [third, 'Cara', 'cara']]) {
        await db.execute({ sql: "INSERT INTO desktop_agents(id,workspace_id,engine_agent_id,name,created_at,updated_at) VALUES(?,1,?,?,'2026-01-01','2026-01-01')", args: [id, engine, name] })
    }
    async function install(owner: string, engineId: string, methodId: string, values: Record<string, string>, overrides: Partial<ServiceInstall> = {}) {
        const { plan, headers, bearer } = compileAccountService(getDesktopServiceManifest('linear').manifest,
            methodId, values, { id: methodId, supported: true }, { label: 'Linear' })
        const record: ServiceInstall = { owner, engineId, key: plan.key, id: randomUUID(), revision: randomUUID(), plan,
            state: 'ready', skills: [], toolNames: [], health: { state: 'unchecked' }, healthLaunch: null,
            installedAt: new Date().toISOString(), configured: !!bearer, ...overrides }
        await store.create(record, bearer)
        if (Object.keys(headers).length) await db.execute({
            sql: 'INSERT INTO desktop_service_header_secrets VALUES(?,?,?,?)',
            args: [owner, record.id, record.revision, sealHeaderBundle(key(), owner, record.id, record.revision, { headers, inputs: values })],
        })
        return record
    }
    return { db, root, store, install, close: async () => { await closeDesktopDatabase(root); await rm(root, { recursive: true, force: true }) } }
}

test('adopts matching keys once, separates different keys, and never reattaches a detached or deleted account', async () => {
    const f = await fixture()
    try {
        const a = await f.install(first, 'alice', 'api-key', { LINEAR_API_KEY: firstKey })
        await f.install(second, 'bob', 'api-key', { LINEAR_API_KEY: firstKey })
        await f.install(third, 'cara', 'api-key', { LINEAR_API_KEY: secondKey })
        const verifySkills = async () => current
        const inputs = { db: f.db, workspaceId: 1, key, assertCurrent: current, verifySkills }
        expect(await adoptDesktopCatalogApps(inputs)).toBe(3)
        const vault = desktopVault(f.db, crypto, 1)
        const listing = await vault.list()
        expect(listing.entries).toHaveLength(2)
        const shared = listing.entries.find(entry => entry.agentIds.includes(first))!
        const distinct = listing.entries.find(entry => entry.agentIds.includes(third))!
        expect(shared.agentIds.sort()).toEqual([first, second].sort())
        expect(distinct.agentIds).toEqual([third])
        expect(JSON.stringify(listing)).not.toContain(firstKey)
        const original = await f.store.read(first, a.key)
        expect(original?.id).toBe(a.id)
        expect(await f.store.credential(first, a.id)).toBe(firstKey)
        expect(await serviceStore(f.db, key, true).read(first, a.key)).toBeNull()
        expect(await serviceStore(f.db, key, true).forSkillOwnership(first)).toEqual([original])

        const stop = abort()
        let granted = true
        const seen: { method: string; auth: string | null }[] = []
        const runtime = desktopVaultMcpRuntime(f.db, crypto, 1, async () => ({ enabled: true, granted }), stop.signal,
            async (_url, init, guard) => {
                await guard()
                const request = JSON.parse(String(init.body))
                seen.push({ method: request.method, auth: new Headers(init.headers).get('authorization') })
                const result = request.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Fixture', version: '1' } }
                    : request.method === 'tools/list' ? { tools: [{ name: 'read', inputSchema: { type: 'object' } }] }
                    : { content: [{ type: 'text', text: firstKey }] }
                return request.id ? Response.json({ jsonrpc: '2.0', id: request.id, result }) : new Response(null, { status: 202 })
            }, current, undefined, 'catalog')
        const [tool] = await runtime.tools(first, stop.signal)
        expect(tool.name).toBe('linear_read')
        expect(JSON.stringify(await tool.execute({}))).not.toContain(firstKey)
        expect(seen.length).toBeGreaterThan(0)
        expect(seen.every(call => call.auth === 'Bearer ' + firstKey)).toBe(true)
        const calls = seen.length
        granted = false
        await expect(tool.execute({})).rejects.toThrow()
        expect(seen).toHaveLength(calls)
        granted = true
        const detached = await vault.assignCoworker(first, { id: shared.id, revision: shared.revision, attached: false }, current)
        expect(detached.attached).toEqual([])
        await expect(tool.execute({})).rejects.toThrow()
        expect(seen).toHaveLength(calls)
        stop.abort()
        const after = (await vault.list()).entries.find(entry => entry.id === shared.id)!
        await vault.mutate({ operation: 'delete', id: after.id, revision: after.revision }, current)
        await closeDesktopDatabase(f.root)
        const reopened = createClient({ url: 'file:' + join(f.root, 'app.db') })
        try {
            expect(await adoptDesktopCatalogApps({ ...inputs, db: reopened })).toBe(0)
            expect((await desktopVault(reopened, crypto, 1).list()).entries.map(entry => entry.id)).toEqual([distinct.id])
        } finally { reopened.close() }
    } finally { await f.close() }
})

test('leaves OAuth, mismatched identities, unverified skills and changed revisions with the original owner', async () => {
    const f = await fixture()
    try {
        await f.install(first, 'alice', 'oauth', {})
        const b = await f.install(second, 'bob', 'api-key', { LINEAR_API_KEY: firstKey })
        await f.install(third, 'different-engine', 'api-key', { LINEAR_API_KEY: firstKey })
        const input = { db: f.db, workspaceId: 1, key, assertCurrent: current }
        expect(await adoptDesktopCatalogApps({ ...input, verifySkills: async () => { throw Error('Changed skill') } })).toBe(0)
        expect(await adoptDesktopCatalogApps({ ...input, verifySkills: async record => {
            await f.store.update({ ...record, revision: randomUUID() }, record.revision)
            return current
        } })).toBe(0)
        expect((await desktopVault(f.db, crypto, 1).list()).entries).toEqual([])
        expect(await serviceStore(f.db, key, true).read(second, b.key)).not.toBeNull()
    } finally { await f.close() }
})
