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
import { vaultCatalog } from './catalog'
import { remoteMcpStore } from '../mcp/store'
import type { SseNetwork } from '../mcp-sse/types'
import { vaultMcpOAuth } from './mcp-oauth'
import type { OAuthJson } from '../mcp/oauth-network'
import type { OAuthTokenBundle } from '../mcp/store'
import { openCatalogOAuthToken, sealCatalogOAuthToken } from '../services/oauth/store'
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
    async function install(owner: string, engineId: string, methodId: string, values: Record<string, string>, overrides: Partial<ServiceInstall> = {}, slug = 'linear') {
        const { manifest } = getDesktopServiceManifest(slug)
        const { plan, headers, bearer } = compileAccountService(manifest,
            methodId, values, { id: methodId, supported: true }, { label: manifest.name })
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

test('Wrike Bearer SSE works from Vault with both grants, exact run authority and restart-safe receipts', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    const run = { engineAgentId: 'alice', sessionId: 'sse-session', runId: 'sse-run' }
    const methodId = 'permanent-access-token'
    const values = { WRIKE_TOKEN: 'synthetic-wrike-token' }
    const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
    let opened = 0, effects = 0, appsGranted = true, remoteGranted = true, activeRun = true
    const network: SseNetwork = async request => {
        await request.guard()
        expect(new URL(request.url).origin).toBe('https://mcp.wrike.com')
        expect(request.authority.server.hasBearer).toBe(true)
        if (request.method === 'GET') {
            expect(new URL(request.url).pathname).toBe('/app/mcp/sse')
            const session = `session_${++opened}`.padEnd(24, 'x')
            const body = new ReadableStream<Uint8Array>({ start(controller) {
                streams.set(session, controller)
                controller.enqueue(Buffer.from(`event: endpoint\ndata: /app/mcp/messages?sessionId=${session}\n\n`))
            }, cancel() { streams.delete(session) } })
            return { status: 200, contentType: 'text/event-stream', body, async close() {
                streams.get(session)?.close(); streams.delete(session)
            } }
        }
        const input = JSON.parse(request.body!)
        let result: unknown
        if (input.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Fixture', version: '1' } }
        if (input.method === 'tools/list') result = { tools: [{ name: 'read_project', inputSchema: { type: 'object' } }] }
        if (input.method === 'tools/call') {
            expect(input.params.name).toBe('read_project')
            effects++
            result = { content: [{ type: 'text', text: 'Project found ' + values.WRIKE_TOKEN }] }
        }
        const session = new URL(request.url).searchParams.get('sessionId')!
        if (result) streams.get(session)!.enqueue(Buffer.from(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: input.id, result })}\n\n`))
        return { status: 202, contentType: 'text/plain', body: null, async close() {} }
    }
    const runtime = (db: typeof f.db) => desktopVaultMcpRuntime(db, crypto, 1,
        async () => ({ enabled: true, granted: appsGranted }), signal, undefined, current, undefined, 'catalog', undefined, undefined, {
            store: remoteMcpStore(db, key), key, network,
            remoteAccess: async () => ({ enabled: true, granted: remoteGranted }),
            watchOwner: () => current,
            authorizeRun: async identity => {
                if (!activeRun || identity.engineAgentId !== run.engineAgentId || identity.sessionId !== run.sessionId || identity.runId !== run.runId) throw new Error('Run is unavailable')
                return first
            },
        })
    const live = runtime(f.db)
    try {
        expect(vaultCatalog('wrike').find(app => app.slug === 'wrike')?.methods.map(method => method.id)).toContain(methodId)
        expect(vaultCatalog('square').find(app => app.slug === 'square')?.methods.map(method => method.id) ?? []).not.toContain('oauth')
        const vault = desktopVault(f.db, crypto, 1, 'first-launch')
        const [saved] = (await vault.mutate({ operation: 'add-app', slug: 'wrike', methodId, values }, current)).entries
        expect(saved).toMatchObject({ catalog: { slug: 'wrike', methodId }, hasBearer: true, agentIds: [] })
        const { rows: [secure] } = await f.db.execute('SELECT transport,sealed FROM desktop_vault_mcp_servers')
        expect(secure.transport).toBe('sse')
        expect(typeof secure.sealed).toBe('string')
        expect(secure.sealed).not.toContain(values.WRIKE_TOKEN)
        expect(await live.sseTools(first, run, signal)).toEqual([])
        expect(opened).toBe(0)
        expect(await live.catalogHealth('first-launch')(saved.id, saved.revision, signal)).toMatchObject({ state: 'healthy', toolCount: 1 })
        expect(streams.size).toBe(0)
        expect(effects).toBe(0)
        await vault.assignCoworker(first, { id: saved.id, revision: saved.revision, attached: true }, current)
        remoteGranted = false
        expect(await live.sseTools(first, run, signal)).toEqual([])
        remoteGranted = true
        appsGranted = false
        expect(await live.sseTools(first, run, signal)).toEqual([])
        appsGranted = true
        expect(await live.sseTools(second, run, signal)).toEqual([])
        await expect(live.sseTools(first, { ...run, sessionId: 'wrong-session' }, signal)).rejects.toThrow('Run is unavailable')
        expect(opened).toBe(1)
        const [tool] = await live.sseTools(first, run, signal)
        expect(tool.name).toBe('wrike_read_project')
        const output = await tool.execute({}, signal, 'one-call')
        expect(JSON.stringify(output)).toContain('Project found [REDACTED]')
        expect(effects).toBe(1)
        activeRun = false
        await expect(tool.execute({}, signal, 'stopped-call')).rejects.toThrow('Run is unavailable')
        activeRun = true
        await live.releaseSseRun(first, run)
        expect(streams.size).toBe(0)
        await live.shutdownSse()
        await closeDesktopDatabase(f.root)

        const reopened = await openDesktopDatabase(f.root)
        const again = runtime(reopened)
        try {
            const restartedVault = desktopVault(reopened, crypto, 1, 'second-launch')
            const [assigned] = (await restartedVault.list()).entries
            expect(assigned).toMatchObject({ id: saved.id, agentIds: [first] })
            expect(assigned).not.toHaveProperty('catalog.health')
            const [replayed] = await again.sseTools(first, run, signal)
            expect(await replayed.execute({}, signal, 'one-call')).toHaveProperty('result.structuredContent.status', 'uncertain')
            expect(effects).toBe(1)
            expect((await reopened.execute('SELECT count(*) AS n FROM desktop_mcp_sse_calls')).rows[0].n).toBe(1)
            const rotated = await restartedVault.mutate({ operation: 'configure-app', id: assigned.id, revision: assigned.revision,
                methodId, values: { WRIKE_TOKEN: 'rotated-synthetic-wrike-token' } }, current)
            await expect(replayed.execute({}, signal, 'old-revision')).rejects.toThrow()
            const [updated] = await again.sseTools(first, run, signal)
            await restartedVault.assignCoworker(first, { id: assigned.id, revision: rotated.entries[0].revision, attached: false }, current)
            await expect(updated.execute({}, signal, 'after-detach')).rejects.toThrow()
            expect(effects).toBe(1)
        } finally { await again.shutdownSse() }
    } finally { await live.shutdownSse(); await f.close() }
})

test('adopts an installed Wrike SSE account once and fences the old tool path', async () => {
    const f = await fixture()
    try {
        const record = await f.install(first, 'alice', 'permanent-access-token', { WRIKE_TOKEN: 'synthetic-wrike-key' }, {}, 'wrike')
        const input = { db: f.db, workspaceId: 1, key, assertCurrent: current, verifySkills: async () => current }
        expect(await adoptDesktopCatalogApps(input)).toBe(1)
        expect(await adoptDesktopCatalogApps(input)).toBe(0)
        expect(await serviceStore(f.db, key, true).read(first, record.key)).toBeNull()
        expect((await desktopVault(f.db, crypto, 1).list()).entries).toMatchObject([
            { catalog: { slug: 'wrike', methodId: 'permanent-access-token' }, agentIds: [first], hasBearer: true },
        ])
        expect((await f.db.execute('SELECT transport FROM desktop_vault_mcp_servers')).rows[0].transport).toBe('sse')
    } finally { await f.close() }
})

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

test('leaves unsigned OAuth, mismatched identities, unverified skills and changed revisions with the original owner', async () => {
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

test('adopts independent signed-in accounts, mirrors rotations only to the origin, and does not restore a revoked login', async () => {
    const f = await fixture()
    const issuer = 'https://93.184.216.34/'
    const signal = AbortSignal.timeout(10000)
    const input = { db: f.db, workspaceId: 1, key, assertCurrent: current, verifySkills: async () => current }
    const a = await f.install(first, 'alice', 'oauth', {})
    const b = await f.install(second, 'bob', 'oauth', {})
    const bundle: OAuthTokenBundle = { accessToken: 'synthetic-original-access', refreshToken: 'synthetic-original-refresh',
        expiresAt: Date.now() + 1000, resource: a.plan.url, issuer, tokenEndpoint: issuer + 'token', clientId: 'synthetic-public-client' }
    async function saveLegacy(record: ServiceInstall, token: OAuthTokenBundle, generation = randomUUID()) {
        const binding = { endpoint: record.plan.url, configGeneration: record.revision, methodId: record.plan.methodId, engineId: record.engineId }
        const saved = sealCatalogOAuthToken(key(), record.owner, record.id, record.revision, generation, token)
        await f.db.execute({ sql: `INSERT OR IGNORE INTO desktop_service_oauth_attempts
            (owner,attempt_id,request_id,installation_id,revision,state,record) VALUES(?,?,?,?,?,'connected',?)`,
            args: [record.owner, generation, generation, record.id, randomUUID(), JSON.stringify({ binding })] })
        await f.db.execute({ sql: 'INSERT OR REPLACE INTO desktop_service_oauth_tokens VALUES(?,?,?,?,?)',
            args: [record.owner, record.id, record.revision, generation, saved] })
        return generation
    }
    async function readLegacy(record: ServiceInstall) {
        const row = (await f.db.execute({ sql: 'SELECT token_generation,bundle FROM desktop_service_oauth_tokens WHERE owner=? AND installation_id=?',
            args: [record.owner, record.id] })).rows[0]
        return row ? openCatalogOAuthToken(key(), record.owner, record.id, record.revision, String(row.token_generation), String(row.bundle)) : null
    }
    let refreshes = 0
    const json: OAuthJson = async (url, _signal, body) => {
        if (url.includes('oauth-protected-resource')) return { resource: bundle.resource, authorization_servers: [issuer] }
        if (url.includes('oauth-authorization-server')) return {
            issuer, authorization_endpoint: issuer + 'authorize', token_endpoint: issuer + 'token', registration_endpoint: issuer + 'register',
            token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], response_types_supported: ['code'],
            authorization_response_iss_parameter_supported: true,
        }
        expect(url).toBe(bundle.tokenEndpoint)
        expect(body).toBeInstanceOf(URLSearchParams)
        expect((body as URLSearchParams).get('refresh_token')).toBe(bundle.refreshToken)
        expect(await readLegacy(a)).toHaveProperty('refreshPending', expect.any(String))
        expect(await readLegacy(b)).toEqual(bundle)
        refreshes++
        return { access_token: 'synthetic-rotated-access', refresh_token: 'synthetic-rotated-refresh', token_type: 'Bearer', expires_in: 3600 }
    }
    const oauth = vaultMcpOAuth(f.db, crypto, 1, current, json, key)
    try {
        const alphaGeneration = await saveLegacy(a, bundle)
        await saveLegacy(b, bundle)
        expect(await adoptDesktopCatalogApps(input)).toBe(2)
        expect(await adoptDesktopCatalogApps(input)).toBe(0)
        const vault = desktopVault(f.db, crypto, 1)
        const listing = await vault.list()
        const alpha = listing.entries.find(entry => entry.agentIds.includes(first))!
        const beta = listing.entries.find(entry => entry.agentIds.includes(second))!
        expect(listing.entries).toHaveLength(2)
        expect(alpha).toMatchObject({ browserSignIn: true, agentIds: [first] })
        expect(beta).toMatchObject({ browserSignIn: true, agentIds: [second] })
        expect(alpha.id).not.toBe(beta.id)
        expect(JSON.stringify(listing)).not.toContain(bundle.accessToken)
        expect(await serviceStore(f.db, key, true).read(first, a.key)).toBeNull()
        const shared = (await vault.mutate({ operation: 'share', id: alpha.id, revision: alpha.revision,
            agentIds: [first, third], sharedWithAll: false }, current)).entries.find(entry => entry.id === alpha.id)!

        expect(await oauth.credential(alpha.id, alpha.name, shared.revision, signal)).toBe('synthetic-rotated-access')
        expect(refreshes).toBe(1)
        expect(await readLegacy(a)).toMatchObject({ accessToken: 'synthetic-rotated-access', refreshToken: 'synthetic-rotated-refresh' })
        expect(await readLegacy(a)).not.toHaveProperty('refreshPending')
        expect(await readLegacy(b)).toEqual(bundle)
        const sources = await f.db.execute('SELECT owner,installation_id FROM desktop_service_oauth_tokens ORDER BY installation_id')
        expect(sources.rows.map(row => String(row.installation_id)).sort()).toEqual([a.id, b.id].sort())

        // Simulate a successful rotation by the original profile after running a previous build.
        const returned = { ...bundle, accessToken: 'synthetic-rollback-access', refreshToken: 'synthetic-rollback-refresh', expiresAt: Date.now() + 3600000 }
        await saveLegacy(a, returned, alphaGeneration)
        const reopened = createClient({ url: 'file:' + join(f.root, 'app.db') })
        const retryOAuth = vaultMcpOAuth(reopened, crypto, 1, current, json, key)
        try {
            expect(await adoptDesktopCatalogApps({ ...input, db: reopened })).toBe(0)
            expect(await retryOAuth.readOAuth(alpha.id, alpha.name)).toEqual(returned)
            expect(await retryOAuth.readOAuth(beta.id, beta.name)).toEqual(bundle)
            const nextVault = desktopVault(reopened, crypto, 1)
            const currentAlpha = (await nextVault.list()).entries.find(entry => entry.id === alpha.id)!
            expect(currentAlpha.revision).not.toBe(shared.revision)
            await expect(retryOAuth.credential(alpha.id, alpha.name, shared.revision, signal)).rejects.toThrow()
            const signedOut = await nextVault.mutate({ operation: 'clear-server-oauth', id: alpha.id, revision: currentAlpha.revision }, current)
            expect(signedOut.entries.find(entry => entry.id === alpha.id)?.agentIds.sort()).toEqual([first, third].sort())
            expect(await readLegacy(a)).toBeNull()
            expect(await readLegacy(b)).toEqual(bundle)
            expect(await adoptDesktopCatalogApps({ ...input, db: reopened })).toBe(0)
            expect(await retryOAuth.readOAuth(alpha.id, alpha.name)).toBeNull()

            const currentBeta = (await nextVault.list()).entries.find(entry => entry.id === beta.id)!
            await nextVault.assignCoworker(second, { id: beta.id, revision: currentBeta.revision, attached: false }, current)
            expect(await readLegacy(b)).toBeNull()
            expect(await retryOAuth.readOAuth(beta.id, beta.name)).toEqual(bundle)
            expect(await adoptDesktopCatalogApps({ ...input, db: reopened })).toBe(0)
            expect((await nextVault.list()).entries.find(entry => entry.id === beta.id)?.agentIds).toEqual([])
        } finally { retryOAuth.shutdown(); reopened.close() }
    } finally { oauth.shutdown(); await f.close() }
})
