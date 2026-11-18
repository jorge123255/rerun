import { seedConnectCredential } from './connect-owner-fixture'
import { connectToolList } from './connect-test-fixture'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const { createDesktopSecretCrypto } = await import('../secret-requests/crypto')
const { initializeDesktopRound62 } = await import('../round62-schema')
const { initializeDesktopRound66 } = await import('../round66-schema')
const { desktopManagedApps } = await import('./service')
const { managedAppsClient, managedAppsConnectClient, managedProxyAnswer } = await import('./client')

const crypto = createDesktopSecretCrypto(() => Buffer.alloc(32, 7))
const never = new AbortController().signal
let db: Client, dir: string
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'managed-proxy-'))
    db = createClient({ url: `file:${join(dir, 'app.db')}` })
    await db.execute('PRAGMA foreign_keys = ON')
    await db.execute('CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY, id TEXT NOT NULL)')
    await initializeDesktopRound62(db)
    await initializeDesktopRound66(db)
})
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

test('the app’s answer is found however deep Composio wraps it', () => {
    expect(managedProxyAnswer({ status: 200, data: { id: 1 }, headers: {} })).toEqual({ status: 200, data: { id: 1 } })
    expect(managedProxyAnswer({ data: { response: { status: 404, data: { message: 'Not Found' } } } })).toEqual({ status: 404, data: { message: 'Not Found' } })
    expect(managedProxyAnswer({ status_code: 200, body: [1] })).toEqual({ status: 200, data: [1] })
    expect(managedProxyAnswer({ status: 'active', data: {} })).toBeNull()
    expect(managedProxyAnswer({ preview: 'saved to a file' })).toBeNull()
    expect(managedProxyAnswer(null)).toBeNull()
})

// Composio Connect with GitHub signed in or not; every tool call is kept.
function connectServer(signedIn = true) {
    const calls: { name: string; arguments: Record<string, unknown> }[] = []
    const network = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }, { headers: { 'mcp-session-id': 's1' } })
        if (body.method === 'tools/list') return connectToolList(body.id)
        if (body.method !== 'tools/call') return new Response(null, { status: 202 })
        calls.push(body.params)
        const reply = (data: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ successful: true, data }) }] } })
        if (body.params.name === 'COMPOSIO_PROXY_EXECUTE') return reply({ status: 200, headers: {}, data: { full_name: 'acme/secret', private: true } })
        const name = body.params.arguments.toolkits[0].name
        return reply({ results: { [name]: { toolkit: name, status: signedIn ? 'active' : 'initiated', redirect_url: 'https://connect.composio.dev/link/lk_1', accounts: signedIn ? [{ id: 'ca_1', status: 'ACTIVE' }] : [] } } })
    }) as typeof fetch
    return { network, calls }
}

test('with Composio Connect a signed-in GitHub reads one repository path, and nothing else', async () => {
    const server = connectServer()
    const identity = await seedConnectCredential(db)
    const apps = desktopManagedApps(db, crypto, 1, { returnUrl: 'http://127.0.0.1/return', coworkerExists: async () => true, connect: async () => ({ ...managedAppsConnectClient('ck_fixture_consumer', server.network), identity }) })
    expect(await apps.githubReader()).toBeNull()
    await apps.act({ action: 'connect', slug: 'github' })
    const read = await apps.githubReader()
    expect(await read!('/repos/acme/secret', never)).toEqual({ status: 200, data: { full_name: 'acme/secret', private: true } })
    expect(server.calls.at(-1)).toEqual({ name: 'COMPOSIO_PROXY_EXECUTE', arguments: { toolkit_slug: 'github', endpoint: '/repos/acme/secret', method: 'GET' } })
    const before = server.calls.length
    await expect(read!('/user/repos', never)).rejects.toThrow('cannot be read')
    await expect(read!('/repos/acme/secret?ref=x', never)).rejects.toThrow('cannot be read')
    expect(server.calls.length).toBe(before)
})

test('a GitHub sign-in that is still pending reads nothing', async () => {
    const server = connectServer(false)
    const identity = await seedConnectCredential(db)
    const apps = desktopManagedApps(db, crypto, 1, { returnUrl: 'http://127.0.0.1/return', coworkerExists: async () => true, connect: async () => ({ ...managedAppsConnectClient('ck_fixture_consumer', server.network), identity }) })
    await apps.act({ action: 'connect', slug: 'github' })
    expect(await apps.githubReader()).toBeNull()
})

test('with a project key the read names the connected account and is a GET', async () => {
    const sent: { path: string; body: unknown; key: string | null }[] = []
    const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('x-api-key') })
        return Response.json({ status: 200, data: { name: 'secret' }, headers: {} })
    }) as typeof fetch
    expect(await managedAppsClient('fixture-key', network).proxyGet('ca_7', '/repos/acme/secret/readme')).toEqual({ status: 200, data: { name: 'secret' } })
    expect(sent).toEqual([{ path: '/api/v3.1/tools/execute/proxy', body: { connected_account_id: 'ca_7', endpoint: '/repos/acme/secret/readme', method: 'GET' }, key: 'fixture-key' }])
    await expect(managedAppsClient('fixture-key', network).proxyGet('ca_7', 'https://evil.example/x')).rejects.toThrow('cannot be read')
})

test('an open GitHub reader stops before the next read if its Connect key has been replaced', async () => {
    const server = connectServer()
    const identity = await seedConnectCredential(db)
    const apps = desktopManagedApps(db, crypto, 1, {
        returnUrl: 'http://127.0.0.1/return', coworkerExists: async () => true,
        connect: async () => ({ ...managedAppsConnectClient('ck_fixture_consumer', server.network), identity }),
    })
    await apps.act({ action: 'connect', slug: 'github' })
    const read = await apps.githubReader()
    const calls = server.calls.length
    await db.execute("UPDATE desktop_vault_mcp_servers SET credential_revision='changed'")
    await expect(read!('/repos/fixture/demo', never)).rejects.toMatchObject({ status: 409 })
    expect(server.calls).toHaveLength(calls)
})
