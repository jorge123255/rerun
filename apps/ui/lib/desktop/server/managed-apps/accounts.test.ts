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
const { initializeDesktopRound73 } = await import('../round73-schema')
const { desktopManagedApps, managedAppUserId } = await import('./service')
const { managedAppsConnectClient } = await import('./client')

const KEY = 'fixture-composio-key-0001'
let db: Client, dir: string
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'managed-accounts-'))
    db = createClient({ url: `file:${join(dir, 'app.db')}` })
    await db.execute('PRAGMA foreign_keys = ON')
    await db.execute('CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY, id TEXT NOT NULL)')
    await initializeDesktopRound62(db)
})
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

// A pretend Composio project that holds any number of connected accounts.
function composio() {
    const accounts = new Map<string, { user: string; toolkit: string; status: string }>()
    const state = { accounts, removed: [] as string[], executed: [] as { tool: string; user: string; account: string }[], down: false, refuses: false, links: 0 }
    const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input)), path = url.pathname.replace('/api/v3.1', ''), method = init?.method ?? 'GET'
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        if (new Headers(init?.headers).get('x-api-key') !== KEY) return Response.json({}, { status: 401 })
        if (state.down) throw new TypeError('offline')
        if (path === '/toolkits') return Response.json({ items: [{ slug: 'gmail', name: 'Gmail', composio_managed_auth_schemes: ['OAUTH2'] }], next_cursor: null })
        if (path === '/auth_configs') return Response.json({ items: [{ id: 'ac_gmail', status: 'ENABLED', toolkit: { slug: 'gmail' } }] })
        if (path === '/connected_accounts/link') {
            const id = `ca_${++state.links}`
            accounts.set(id, { user: body.user_id, toolkit: 'gmail', status: 'INITIATED' })
            return Response.json({ connected_account_id: id, redirect_url: `https://connect.composio.example/link/${id}` })
        }
        const account = /^\/connected_accounts\/(\w+)$/.exec(path)?.[1]
        if (account) {
            const held = accounts.get(account)
            if (!held) return Response.json({}, { status: 404 })
            if (method === 'DELETE') { accounts.delete(account); state.removed.push(account); return Response.json({ success: true }) }
            return Response.json({ id: account, user_id: held.user, status: held.status, toolkit: { slug: held.toolkit } })
        }
        if (path === '/tools') return Response.json({ items: [{ slug: 'GMAIL_FETCH_EMAILS', description: 'Read mail', input_parameters: { type: 'object', properties: {} } }], next_cursor: null })
        if (path === '/tools/execute/GMAIL_FETCH_EMAILS') {
            state.executed.push({ tool: 'GMAIL_FETCH_EMAILS', user: body.user_id, account: body.connected_account_id })
            return Response.json(state.refuses ? { successful: false, error: 'invalid_grant' } : { successful: true, data: { mail: 1 } })
        }
        return Response.json({}, { status: 500 })
    }) as typeof fetch
    return { network, state }
}
const crypto = createDesktopSecretCrypto(() => Buffer.alloc(32, 7))
const RETURN = 'http://127.0.0.1:4000/api/desktop/managed-apps/return'
async function service(network: typeof fetch, workspaceId = 1) {
    await initializeDesktopRound66(db)
    const apps = desktopManagedApps(db, crypto, workspaceId, { network, returnUrl: RETURN, coworkerExists: async () => true })
    await apps.act({ action: 'set-key', key: KEY })
    return apps
}
const signal = () => new AbortController().signal

test('the migration keeps the accounts and their coworkers, and lets an app have a second, labelled account', async () => {
    await db.execute("INSERT INTO desktop_managed_app_accounts VALUES('a1','gmail','gmail','Gmail','rerun_mac_a1','ca_old','active','2026-11-01T00:00:00.000Z')")
    await db.execute("INSERT INTO desktop_managed_app_attachments VALUES('a1','coworker-1')")
    await initializeDesktopRound66(db)
    await initializeDesktopRound66(db)
    expect((await db.execute('SELECT id,label,status,user_id FROM desktop_managed_app_accounts')).rows.map(row => ({ ...row }))).toEqual([{ id: 'a1', label: '', status: 'active', user_id: 'rerun_mac_a1' }])
    expect((await db.execute('SELECT account_id,agent_id FROM desktop_managed_app_attachments')).rows.map(row => ({ ...row }))).toEqual([{ account_id: 'a1', agent_id: 'coworker-1' }])
    await db.execute("INSERT INTO desktop_managed_app_accounts(id,slug,toolkit,name,label,user_id,connected_account_id,status,created_at) VALUES('a2','gmail','gmail','Gmail','Work','u','c','expired','x')")
    await expect(db.execute("INSERT INTO desktop_managed_app_accounts(id,slug,toolkit,name,label,user_id,connected_account_id,status,created_at) VALUES('a3','gmail','gmail','Gmail','work','u','c','pending','x')")).rejects.toThrow()
    // Removing an account still takes its coworkers with it.
    await db.execute("DELETE FROM desktop_managed_app_accounts WHERE id='a1'")
    expect((await db.execute('SELECT 1 FROM desktop_managed_app_attachments')).rows).toEqual([])
})

test('a second account of one app is told apart by a label, lives under its own user, and a coworker holds one of them', async () => {
    const fake = composio(), apps = await service(fake.network)
    const first = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
    expect(first.label).toBeUndefined()
    await expect(apps.act({ action: 'connect', slug: 'gmail' })).rejects.toThrow('Give another one a label')
    const both = (await apps.act({ action: 'connect', slug: 'gmail', label: 'Work' })).view.accounts
    expect(both.map(row => [row.name, row.label])).toEqual([['Gmail', undefined], ['Gmail', 'Work']])
    await expect(apps.act({ action: 'connect', slug: 'gmail', label: 'work' })).rejects.toThrow('already has an account with this label')
    const second = both[1]!
    // Each account is its own Composio user, built from the workspace and the account.
    expect(fake.state.accounts.get('ca_1')!.user).toBe(managedAppUserId(1, first.id))
    expect(fake.state.accounts.get('ca_2')!.user).toBe(managedAppUserId(1, second.id))
    expect(managedAppUserId(1, first.id)).toBe(`rerun_mac_w1_${first.id}`)

    for (const held of fake.state.accounts.values()) held.status = 'ACTIVE'
    await apps.act({ action: 'refresh', id: first.id })
    await apps.act({ action: 'refresh', id: second.id })
    await apps.act({ action: 'attach', id: second.id, agentId: 'coworker-1', attached: true })
    await expect(apps.act({ action: 'attach', id: first.id, agentId: 'coworker-1', attached: true })).rejects.toThrow('already uses another account of this app')
    await apps.act({ action: 'attach', id: first.id, agentId: 'coworker-2', attached: true })
    // Each coworker's call goes out as its own account.
    await (await apps.tools('coworker-1', signal()))[0]!.execute({}, signal(), 'c1')
    await (await apps.tools('coworker-2', signal()))[0]!.execute({}, signal(), 'c2')
    expect(fake.state.executed.map(call => call.user)).toEqual([managedAppUserId(1, second.id), managedAppUserId(1, first.id)])

    expect(fake.state.executed.map(call => call.account)).toEqual(['ca_2', 'ca_1'])
    const [oldTool] = await apps.tools('coworker-1', signal())
    await db.execute({ sql: "UPDATE desktop_managed_app_accounts SET connected_account_id='ca_replaced' WHERE id=?", args: [second.id] })
    await expect(oldTool.execute({}, signal(), 'stale')).rejects.toThrow('no longer attached')
    expect(fake.state.executed).toHaveLength(2)
    await db.execute({ sql: "UPDATE desktop_managed_app_accounts SET connected_account_id='ca_2' WHERE id=?", args: [second.id] })

    // Removing one revokes that one at Composio and leaves the other.
    await apps.act({ action: 'remove', id: second.id })
    expect(fake.state.removed).toEqual(['ca_2'])
    expect([...fake.state.accounts.keys()]).toEqual(['ca_1'])
})

test('removing an account revokes it at Composio only when it is proven to be that account', async () => {
    const fake = composio(), apps = await service(fake.network)
    const account = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
    // The id kept beside the row points at an account of another user: it is left as it is, and the row goes.
    fake.state.accounts.set('ca_other', { user: 'someone_else', toolkit: 'gmail', status: 'ACTIVE' })
    await db.execute({ sql: "UPDATE desktop_managed_app_accounts SET connected_account_id='ca_other' WHERE id=?", args: [account.id] })
    expect((await apps.act({ action: 'remove', id: account.id })).view.accounts).toEqual([])
    expect(fake.state.removed).toEqual([])
    expect(fake.state.accounts.has('ca_other')).toBe(true)

    // An account Composio no longer has is nothing to revoke.
    const gone = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
    fake.state.accounts.clear()
    expect((await apps.act({ action: 'remove', id: gone.id })).view.accounts).toEqual([])

    // While Composio cannot be reached the account stays in the Vault, so its sign-in is not left behind unseen.
    const kept = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
    fake.state.down = true
    await expect(apps.act({ action: 'remove', id: kept.id })).rejects.toMatchObject({ status: 503 })
    fake.state.down = false
    expect((await apps.view()).accounts.map(row => row.id)).toEqual([kept.id])
    await apps.act({ action: 'remove', id: kept.id })
    expect(fake.state.removed).toEqual(['ca_3'])
})

test('removing the key revokes its own accounts and never one that is not', async () => {
    const fake = composio(), apps = await service(fake.network)
    const first = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
    await apps.act({ action: 'connect', slug: 'gmail', label: 'Work' })
    fake.state.accounts.set('ca_other', { user: 'someone_else', toolkit: 'gmail', status: 'ACTIVE' })
    await db.execute({ sql: "UPDATE desktop_managed_app_accounts SET connected_account_id='ca_other' WHERE id=?", args: [first.id] })
    // The confirm text counts the accounts this Mac made, whatever Composio later says of them.
    expect((await apps.view()).keyRemovalSignsOut).toBe(2)
    const cleared = await apps.act({ action: 'remove-key' })
    expect(cleared.view).toMatchObject({ configured: false, accounts: [] })
    expect(cleared.notSignedOut).toBeUndefined()
    expect(cleared.view.keyRemovalSignsOut).toBeUndefined()
    expect(fake.state.removed).toEqual(['ca_2'])
    expect(fake.state.accounts.has('ca_other')).toBe(true)
})

test('removing the key never asks Composio about a row that does not carry this Mac’s user naming', async () => {
    const fake = composio(), apps = await service(fake.network)
    const account = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
    // The row was pointed at another user and at that user's real account: nothing of it is read or removed.
    fake.state.accounts.set('ca_theirs', { user: 'someone_else', toolkit: 'gmail', status: 'ACTIVE' })
    await db.execute({ sql: "UPDATE desktop_managed_app_accounts SET user_id='someone_else', connected_account_id='ca_theirs' WHERE id=?", args: [account.id] })
    expect((await apps.view()).keyRemovalSignsOut).toBe(0)
    const asked: string[] = []
    const watched = (async (input: RequestInfo | URL, init?: RequestInit) => { asked.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`); return fake.network(input, init) }) as typeof fetch
    const again = desktopManagedApps(db, crypto, 1, { network: watched, returnUrl: RETURN, coworkerExists: async () => true })
    expect((await again.act({ action: 'remove-key' })).view).toMatchObject({ configured: false, accounts: [] })
    expect(asked.filter(line => line.includes('connected_accounts'))).toEqual([])
    expect(fake.state.removed).toEqual([])
    expect([...fake.state.accounts.keys()].sort()).toEqual(['ca_1', 'ca_theirs'])
})

test('a Composio that cannot be reached keeps the key and names the accounts still signed in; removing anyway is a second choice', async () => {
    const fake = composio(), apps = await service(fake.network)
    const first = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
    await apps.act({ action: 'connect', slug: 'gmail', label: 'Work' })
    await db.execute({ sql: "UPDATE desktop_managed_app_accounts SET status='active' WHERE id=?", args: [first.id] })
    await apps.act({ action: 'attach', id: first.id, agentId: 'coworker-1', attached: true })
    fake.state.down = true
    const held = await apps.act({ action: 'remove-key' })
    expect(held.notSignedOut).toEqual(['Gmail', 'Gmail · Work'])
    expect(held.view).toMatchObject({ configured: true, keyRemovalSignsOut: 2 })
    expect(held.view.accounts.map(row => row.agentIds)).toEqual([['coworker-1'], []])
    expect((await db.execute('SELECT COUNT(*) AS n FROM desktop_managed_app_key')).rows[0]!.n).toBe(1)

    // Reachable again: asking once more signs both out and drops the key.
    fake.state.down = false
    const cleared = await apps.act({ action: 'remove-key' })
    expect(cleared.notSignedOut).toBeUndefined()
    expect(cleared.view).toMatchObject({ configured: false, accounts: [] })
    expect(fake.state.removed).toEqual(['ca_1', 'ca_2'])

    // The explicit second choice: the key and the rows go, and the sign-ins are left at Composio.
    await apps.act({ action: 'set-key', key: KEY })
    await apps.act({ action: 'connect', slug: 'gmail' })
    fake.state.down = true
    expect((await apps.act({ action: 'remove-key' })).notSignedOut).toEqual(['Gmail'])
    const forced = await apps.act({ action: 'remove-key', leaveSignedIn: true })
    expect(forced.notSignedOut).toBeUndefined()
    expect(forced.view).toMatchObject({ configured: false, accounts: [] })
    expect((await db.execute('SELECT COUNT(*) AS n FROM desktop_managed_app_key')).rows[0]!.n).toBe(0)
    expect(fake.state.accounts.has('ca_3')).toBe(true)
})

test('an account signed out before Composio went away leaves the Vault, and only the rest is named', async () => {
    const fake = composio(), apps = await service(fake.network)
    await apps.act({ action: 'connect', slug: 'gmail' })
    await apps.act({ action: 'connect', slug: 'gmail', label: 'Work' })
    // Composio answers for the first account and is gone before the second.
    let deletes = 0
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const answer = await fake.network(input, init)
        if (init?.method === 'DELETE' && ++deletes === 1) fake.state.down = true
        return answer
    }) as typeof fetch
    const again = desktopManagedApps(db, crypto, 1, { network: flaky, returnUrl: RETURN, coworkerExists: async () => true })
    const held = await again.act({ action: 'remove-key' })
    expect(held.notSignedOut).toEqual(['Gmail · Work'])
    expect(held.view.accounts.map(row => row.label)).toEqual(['Work'])
    expect(held.view).toMatchObject({ configured: true, keyRemovalSignsOut: 1 })
    expect(fake.state.removed).toEqual(['ca_1'])
})

test('an account whose user is not this workspace’s own is never used, checked or revoked', async () => {
    const fake = composio(), apps = await service(fake.network, 1)
    const account = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
    fake.state.accounts.get('ca_1')!.status = 'ACTIVE'
    await apps.act({ action: 'refresh', id: account.id })
    await apps.act({ action: 'attach', id: account.id, agentId: 'coworker-1', attached: true })
    const held = await apps.tools('coworker-1', signal())
    expect(held).toHaveLength(1)

    // The same rows read as another workspace: the user names workspace 1, so workspace 2 does nothing with it.
    const other = desktopManagedApps(db, crypto, 2, { network: fake.network, returnUrl: RETURN, coworkerExists: async () => true })
    expect(await other.tools('coworker-1', signal()).catch(() => [])).toEqual([])

    // A row pointed at another user of the project stops a tool a run still holds, and is not revoked.
    fake.state.accounts.set('ca_victim', { user: 'rerun_mac_w1_victim', toolkit: 'gmail', status: 'ACTIVE' })
    await db.execute({ sql: "UPDATE desktop_managed_app_accounts SET user_id='rerun_mac_w1_victim', connected_account_id='ca_victim' WHERE id=?", args: [account.id] })
    await expect(held[0]!.execute({}, signal(), 'c1')).rejects.toThrow('no longer attached')
    expect(fake.state.executed).toEqual([])
    expect(await apps.tools('coworker-1', signal())).toEqual([])
    expect((await apps.act({ action: 'refresh', id: account.id, retry: true })).signIn).toBeUndefined()
    expect(fake.state.links).toBe(1)
    await apps.act({ action: 'remove', id: account.id })
    expect(fake.state.removed).toEqual([])

    // An account made before users carried the workspace keeps working without a new sign-in.
    fake.state.accounts.set('ca_legacy', { user: 'rerun_mac_11111111-1111-4111-8111-111111111111', toolkit: 'gmail', status: 'ACTIVE' })
    await db.execute("INSERT INTO desktop_managed_app_accounts(id,slug,toolkit,name,label,user_id,connected_account_id,status,created_at) VALUES('11111111-1111-4111-8111-111111111111','gmail','gmail','Gmail','','rerun_mac_11111111-1111-4111-8111-111111111111','ca_legacy','pending','x')")
    expect((await apps.act({ action: 'refresh', id: '11111111-1111-4111-8111-111111111111' })).view.accounts[0]!.status).toBe('active')
})

test('an expired account says so, loses its tools, and comes back to its coworkers after signing in again', async () => {
    const fake = composio(), apps = await service(fake.network)
    const account = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
    fake.state.accounts.get('ca_1')!.status = 'ACTIVE'
    await apps.act({ action: 'refresh', id: account.id })
    await apps.act({ action: 'attach', id: account.id, agentId: 'coworker-1', attached: true })
    const [tool] = await apps.tools('coworker-1', signal())

    // A call the app refuses while the sign-in still stands is only a refused call.
    fake.state.refuses = true
    expect((await tool!.execute({}, signal(), 'c1')).result).toEqual({ content: [{ type: 'text', text: '{"error":"invalid_grant"}' }], isError: true })
    expect((await apps.view()).accounts[0]!.status).toBe('active')

    // Once Composio says the sign-in ran out, the refused call marks the account expired and says what to do.
    fake.state.accounts.get('ca_1')!.status = 'EXPIRED'
    const refused = await tool!.execute({}, signal(), 'c2')
    expect(JSON.stringify(refused.result)).toContain('has expired')
    expect((await apps.view()).accounts[0]).toMatchObject({ status: 'expired', agentIds: ['coworker-1'] })
    expect(await apps.tools('coworker-1', signal())).toEqual([])
    await expect(tool!.execute({}, signal(), 'c3')).rejects.toThrow('no longer attached')
    await expect(apps.act({ action: 'attach', id: account.id, agentId: 'coworker-2', attached: true })).rejects.toThrow('Sign in to this app again first.')

    // Signing in again opens a fresh page under the same user and removes the sign-in it replaces.
    fake.state.refuses = false
    const again = await apps.act({ action: 'refresh', id: account.id, retry: true })
    expect(again.signIn).toBe('https://connect.composio.example/link/ca_2')
    expect(again.view.accounts[0]!.status).toBe('pending')
    expect(fake.state.removed).toEqual(['ca_1'])
    expect(fake.state.accounts.get('ca_2')!.user).toBe(managedAppUserId(1, account.id))
    fake.state.accounts.get('ca_2')!.status = 'ACTIVE'
    expect((await apps.act({ action: 'refresh', id: account.id })).view.accounts[0]).toMatchObject({ status: 'active', agentIds: ['coworker-1'] })
    expect((await (await apps.tools('coworker-1', signal()))[0]!.execute({}, signal(), 'c4')).result).toEqual({ content: [{ type: 'text', text: '{"mail":1}' }] })

    // An account removed in the Composio dashboard is found expired when it is checked.
    fake.state.accounts.clear()
    expect((await apps.act({ action: 'refresh', id: account.id })).view.accounts[0]!.status).toBe('expired')
})

// A pretend Composio Connect that answers for one app.
function connectServer() {
    const state = { signedIn: true }
    const network = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }, { headers: { 'mcp-session-id': 's1' } })
        if (body.method === 'tools/list') return connectToolList(body.id)
        if (body.method !== 'tools/call') return new Response(null, { status: 202 })
        const { name, action } = body.params.arguments.toolkits[0]
        const row = action === 'add' && !state.signedIn ? { toolkit: name, status: 'initiated', redirect_url: 'https://connect.composio.dev/link/lk_again' }
            : { toolkit: name, status: state.signedIn ? 'active' : 'not_connected', accounts: state.signedIn ? [{ id: 'ca_9', status: 'ACTIVE' }] : [] }
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ successful: true, data: { results: { [name]: row } } }) }] } })
    }) as typeof fetch
    return { network, state }
}

test('with a Connect key an app that is no longer signed in shows as expired, one account per app, and leaves with the Vault entry', async () => {
    await initializeDesktopRound66(db)
    const server = connectServer()
    const identity = await seedConnectCredential(db)
    const apps = desktopManagedApps(db, crypto, 1, { returnUrl: RETURN, coworkerExists: async () => true, connect: async () => ({ ...managedAppsConnectClient('ck_fixture_consumer', server.network), identity }) })
    const account = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
    expect(account.status).toBe('active')
    await expect(apps.act({ action: 'connect', slug: 'gmail', label: 'Work' })).rejects.toThrow('already has an account')

    server.state.signedIn = false
    expect((await apps.act({ action: 'refresh', id: account.id })).view.accounts[0]!.status).toBe('expired')
    const again = await apps.act({ action: 'refresh', id: account.id, retry: true })
    expect(again.signIn).toBe('https://connect.composio.dev/link/lk_again')
    expect(again.view.accounts[0]!.status).toBe('pending')
    server.state.signedIn = true
    expect((await apps.act({ action: 'refresh', id: account.id })).view.accounts[0]!.status).toBe('active')

    // The Vault entry that held the Connect key is removed: the apps listed through it leave the list.
    await db.execute("INSERT INTO desktop_managed_app_accounts(id,slug,toolkit,name,label,user_id,connected_account_id,status,created_at) VALUES('p1','slack','slack','Slack','','rerun_mac_w1_p1','ca_p','active','x')")
    const tx = await db.transaction('write')
    try {
        const { clearConnectAccounts } = await import('./assigned')
        await clearConnectAccounts(tx)
        await tx.commit()
    } finally { tx.close() }
    expect((await db.execute('SELECT id FROM desktop_managed_app_accounts')).rows.map(row => row.id)).toEqual(['p1'])
})

test.each(['missing-id', 'wrong-id', 'missing-user', 'missing-toolkit', 'wrong-toolkit', 'disabled'])(
    'a previously active project account loses its tools when Composio reports %s',
    async (problem) => {
        const fake = composio()
        let changed = false
        const apps = await service(async (input, init) => {
            const answer = await fake.network(input, init)
            if (!changed || init?.method === 'DELETE' || !String(input).endsWith('/connected_accounts/ca_1')) return answer
            const record = await answer.json()
            if (problem === 'missing-id') delete record.id
            if (problem === 'wrong-id') record.id = 'ca_other'
            if (problem === 'missing-user') delete record.user_id
            if (problem === 'missing-toolkit') delete record.toolkit
            if (problem === 'wrong-toolkit') record.toolkit = { slug: 'calendar' }
            if (problem === 'disabled') record.is_disabled = true
            return Response.json(record)
        })
        const account = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
        fake.state.accounts.get('ca_1')!.status = 'ACTIVE'
        await apps.act({ action: 'refresh', id: account.id })
        await apps.act({ action: 'attach', id: account.id, agentId: 'ada', attached: true })
        const [held] = await apps.tools('ada', signal())
        expect(held.name).toBe('GMAIL_FETCH_EMAILS')

        changed = true
        const checked = await apps.act({ action: 'refresh', id: account.id, retry: problem !== 'disabled' })
        expect(checked.signIn).toBeUndefined()
        expect(checked.view.accounts[0]?.status).toBe('expired')
        expect(await apps.tools('ada', signal())).toEqual([])
        await expect(held.execute({}, signal(), 'refused')).rejects.toThrow('no longer attached')
        if (problem !== 'disabled') {
            if (problem.startsWith('missing-')) {
                await expect(apps.act({ action: 'remove', id: account.id })).rejects.toMatchObject({ status: 502 })
                expect((await apps.view()).accounts[0]?.id).toBe(account.id)
            } else {
                await apps.act({ action: 'remove', id: account.id })
            }
            expect(fake.state.removed).toEqual([])
            expect(fake.state.links).toBe(1)
        }
    },
)

test.each(['account', 'attachment', 'key'])('a delayed tool reply is withheld after its %s changes', async (change) => {
    let release!: () => void, started!: () => void
    const received = new Promise<void>(resolve => { started = resolve })
    const resume = new Promise<void>(resolve => { release = resolve })
    const fake = composio()
    const apps = await service(async (input, init) => {
        const answer = await fake.network(input, init)
        if (String(input).endsWith('/tools/execute/GMAIL_FETCH_EMAILS')) {
            started()
            await resume
        }
        return answer
    })
    const row = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
    fake.state.accounts.get('ca_1')!.status = 'ACTIVE'
    await apps.act({ action: 'refresh', id: row.id })
    await apps.act({ action: 'attach', id: row.id, agentId: 'ada', attached: true })
    const [tool] = await apps.tools('ada', signal())
    const pending = tool.execute({}, signal(), 'reading')
    await received
    try {
        if (change === 'account') {
            await db.execute({ sql: "UPDATE desktop_managed_app_accounts SET connected_account_id='ca_replacement' WHERE id=?", args: [row.id] })
        } else if (change === 'attachment') {
            await apps.act({ action: 'attach', id: row.id, agentId: 'ada', attached: false })
        } else {
            await apps.act({ action: 'set-key', key: KEY })
        }
    } finally { release() }
    await expect(pending).rejects.toThrow('no longer attached')
    expect(fake.state.executed.map(call => call.account)).toEqual(['ca_1'])
})

test('a different project key cannot inherit existing project account grants', async () => {
    const fake = composio(), other = 'fixture-composio-key-0002'
    const apps = await service(async (input, init) => {
        const headers = new Headers(init?.headers)
        if (headers.get('x-api-key') === other) headers.set('x-api-key', KEY)
        return fake.network(input, { ...init, headers })
    })
    const account = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
    fake.state.accounts.get('ca_1')!.status = 'ACTIVE'
    await apps.act({ action: 'refresh', id: account.id })
    await apps.act({ action: 'attach', id: account.id, agentId: 'ada', attached: true })
    const previous = (await db.execute('SELECT revision FROM desktop_managed_app_key')).rows[0].revision
    await expect(apps.act({ action: 'set-key', key: other })).rejects.toMatchObject({ status: 409 })
    expect((await db.execute('SELECT revision FROM desktop_managed_app_key')).rows[0].revision).toBe(previous)
    expect(await apps.tools('ada', signal())).toHaveLength(1)
    await apps.act({ action: 'remove-key' })
    expect((await apps.act({ action: 'set-key', key: other })).view).toMatchObject({ configured: true, accounts: [] })
    expect(await apps.tools('ada', signal())).toEqual([])
})

test('a delayed project sign-in link cannot install a row or URL under a replacement key', async () => {
    let release!: () => void, started!: () => void
    const received = new Promise<void>(resolve => { started = resolve })
    const resume = new Promise<void>(resolve => { release = resolve })
    const fake = composio(), apps = await service(async (input, init) => {
        const answer = await fake.network(input, init)
        if (String(input).endsWith('/connected_accounts/link')) {
            started()
            await resume
        }
        return answer
    })
    const pending = apps.act({ action: 'connect', slug: 'gmail' })
    await received
    try { await apps.act({ action: 'set-key', key: KEY }) }
    finally { release() }
    await expect(pending).rejects.toMatchObject({ status: 409 })
    expect((await apps.view()).accounts).toEqual([])
})

test('removing a project key leaves a separately held consumer Connect sign-in intact', async () => {
    const fake = composio(), apps = await service(fake.network)
    await apps.act({ action: 'connect', slug: 'gmail' })
    await db.execute("INSERT INTO desktop_managed_app_accounts(id,slug,toolkit,name,user_id,connected_account_id,status,created_at) VALUES('consumer','slack','slack','Slack','','','active','today')")
    await expect(apps.act({ action: 'attach', id: 'consumer', agentId: 'ada', attached: true })).rejects.toMatchObject({ status: 409 })
    await expect(apps.act({ action: 'remove', id: 'consumer' })).rejects.toMatchObject({ status: 409 })
    await apps.act({ action: 'remove-key' })
    expect((await db.execute('SELECT id FROM desktop_managed_app_accounts')).rows.map(row => row.id)).toEqual(['consumer'])
    expect(fake.state.removed).toEqual(['ca_1'])
})

test('a late project removal cannot delete a reconnected account or its coworker assignment', async () => {
    let release!: () => void, started!: () => void
    const received = new Promise<void>(resolve => { started = resolve })
    const resume = new Promise<void>(resolve => { release = resolve })
    const fake = composio(), apps = await service(async (input, init) => {
        const answer = await fake.network(input, init)
        if (String(input).endsWith('/connected_accounts/ca_1') && init?.method === 'DELETE') {
            started()
            await resume
        }
        return answer
    })
    const row = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
    fake.state.accounts.get('ca_1')!.status = 'ACTIVE'
    await apps.act({ action: 'refresh', id: row.id })
    await apps.act({ action: 'attach', id: row.id, agentId: 'ada', attached: true })
    const pending = apps.act({ action: 'remove', id: row.id })
    await received
    try {
        await db.execute({ sql: "UPDATE desktop_managed_app_accounts SET connected_account_id='ca_replacement' WHERE id=?", args: [row.id] })
    } finally { release() }
    await expect(pending).rejects.toMatchObject({ status: 409 })
    expect((await apps.view()).accounts[0]?.agentIds).toEqual(['ada'])
    expect(fake.state.removed).toEqual(['ca_1'])
})

test.each(['ownership-502', 'delete-502', 'delete-refused'])('Vault keeps a project account and asks before leaving it signed in after %s', async problem => {
    const fake = composio()
    const apps = await service(async (input, init) => {
        if (String(input).endsWith('/connected_accounts/ca_1')) {
            if (problem === 'ownership-502' && init?.method === 'GET') return Response.json({}, { status: 502 })
            if (init?.method === 'DELETE' && problem === 'delete-502') return Response.json({}, { status: 502 })
            if (init?.method === 'DELETE' && problem === 'delete-refused') return Response.json({ success: false })
        }
        return fake.network(input, init)
    })
    const row = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
    await expect(apps.act({ action: 'remove', id: row.id })).rejects.toMatchObject({ status: 502 })
    expect((await apps.view()).accounts.map(entry => entry.id)).toEqual([row.id])
    const held = await apps.act({ action: 'remove-key' })
    expect(held.notSignedOut).toEqual(['Gmail'])
    expect(held.view).toMatchObject({ configured: true, accounts: [{ id: row.id }] })
    const forced = await apps.act({ action: 'remove-key', leaveSignedIn: true })
    expect(forced.view).toMatchObject({ configured: false, accounts: [] })
    expect(fake.state.accounts.has('ca_1')).toBe(true)
})

test('a confirmed 404 between account lookup and removal permits clearing the local row', async () => {
    const fake = composio()
    const apps = await service(async (input, init) => {
        if (String(input).endsWith('/connected_accounts/ca_1') && init?.method === 'DELETE') {
            fake.state.accounts.delete('ca_1')
            return Response.json({}, { status: 404 })
        }
        return fake.network(input, init)
    })
    const row = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
    expect((await apps.act({ action: 'remove', id: row.id })).view.accounts).toEqual([])
})

test('the same Gmail sign-in name and label in two modes preserves both owners across reopen and discovery', async () => {
    await initializeDesktopRound66(db)
    const consumer = connectServer(), project = composio(), identity = await seedConnectCredential(db)
    const open = () => desktopManagedApps(db, crypto, 1, {
        network: project.network, returnUrl: RETURN, coworkerExists: async () => true,
        connect: async () => ({
            ...managedAppsConnectClient('ck_fixture_consumer', consumer.network), identity,
            signedIn: async () => ['gmail'],
        }),
    })
    const apps = open()
    const consumerRow = (await apps.act({ action: 'connect', slug: 'gmail' })).view.accounts[0]!
    expect(consumerRow.status).toBe('active')
    // Upgrade an existing profile with a personal sign-in before adding an independent project account.
    await initializeDesktopRound73(db)
    await initializeDesktopRound73(db)
    expect((await apps.act({ action: 'set-key', key: KEY })).view.accounts).toEqual([])
    const added = await apps.act({ action: 'connect', slug: 'gmail' })
    expect(added.view.accounts).toHaveLength(1)
    const projectRow = added.view.accounts[0]!
    expect(projectRow.id).not.toBe(consumerRow.id)
    project.state.accounts.get('ca_1')!.status = 'ACTIVE'
    await apps.act({ action: 'refresh', id: projectRow.id })
    await apps.act({ action: 'attach', id: projectRow.id, agentId: 'ada', attached: true })
    await expect(apps.act({ action: 'connect', slug: 'gmail' })).rejects.toMatchObject({ status: 409 })

    // Expose each credential independently without exercising the explicit sign-out/removal action.
    // A real SQLite reopen makes sure the assignments and both mode-specific ids are durable.
    db.close()
    db = createClient({ url: `file:${join(dir, 'app.db')}` })
    await db.execute('PRAGMA foreign_keys = ON')
    const reopened = open()
    expect((await reopened.view()).accounts).toMatchObject([{ id: projectRow.id, agentIds: ['ada'] }])
    const storedKey = (await db.execute('SELECT sealed,revision,updated_at FROM desktop_managed_app_key WHERE id=1')).rows[0]!
    await db.execute('DELETE FROM desktop_managed_app_key')
    expect((await reopened.view()).accounts).toMatchObject([{ id: consumerRow.id, agentIds: [] }])
    const found = await reopened.act({ action: 'find' })
    expect(found.view.accounts).toMatchObject([{ id: consumerRow.id, status: 'active' }])
    await expect(reopened.act({ action: 'refresh', id: projectRow.id })).rejects.toMatchObject({ status: 409 })
    await db.execute({ sql: 'INSERT INTO desktop_managed_app_key(id,sealed,revision,updated_at) VALUES(1,?,?,?)', args: [storedKey.sealed, storedKey.revision, storedKey.updated_at] })
    expect((await reopened.view()).accounts).toMatchObject([{ id: projectRow.id, agentIds: ['ada'] }])
    await expect(reopened.act({ action: 'refresh', id: consumerRow.id })).rejects.toMatchObject({ status: 409 })
    expect((await db.execute('SELECT id FROM desktop_managed_app_accounts')).rows.map(row => row.id).sort()).toEqual([consumerRow.id, projectRow.id].sort())
})
