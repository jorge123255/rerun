import { createClient, type Client } from '@libsql/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createMcpCredentialGeneration } from './credential-generation'
import { remoteMcpStore, type OAuthTokenBundle } from './store'

const KEY = Buffer.alloc(32, 7)
const SERVER = 'linear'
const AGENT = 'coworker-a'
const URL = 'https://mcp.example/mcp'
const signal = () => new AbortController().signal

let db: Client
let directory: string | undefined
let store: ReturnType<typeof remoteMcpStore>

afterEach(() => { db?.close(); if (directory) rmSync(directory, { recursive: true, force: true }) })

const bundle = (accessToken: string): OAuthTokenBundle => ({
    accessToken, expiresAt: 1_800_000_000_000, resource: URL, issuer: 'https://issuer.example',
    tokenEndpoint: 'https://issuer.example/token', clientId: 'synthetic-client',
})

async function setup(now: () => number = () => 0) {
    // Transactions open another connection; use the same file as the real workspace.
    directory = mkdtempSync(join(tmpdir(), 'rerun-mcp-generation-'))
    db = createClient({ url: `file:${join(directory, 'workspace.db')}` })
    await db.executeMultiple(`
        CREATE TABLE desktop_agents (id TEXT PRIMARY KEY);
        CREATE TABLE desktop_remote_mcp (id TEXT NOT NULL, transport TEXT NOT NULL, agent_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, revision TEXT NOT NULL, bearer TEXT, PRIMARY KEY (agent_id, name));
        CREATE TABLE desktop_remote_mcp_oauth (agent_id TEXT NOT NULL, name TEXT NOT NULL, revision TEXT NOT NULL, bundle TEXT NOT NULL, PRIMARY KEY (agent_id, name));
        INSERT INTO desktop_agents VALUES ('${AGENT}');
        INSERT INTO desktop_remote_mcp VALUES ('reg-1','http','${AGENT}','${SERVER}','${URL}','rev-1',NULL);
    `)
    store = remoteMcpStore(db, () => KEY)
    return createMcpCredentialGeneration({ store, key: () => KEY, ttlMs: 60_000, now })
}

test('the generation is opaque, durable and stable across reads before any credential exists', async () => {
    const generation = await setup()
    const first = await generation.read(AGENT, SERVER)
    const second = await generation.read(AGENT, SERVER)
    expect(first?.generation).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second?.generation).toBe(first?.generation)
    expect(first?.registrationId).toBe('reg-1')
    expect(first?.revision).toBe('rev-1')
    expect(JSON.stringify(first)).not.toContain(URL)
})

test('an unrelated credential write invalidates the lease and changes the generation', async () => {
    const generation = await setup()
    const lease = await generation.read(AGENT, SERVER)
    await store.writeOAuth(AGENT, SERVER, 'rev-1', bundle('someone-else'), signal())
    expect(() => lease!.check()).toThrow('invalidated')
    const after = await generation.read(AGENT, SERVER)
    expect(after?.generation).not.toBe(lease?.generation)
})

test('only the exact approved generation may advance the credential', async () => {
    const generation = await setup()
    const lease = await generation.read(AGENT, SERVER)
    const advanced = await generation.advance(AGENT, SERVER, lease!.generation, bundle('approved'), signal())
    expect(advanced.generation).not.toBe(lease!.generation)
    await expect(generation.advance(AGENT, SERVER, lease!.generation, bundle('late'), signal())).rejects.toThrow('MCP credential generation changed')
    const stored = await store.readOAuth(AGENT, SERVER)
    expect(stored?.accessToken).toBe('approved')
})

test('a registration edit or revoke invalidates the old generation', async () => {
    const generation = await setup()
    const lease = await generation.read(AGENT, SERVER)
    await store.save(AGENT, { name: SERVER, url: URL, revision: 'rev-1' })
    const edited = await generation.read(AGENT, SERVER)
    expect(edited?.generation).not.toBe(lease?.generation)
    expect(edited?.revision).not.toBe('rev-1')
    await store.remove(AGENT, SERVER, edited!.revision)
    await expect(generation.read(AGENT, SERVER)).resolves.toBeNull()
    await expect(generation.advance(AGENT, SERVER, edited!.generation, bundle('gone'), signal())).rejects.toThrow('unavailable')
})

test('Stop and expiry invalidate an issued lease', async () => {
    let clock = 1_000
    const generation = await setup(() => clock)
    const lease = await generation.read(AGENT, SERVER)
    store.lifecycle.disconnect(AGENT, SERVER)
    expect(() => lease!.check()).toThrow('invalidated')

    clock = 2_000
    const expiring = await createMcpCredentialGeneration({ store, key: () => KEY, ttlMs: 5, now: () => clock }).read(AGENT, SERVER)
    clock += 6
    expect(() => expiring!.check()).toThrow('expired')
    expiring!.dispose()
    lease!.dispose()
})

test('a late approved exchange cannot replace a credential written by a different store', async () => {
    const generation = await setup()
    const lease = await generation.read(AGENT, SERVER)
    const other = remoteMcpStore(db, () => KEY)
    const racing = createMcpCredentialGeneration({
        key: () => KEY,
        store: {
            ...store,
            async replaceOAuth(agent, name, expected, next, stop) {
                await other.writeOAuth(agent, name, expected.revision, bundle('browser-won'), stop)
                return store.replaceOAuth(agent, name, expected, next, stop)
            },
        },
    })
    await expect(racing.advance(AGENT, SERVER, lease!.generation, bundle('late-device'), signal())).rejects.toThrow('MCP credential generation changed')
    expect((await store.readOAuth(AGENT, SERVER))?.accessToken).toBe('browser-won')
    lease!.dispose()
})
