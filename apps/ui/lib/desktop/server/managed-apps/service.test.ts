import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const { createDesktopSecretCrypto } = await import('../secret-requests/crypto')
const { initializeDesktopRound62 } = await import('../round62-schema')
const { desktopManagedApps, managedAppCatalog } = await import('./service')
const { COMPOSIO_API, COMPOSIO_CONNECT, managedAppsConnectAccepts } = await import('./client')

const KEY = 'fixture-composio-key-0001', ACCOUNT_KEY = 'fixture-account-key-0002', ORG_KEY = 'fixture-org-key-0003'
let db: Client, dir: string
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'managed-apps-'))
    db = createClient({ url: `file:${join(dir, 'app.db')}` })
    await db.execute('CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY, id TEXT NOT NULL)')
    await initializeDesktopRound62(db)
    await initializeDesktopRound62(db)
})
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

// A pretend Composio: one project, one key, and what was asked of it.
function composio() {
    const seen: { method: string; path: string; body?: Record<string, unknown> }[] = []
    const state = { status: 'INITIATED', authConfigs: [] as { id: string; toolkit: string }[], executed: [] as unknown[], removed: [] as string[], user: '', toolkit: '' }
    const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input)), path = url.pathname.replace('/api/v3.1', '') + url.search
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        expect(String(input).startsWith(COMPOSIO_API)).toBe(true)
        const sent = new Headers(init?.headers)
        // Composio takes a project key in one header and an account key in another, and never the wrong way round.
        const accepted = sent.get('x-api-key') === KEY || sent.get('x-user-api-key') === ACCOUNT_KEY
        if (sent.get('x-api-key') === ORG_KEY) return Response.json({ error: { message: 'forbidden' } }, { status: 403 })
        if (!accepted) return Response.json({ error: { message: `bad key ${sent.get('x-api-key') ?? sent.get('x-user-api-key')}` } }, { status: 401 })
        seen.push({ method: init?.method ?? 'GET', path, ...(body ? { body } : {}) })
        if (path.startsWith('/auth_configs?limit=1')) return Response.json({ items: [] })
        if (path.startsWith('/toolkits?limit=1')&&!path.includes('limit=1000')) return Response.json({ items: [] })
        if (path.startsWith('/toolkits?')) return Response.json({ items: [
            { slug: 'GMAIL', name: 'Gmail', composio_managed_auth_schemes: ['OAUTH2'], meta: { description: 'Read and send   email' } },
            { slug: 'slack', name: 'Slack', composio_managed_auth_schemes: ['OAUTH2'], meta: { description: 'Team chat', logo: 'https://logos.composio.example/slack.png' } },
            { slug: 'hackernews', name: 'Hacker News', no_auth: true, meta: { description: 'Read stories' } },
            { slug: 'acme_erp', name: 'Acme ERP', auth_schemes: ['API_KEY'], meta: { description: 'Needs your own credentials' } },
            { slug: 'Bad Slug!', name: 'Ignored' },
        ], next_cursor: null })
        if (path.startsWith('/auth_configs?toolkit_slug=')) return Response.json({ items: state.authConfigs.filter(row => row.toolkit === url.searchParams.get('toolkit_slug')).map(row => ({ id: row.id, status: 'ENABLED', is_composio_managed: true, toolkit: { slug: row.toolkit } })) })
        if (path === '/auth_configs' && body.toolkit.slug === 'acme_erp') return Response.json({ error: { message: 'no managed auth' } }, { status: 400 })
        if (path === '/auth_configs') { const made = { id: `ac_${state.authConfigs.length + 1}`, toolkit: body.toolkit.slug }; state.authConfigs.push(made); return Response.json({ toolkit: { slug: made.toolkit }, auth_config: { id: made.id } }, { status: 201 }) }
        if (path === '/connected_accounts/link') { state.user = body.user_id; state.toolkit = state.authConfigs.find(row => row.id === body.auth_config_id)?.toolkit ?? ''; return Response.json({ connected_account_id: 'ca_1', redirect_url: 'https://connect.composio.example/link/ca_1' }) }
        if (path === '/connected_accounts/ca_1' && init?.method === 'DELETE') { state.removed.push('ca_1'); return Response.json({ success: true }) }
        if (path === '/connected_accounts/ca_1') return Response.json({ id: 'ca_1', user_id: state.user, status: state.status, toolkit: { slug: state.toolkit } })
        if (path.startsWith('/tools?') && url.searchParams.get('toolkit_slug') === 'slack') return Response.json({ items: Array.from({ length: url.searchParams.get('important') === 'true' ? 55 : 300 }, (_unused, index) => (
            { slug: `SLACK_TOOL_${index}`, description: 'A Slack tool', input_parameters: { type: 'object', properties: {} } })), next_cursor: null })
        if (path.startsWith('/tools?') && url.searchParams.get('toolkit_slug') === 'hackernews') return Response.json({ items: url.searchParams.get('important') === 'true' ? [] : [
            { slug: 'HACKERNEWS_GET_FRONTPAGE', description: 'Front page', input_parameters: { type: 'object', properties: {} } }], next_cursor: null })
        if (path === '/tools/execute/HACKERNEWS_GET_FRONTPAGE') return Response.json({ successful: true, data: { stories: 3 } })
        if (path.startsWith('/tools?')) return Response.json({ items: [
            { slug: 'GMAIL_SEND_EMAIL', description: 'Send an email', input_parameters: { type: 'object', properties: { to: { type: 'string' } } } },
            { slug: 'GMAIL_FETCH_EMAILS', description: 'Read mail', input_parameters: { type: 'object', properties: {} } },
            { slug: 'GMAIL_DELETE_MESSAGE', description: 'Not offered by the catalog', input_parameters: { type: 'object', properties: {} }, tags: ['destructiveHint'] },
        ], next_cursor: null })
        if (path === '/tools/execute/GMAIL_SEND_EMAIL') { state.executed.push(body); return Response.json({ successful: true, data: { id: 'msg_1' } }) }
        if (path === '/tools/execute/GMAIL_FETCH_EMAILS') return Response.json({ successful: false, error: 'quota' })
        return Response.json({}, { status: 404 })
    }) as typeof fetch
    return { network, seen, state }
}
function apps(network: typeof fetch) {
    const crypto = createDesktopSecretCrypto(() => Buffer.alloc(32, 7))
    return desktopManagedApps(db, crypto, 1, { network, returnUrl: 'http://127.0.0.1:4000/api/desktop/managed-apps/return', coworkerExists: async id => id === 'coworker-1' })
}

test('the catalog offers the managed apps, Gmail among them', () => {
    expect(managedAppCatalog.map(app => app.slug)).toEqual(expect.arrayContaining(['gmail', 'outlook', 'googlecalendar', 'linkedin'].filter(slug => managedAppCatalog.some(app => app.slug === slug))))
    const gmail = managedAppCatalog.find(app => app.slug === 'gmail')!
    expect(gmail).toMatchObject({ name: 'Gmail', toolkit: 'gmail' })
    expect(gmail.allowedTools).toContain('GMAIL_SEND_EMAIL')
    expect(managedAppCatalog.length).toBeGreaterThanOrEqual(20)
})

test('a key is tried before it is kept, is sealed at rest, and never comes back out', async () => {
    const fake = composio(), service = apps(fake.network)
    expect((await service.view()).configured).toBe(false)
    await expect(service.act({ action: 'set-key', key: 'wrong-key-000000' })).rejects.toThrow('Composio did not recognize this key.')
    expect((await service.view()).configured).toBe(false)
    await expect(service.act({ action: 'connect', slug: 'gmail' })).rejects.toThrow('Add your Composio key first.')

    const saved = await service.act({ action: 'set-key', key: KEY })
    expect(saved.view.configured).toBe(true)
    expect(JSON.stringify(saved)).not.toContain(KEY)
    const row = (await db.execute('SELECT sealed FROM desktop_managed_app_key')).rows[0]!
    expect(String(row.sealed)).not.toContain(KEY)
    expect(Buffer.from(String(row.sealed), 'base64').toString('latin1')).not.toContain(KEY)
})

test('connect, sign in, attach to a coworker, call, detach and remove', async () => {
    const fake = composio(), service = apps(fake.network), signal = new AbortController().signal
    await service.act({ action: 'set-key', key: KEY })
    const connected = await service.act({ action: 'connect', slug: 'gmail' })
    expect(connected.signIn).toBe('https://connect.composio.example/link/ca_1')
    const [account] = connected.view.accounts
    expect(account).toMatchObject({ slug: 'gmail', name: 'Gmail', status: 'pending', agentIds: [] })
    expect(fake.seen.find(call => call.path === '/auth_configs')!.body).toEqual({ toolkit: { slug: 'gmail' }, auth_config: { type: 'use_composio_managed_auth', credentials: {} } })
    expect(fake.seen.find(call => call.path === '/connected_accounts/link')!.body).toMatchObject({ auth_config_id: 'ac_1', callback_url: 'http://127.0.0.1:4000/api/desktop/managed-apps/return' })
    await expect(service.act({ action: 'connect', slug: 'gmail' })).rejects.toThrow('already has an account')

    // Not signed in yet: it cannot be attached and offers no tools.
    await expect(service.act({ action: 'attach', id: account!.id, agentId: 'coworker-1', attached: true })).rejects.toThrow('Finish signing in')
    expect((await service.act({ action: 'refresh', id: account!.id })).view.accounts[0]!.status).toBe('pending')
    fake.state.status = 'ACTIVE'
    expect((await service.act({ action: 'refresh', id: account!.id })).view.accounts[0]!.status).toBe('active')
    await expect(service.act({ action: 'attach', id: account!.id, agentId: 'someone-else', attached: true })).rejects.toThrow('no longer available')
    expect((await service.act({ action: 'attach', id: account!.id, agentId: 'coworker-1', attached: true })).view.accounts[0]!.agentIds).toEqual(['coworker-1'])

    // Only the coworker that holds the account gets its tools, and only the ones the catalog allows.
    expect(await service.tools('coworker-2', signal)).toEqual([])
    const tools = await service.tools('coworker-1', signal)
    expect(tools.map(tool => tool.name)).toEqual(['GMAIL_SEND_EMAIL', 'GMAIL_FETCH_EMAILS'])
    const sent = await tools[0]!.execute({ to: 'pat@example.test' }, signal, 'call-1')
    expect(sent).toEqual({ source: 'remote_mcp', untrusted: true, result: { content: [{ type: 'text', text: '{"id":"msg_1"}' }] } })
    expect(fake.state.executed).toEqual([{ user_id: fake.state.user, arguments: { to: 'pat@example.test' } }])
    expect(fake.state.user).toMatch(/^rerun_mac_[0-9a-f-]{36}$/)
    expect((await tools[1]!.execute({}, signal, 'call-2')).result).toEqual({ content: [{ type: 'text', text: '{"error":"quota"}' }], isError: true })
    expect(fake.seen.filter(call => call.path.startsWith('/tools?')).length).toBe(1)

    // Detached: the tool a run still holds stops at the call.
    await service.act({ action: 'attach', id: account!.id, agentId: 'coworker-1', attached: false })
    await expect(tools[0]!.execute({ to: 'pat@example.test' }, signal, 'call-3')).rejects.toThrow('no longer attached')
    expect(fake.state.executed).toHaveLength(1)
    expect(await service.tools('coworker-1', signal)).toEqual([])

    expect((await service.act({ action: 'remove', id: account!.id })).view.accounts).toEqual([])
    expect(fake.state.removed).toEqual(['ca_1'])
})

test('removing the key removes the accounts that belonged to it', async () => {
    const fake = composio(), service = apps(fake.network)
    await service.act({ action: 'set-key', key: KEY })
    const { view } = await service.act({ action: 'connect', slug: 'gmail' })
    fake.state.status = 'ACTIVE'
    await service.act({ action: 'refresh', id: view.accounts[0]!.id })
    await service.act({ action: 'attach', id: view.accounts[0]!.id, agentId: 'coworker-1', attached: true })
    const cleared = await service.act({ action: 'remove-key' })
    expect(cleared.view).toMatchObject({ configured: false, accounts: [] })
    expect(fake.state.removed).toEqual(['ca_1'])
    expect(await service.tools('coworker-1', new AbortController().signal)).toEqual([])
    expect((await db.execute('SELECT COUNT(*) AS n FROM desktop_managed_app_attachments')).rows[0]!.n).toBe(0)
})

test('an account signed in by someone else, or to another app, is never marked usable', async () => {
    const fake = composio(), service = apps(fake.network)
    await service.act({ action: 'set-key', key: KEY })
    const { view } = await service.act({ action: 'connect', slug: 'gmail' })
    fake.state.status = 'ACTIVE'; fake.state.user = 'somebody_else'
    expect((await service.act({ action: 'refresh', id: view.accounts[0]!.id })).view.accounts[0]!.status).toBe('pending')
})

test('with a key the Vault offers every app of the project, and any of them can be connected', async () => {
    const fake = composio(), service = apps(fake.network), signal = new AbortController().signal
    // Before a key: the apps the bundled catalog names, under the names Composio knows them by.
    const before = (await service.view()).apps.map(app => app.slug)
    expect(before).toEqual(expect.arrayContaining(['gmail', 'googlecalendar', 'outlook']))
    expect(before).not.toContain('slack')

    const { view } = await service.act({ action: 'set-key', key: KEY })
    expect(view.apps).toEqual([
        { slug: 'gmail', name: 'Gmail', summary: 'Read and send email', logo: '/services/gmail.svg' },
        { slug: 'slack', name: 'Slack', summary: 'Team chat', logo: '/services/slack.png' },
        { slug: 'hackernews', name: 'Hacker News', summary: 'Read stories' },
        { slug: 'acme_erp', name: 'Acme ERP', summary: 'Needs your own credentials' },
    ])
    await service.view()
    expect(fake.seen.filter(call => call.path.startsWith('/toolkits?') && call.path.includes('limit=1000')).length).toBe(1)
    await expect(service.act({ action: 'connect', slug: 'not-offered' })).rejects.toThrow('not in the catalog')

    // An app the bundled catalog does not know: the tools Composio features, and no more than the limit.
    const slack = (await service.act({ action: 'connect', slug: 'slack' })).view.accounts.find(row => row.slug === 'slack')!
    fake.state.status = 'ACTIVE'
    fake.state.user = (fake.seen.findLast(call => call.path === '/connected_accounts/link')!.body as { user_id: string }).user_id
    await service.act({ action: 'refresh', id: slack.id })
    await service.act({ action: 'attach', id: slack.id, agentId: 'coworker-1', attached: true })
    const slackTools = await service.tools('coworker-1', signal)
    expect(slackTools).toHaveLength(40)
    expect(fake.seen.findLast(call => call.path.startsWith('/tools?'))!.path).toContain('important=true')

    // An app that needs no sign-in is ready at once, and falls back to its full list when nothing is featured.
    const news = await service.act({ action: 'connect', slug: 'hackernews' })
    expect(news.signIn).toBeUndefined()
    const account = news.view.accounts.find(row => row.slug === 'hackernews')!
    expect(account.status).toBe('active')
    await service.act({ action: 'attach', id: account.id, agentId: 'coworker-1', attached: true })
    const all = await service.tools('coworker-1', signal)
    const frontpage = all.find(tool => tool.name === 'HACKERNEWS_GET_FRONTPAGE')!
    expect((await frontpage.execute({}, signal, 'call-9')).result).toEqual({ content: [{ type: 'text', text: '{"stories":3}' }] })
    expect((await service.act({ action: 'remove', id: account.id })).view.accounts.map(row => row.slug)).toEqual(['slack'])

    // An app Composio has no ready-made sign-in for says what to do instead of failing blankly.
    await expect(service.act({ action: 'connect', slug: 'acme_erp' })).rejects.toThrow('Set one up for it in your Composio dashboard')
    expect((await service.view()).accounts.map(row => row.slug)).toEqual(['slack'])
})

test('an account key is accepted the way Composio takes it, and an organization key says why it is not', async () => {
    const fake = composio(), service = apps(fake.network)
    await expect(service.act({ action: 'set-key', key: ORG_KEY })).rejects.toThrow('recognized this key but it is not allowed')
    expect((await service.view()).configured).toBe(false)

    expect((await service.act({ action: 'set-key', key: ACCOUNT_KEY })).view.configured).toBe(true)
    // Every later call travels the same way the key was accepted.
    expect((await service.view()).apps.map(app => app.slug)).toContain('slack')
    const row = (await db.execute('SELECT sealed FROM desktop_managed_app_key')).rows[0]!
    expect(Buffer.from(String(row.sealed), 'base64').toString('latin1')).not.toContain(ACCOUNT_KEY)
})

test('a Connect key is recognized by the handshake alone, in its own header', async () => {
    const seen: { url: string; header: string | null; body: { method: string } }[] = []
    const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const header = new Headers(init?.headers).get('x-consumer-api-key')
        seen.push({ url: String(input), header, body: JSON.parse(String(init?.body)) })
        return header === 'ck_fixture_good' ? Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }) : Response.json({ error: 'Authorization required' }, { status: 401 })
    }) as typeof fetch
    expect(await managedAppsConnectAccepts('ck_fixture_good', network)).toBe(true)
    expect(await managedAppsConnectAccepts('ak_fixture_other', network)).toBe(false)
    expect(seen.map(call => [call.url, call.body.method])).toEqual([[COMPOSIO_CONNECT, 'initialize'], [COMPOSIO_CONNECT, 'initialize']])
    await expect(managedAppsConnectAccepts('ck_fixture_good', (async () => { throw new Error('offline') }) as typeof fetch)).rejects.toThrow('could not be reached')
})
