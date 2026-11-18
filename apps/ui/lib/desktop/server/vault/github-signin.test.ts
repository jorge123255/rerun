import { createClient } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { initializeDesktopRound45 } from '../round45-schema'
import { initializeDesktopRound46 } from '../round46-schema'
import { initializeDesktopRound47 } from '../round47-schema'
import { initializeDesktopRound48 } from '../round48-schema'
import { initializeDesktopRound49 } from '../round49-schema'
import { initializeDesktopRound50 } from '../round50-schema'
import { initializeDesktopRound51 } from '../round51-schema'
import { initializeDesktopRound52 } from '../round52-schema'
import { initializeDesktopRound53 } from '../round53-schema'
import { initializeDesktopRound54 } from '../round54-schema'
import { initializeDesktopRound55 } from '../round55-schema'
import { initializeDesktopRound56 } from '../round56-schema'
import { initializeDesktopRound57 } from '../round57-schema'
import { initializeDesktopRound58 } from '../round58-schema'
import { desktopServicesSchema } from '../services/schema'
import { createDesktopSecretCrypto } from '../secret-requests/crypto'
import type { McpNetwork } from '../mcp/remote'
import type { OAuthDeviceForm } from '../mcp/oauth-network'
import { GITHUB_DEVICE_CODE_URL, GITHUB_SIGN_IN_UNAVAILABLE, GITHUB_TOKEN_URL, vaultSignInPlan } from '../mcp/github-device'
import { compileVaultCatalogApp, vaultCatalog } from './catalog'
import { vaultMcpOAuth } from './mcp-oauth'
import { desktopVaultMcpRuntime } from './mcp-runtime'
import { desktopVault } from './store'

// A fake GitHub and a fake GitHub MCP server. No network, no account, no real token.
const key = Buffer.alloc(32, 7)
const crypto = createDesktopSecretCrypto(() => key)
const allow = () => {}
const agent = randomUUID()
const clientId = 'Ov23liFIXTURE0000001'
const deviceCode = 'fixture-vault-device-code'
const accessToken = 'gho_fixtureVaultToken0001'
const signal = new AbortController().signal

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rerun-vault-github-'))
    const file = join(root, 'app.db')
    const db = createClient({ url: `file:${file}` })
    await db.executeMultiple(`PRAGMA foreign_keys=ON;
        CREATE TABLE desktop_schema_migrations (version INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE);
        INSERT INTO desktop_schema_migrations VALUES (44,'keirolabs-search-credentials');
        CREATE TABLE desktop_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id INTEGER NOT NULL, engine_agent_id TEXT);
        CREATE TABLE desktop_deletions (agent_id TEXT NOT NULL, completed INTEGER NOT NULL, engine_agent_id TEXT);
        CREATE TABLE desktop_remote_mcp (agent_id TEXT NOT NULL,name TEXT NOT NULL);
        CREATE TABLE desktop_secret_credentials (agent_id TEXT NOT NULL,key TEXT NOT NULL,version INTEGER NOT NULL,sealed_value TEXT NOT NULL);
        CREATE TABLE desktop_mcp_stdio (owner TEXT NOT NULL,name TEXT NOT NULL,executable TEXT NOT NULL,args TEXT NOT NULL,revision TEXT NOT NULL);
        CREATE TABLE desktop_mcp_stdio_calls(owner TEXT NOT NULL,run_id TEXT NOT NULL,call_id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(owner,run_id,call_id));`)
    await db.execute({ sql: 'INSERT INTO desktop_agents(id,name,workspace_id) VALUES (?,?,1)', args: [agent, 'First'] })
    for (const step of [initializeDesktopRound45, initializeDesktopRound46, initializeDesktopRound47, initializeDesktopRound48, initializeDesktopRound49,
        initializeDesktopRound50, initializeDesktopRound51, initializeDesktopRound52, initializeDesktopRound53, initializeDesktopRound54,
        initializeDesktopRound55, initializeDesktopRound56, initializeDesktopRound57, initializeDesktopRound58]) await step(db)
    await db.executeMultiple(desktopServicesSchema)
    return { db, root, file, vault: desktopVault(db, crypto, 7, 'launch') }
}
const roots: { db: ReturnType<typeof createClient>; root: string }[] = []
afterEach(async () => {
    for (const f of roots.splice(0)) { f.db.close(); await rm(f.root, { recursive: true, force: true }) }
    vi.unstubAllEnvs(); vi.restoreAllMocks()
})

test('without a client ID, GitHub offers the token first and shows the sign-in as unavailable with the reason', async () => {
    vi.stubEnv('RERUN_DESKTOP_GITHUB_CLIENT_ID', '')
    const github = vaultCatalog('github').find(app => app.slug === 'github')!
    expect(github.methods.map(method => [method.id, method.recommended, method.availability])).toEqual([
        ['api-key', true, { id: 'api-key', supported: true }],
        ['oauth', false, { id: 'oauth', supported: false, reason: GITHUB_SIGN_IN_UNAVAILABLE }],
    ])
    expect(() => compileVaultCatalogApp('github', 'oauth', {})).toThrow('Unsupported catalog method')
    // Cloudflare publishes dynamic registration: its sign-in is offered exactly as before.
    const cloudflare = vaultCatalog('cloudflare').find(app => app.slug === 'cloudflare')!
    expect(cloudflare.methods).toMatchObject([{ kind: 'oauth', availability: { supported: true } }])
    expect(compileVaultCatalogApp('cloudflare', cloudflare.methods[0].id, {})).toMatchObject({ browserSignIn: true, url: 'https://mcp.cloudflare.com/mcp' })
})

test('with a client ID, GitHub sign-in is offered and recommended first', async () => {
    vi.stubEnv('RERUN_DESKTOP_GITHUB_CLIENT_ID', clientId)
    const github = vaultCatalog('github').find(app => app.slug === 'github')!
    expect(github.methods.map(method => [method.id, method.recommended, method.availability.supported])).toEqual([['oauth', true, true], ['api-key', false, true]])
    expect(compileVaultCatalogApp('github', 'oauth', {})).toMatchObject({ browserSignIn: true, url: 'https://api.githubcopilot.com/mcp/' })
})

test('a saved GitHub browser entry without a client ID says why and can switch to a token', async () => {
    const f = await fixture(); roots.push(f)
    vi.stubEnv('RERUN_DESKTOP_GITHUB_CLIENT_ID', clientId)
    const [entry] = (await f.vault.mutate({ operation: 'add-app', slug: 'github', methodId: 'oauth', values: {} }, allow)).entries
    expect(entry).toMatchObject({ browserSignIn: true, signedOut: true })
    // The build that saved it had a client ID; this one has none.
    vi.stubEnv('RERUN_DESKTOP_GITHUB_CLIENT_ID', '')
    const oauth = vaultMcpOAuth(f.db, crypto, 7, allow)
    try {
        const reason = { state: 'unsupported', message: GITHUB_SIGN_IN_UNAVAILABLE }
        expect(await oauth.status(entry.id, entry.name, entry.revision, signal)).toEqual(reason)
        expect(await oauth.start(entry.id, entry.name, entry.revision, signal)).toEqual({ status: reason })
        const [token] = (await f.vault.mutate({ operation: 'configure-app', id: entry.id, revision: entry.revision, methodId: 'api-key',
            values: { GITHUB_PAT: 'github_pat_fixture' } }, allow)).entries
        expect(token).toMatchObject({ hasBearer: true, catalog: { methodId: 'api-key' } })
        expect(token).not.toHaveProperty('browserSignIn')
    } finally { oauth.shutdown() }
})

test('device sign-in in the Vault: the token is stored encrypted, used as Bearer, and a 401 asks to sign in again', async () => {
    const f = await fixture(); roots.push(f)
    vi.stubEnv('RERUN_DESKTOP_GITHUB_CLIENT_ID', clientId)
    const logged: unknown[] = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args) => { logged.push(args) })
    const answers: Record<string, unknown>[] = [{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { access_token: accessToken, token_type: 'bearer', scope: 'repo,read:org' }]
    const contacted: string[] = []
    const form: OAuthDeviceForm = async url => {
        contacted.push(url)
        if (url === GITHUB_DEVICE_CODE_URL) return { status: 200, body: { device_code: deviceCode, user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 } }
        return { status: 200, body: answers.shift() ?? { error: 'authorization_pending' } }
    }
    let refuse = false
    const seen: string[] = []
    const network: McpNetwork = async (url, init, guard) => {
        await guard()
        expect(url).toBe('https://api.githubcopilot.com/mcp/')
        seen.push(new Headers(init.headers).get('authorization') ?? '')
        if (refuse) return new Response('{"message":"Bad credentials"}', { status: 401, headers: { 'content-type': 'application/json' } })
        const body = JSON.parse(init.body!)
        const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26' }
            : body.method === 'tools/list' ? { tools: [{ name: 'get_me', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'octocat' }] }
        return body.id === undefined ? new Response(null, { status: 202 }) : Response.json({ jsonrpc: '2.0', id: body.id, result })
    }
    const shutdown = new AbortController()
    const oauth = vaultMcpOAuth(f.db, crypto, 7, allow, undefined, undefined, vaultSignInPlan(clientId, form, async () => {}))
    const runtime = desktopVaultMcpRuntime(f.db, crypto, 7, async () => ({ enabled: true, granted: true }), shutdown.signal, network, allow, undefined, 'catalog', oauth)
    try {
        const [added] = (await f.vault.mutate({ operation: 'add-app', slug: 'github', methodId: 'oauth', values: {} }, allow)).entries
        const [entry] = (await f.vault.assignCoworker(agent, { id: added.id, revision: added.revision, attached: true }, allow)).attached
        const renderer: unknown[] = []
        const started = await oauth.start(entry.id, entry.name, entry.revision, signal)
        renderer.push(started)
        expect(started).toEqual({ status: { state: 'waiting', device: { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' } } })
        await vi.waitFor(async () => {
            const status = await oauth.status(entry.id, entry.name, entry.revision, signal)
            renderer.push(status)
            expect(status).toEqual({ state: 'connected' })
        })
        expect(new Set(contacted)).toEqual(new Set([GITHUB_DEVICE_CODE_URL, GITHUB_TOKEN_URL]))
        expect((await readFile(f.file)).includes(accessToken)).toBe(false)
        const listed = (await f.vault.list()).entries.find(item => item.id === entry.id)!
        renderer.push(listed)
        expect(listed).not.toHaveProperty('signedOut')

        const [tool] = await runtime.tools(agent, signal)
        expect(tool.name).toBe('github_get_me')
        expect(JSON.stringify(await tool.execute({}, signal))).toContain('octocat')
        expect(new Set(seen)).toEqual(new Set(['Bearer ' + accessToken]))
        const check = runtime.catalogHealth('launch')
        const healthy = await check(entry.id, entry.revision, signal)
        renderer.push(healthy)
        // No expiry is reported for a token that has none.
        expect(healthy).toMatchObject({ state: 'healthy', toolCount: 1 })
        expect(healthy).not.toHaveProperty('credentialExpiresAt')

        // GitHub revokes the token: the next call is refused once, and the entry asks for a new sign-in.
        refuse = true
        const requests = seen.length
        await expect(tool.execute({}, signal)).rejects.toThrow()
        const again = { state: 'error', message: 'GitHub no longer accepts this sign-in. Sign in again.', reconnect: true }
        expect(await oauth.status(entry.id, entry.name, entry.revision, signal)).toEqual(again)
        expect((await f.vault.list()).entries.find(item => item.id === entry.id)).toHaveProperty('signedOut', true)
        // No loop: nothing more is sent with the refused token, by tools or by a check.
        expect(await runtime.tools(agent, signal)).toEqual([])
        const revoked = await check(entry.id, entry.revision, signal)
        renderer.push(revoked)
        expect(revoked).toEqual({ state: 'disconnected', checkedAt: expect.any(String), message: 'The app no longer accepts this sign-in. Sign in again.' })
        expect(seen.length).toBe(requests + 1)
        expect(contacted.filter(url => url === GITHUB_DEVICE_CODE_URL)).toHaveLength(1)

        // Signing in again replaces the refused token.
        answers.push({ access_token: accessToken + 'c', token_type: 'bearer' })
        refuse = false
        expect((await oauth.start(entry.id, entry.name, entry.revision, signal)).status.state).toBe('waiting')
        await vi.waitFor(async () => expect(await oauth.status(entry.id, entry.name, entry.revision, signal)).toEqual({ state: 'connected' }))
        // When the connection check is the first to meet the 401, it still records its own result.
        refuse = true
        const first = await check(entry.id, entry.revision, signal)
        renderer.push(first)
        expect(first).toMatchObject({ state: 'disconnected', message: 'The app no longer accepts this sign-in. Sign in again.' })
        expect((await f.vault.list()).entries.find(item => item.id === entry.id)).toMatchObject({ signedOut: true, catalog: { health: { state: 'disconnected' } } })
        expect(await oauth.status(entry.id, entry.name, entry.revision, signal)).toEqual(again)

        answers.push({ access_token: accessToken + 'b', token_type: 'bearer' })
        refuse = false
        expect((await oauth.start(entry.id, entry.name, entry.revision, signal)).status.state).toBe('waiting')
        await vi.waitFor(async () => expect(await oauth.status(entry.id, entry.name, entry.revision, signal)).toEqual({ state: 'connected' }))

        // What the renderer was given, and what was logged, carries neither a token nor the device code.
        for (const value of [JSON.stringify(renderer), JSON.stringify(await f.vault.list()), JSON.stringify(logged)]) {
            expect(value).not.toContain(accessToken)
            expect(value).not.toContain(deviceCode)
        }
    } finally { shutdown.abort(); oauth.shutdown() }
})
