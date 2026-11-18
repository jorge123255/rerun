import { connectToolList } from './connect-test-fixture'
import { connectionCapabilities } from './connect-capabilities'
import { expect, test, vi } from 'vitest'
import { managedAppsConnectAccepts, managedAppsConnectClient, managedConnectionOf } from './client'

const protocolVersion = '2025-03-26'
const connection = { results: { gmail: { toolkit: 'gmail', status: 'initiated', redirect_url: 'https://connect.composio.dev/link/lk_fixture' } } }

test.each([
    { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'not authorized' } },
    { jsonrpc: '2.0', id: 7, result: { protocolVersion } },
    { jsonrpc: '2.0', id: 1, result: { protocolVersion: 'unknown' } },
])('a 200 response without a usable initialize result does not validate a Vault key', async body => {
    await expect(managedAppsConnectAccepts('ck_fixture', async () => Response.json(body))).rejects.toThrow()
})

test('opens the sign-in link from a matching stream reply even while the server keeps the stream open', async () => {
    const calls: string[] = []
    const cancel = vi.fn()
    let expire: ReturnType<typeof setTimeout> | undefined
    const network: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        calls.push(body.method)
        if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion } }, { headers: { 'mcp-session-id': 'qa-session' } })
        if (body.method === 'tools/list') return connectToolList(body.id)
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        const result = { content: [{ type: 'text', text: JSON.stringify({ successful: true, data: connection }) }] }
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const chunk = new TextEncoder()
                controller.enqueue(chunk.encode('event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\n'))
                controller.enqueue(chunk.encode(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\r\n`))
                controller.enqueue(chunk.encode('\r\n'))
                expire = setTimeout(() => controller.error(Error('The response reader waited for the stream to end.')), 300)
            },
            cancel,
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }
    try {
        await expect(managedAppsConnectClient('ck_fixture', network).connect('gmail')).resolves.toEqual({
            state: 'pending', accountIds: [], signIn: 'https://connect.composio.dev/link/lk_fixture',
        })
        expect(calls).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
        expect(cancel).toHaveBeenCalledOnce()
    } finally { clearTimeout(expire) }
})

test.each(['2025-03-26', '2025-06-18', '2025-11-25'])('uses the negotiated MCP headers (%s) and recognizes a structured connection reply', async protocolVersion => {
    const network: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion } }, { headers: { 'mcp-session-id': 'qa-session' } })
        expect(new Headers(init?.headers).get('mcp-protocol-version')).toBe(protocolVersion)
        expect(new Headers(init?.headers).get('mcp-session-id')).toBe('qa-session')
        if (body.method === 'tools/list') return connectToolList(body.id)
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { successful: true, data: connection }, content: [] } })
    }
    expect((await managedAppsConnectClient('ck_fixture', network).connect('gmail')).signIn).toEqual(connection.results.gmail.redirect_url)
})

test('a slug-only Connect link starts once and exact status reads never create or revoke a connection', async () => {
    const calls: { name: string; arguments: Record<string, unknown> }[] = []
    let signedIn = false, toolkit = 'gmail', lists = 0
    const network: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion } })
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        if (body.method === 'tools/list') { lists++; return connectToolList(body.id, 'slugs') }
        calls.push(body.params)
        const data = body.params.name === 'COMPOSIO_SEARCH_TOOLS'
            ? { toolkit_connection_statuses: [{ toolkit, has_active_connection: signedIn }] }
            : connection
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { successful: true, data } } })
    }
    const client = managedAppsConnectClient('ck_fixture', network)
    expect(await client.connect('gmail')).toMatchObject({ state: 'pending', signIn: connection.results.gmail.redirect_url })
    expect(calls[0]).toEqual({ name: 'COMPOSIO_MANAGE_CONNECTIONS', arguments: { toolkits: ['gmail'] } })
    expect(await client.status('gmail')).toEqual({ state: 'pending', accountIds: [] })
    signedIn = true
    expect(await client.status('gmail')).toEqual({ state: 'active', accountIds: [] })
    await expect(client.remove('gmail')).rejects.toMatchObject({ status: 409 })
    toolkit = 'outlook'
    await expect(client.status('gmail')).rejects.toThrow('did not confirm')
    await expect(client.signedIn(['gmail', 'outlook'])).rejects.toThrow('bulk')
    expect(calls.slice(1).every(call => call.name === 'COMPOSIO_SEARCH_TOOLS')).toBe(true)
    expect(lists).toBe(1)
})

test('an unfamiliar management schema never sends a speculative login request', async () => {
    const called: string[] = []
    const network: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)); called.push(body.method)
        if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion } })
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'COMPOSIO_MANAGE_CONNECTIONS', inputSchema: { type: 'object' } }] } })
    }
    const client = managedAppsConnectClient('ck_fixture', network)
    await expect(client.connect('gmail')).rejects.toMatchObject({ status: 409 })
    await expect(client.status('gmail')).rejects.toMatchObject({ status: 409 })
    await expect(client.signedIn(['gmail'])).rejects.toMatchObject({ status: 409 })
    expect(called).not.toContain('tools/call')
})

test('opens only the sign-in redirect of the requested toolkit, even if other URLs occur first', () => {
    const signIn = 'https://connect.composio.dev/link/lk_fixture'
    const row = { toolkit: 'gmail', status: 'initiated', help_url: 'https://docs.composio.dev', redirect_url: signIn }
    expect(managedConnectionOf({ results: { gmail: row } }, 'gmail').signIn).toBe(signIn)
    expect(managedConnectionOf({ results: { gmail: { ...row, redirect_url: undefined } } }, 'gmail').signIn).toBeUndefined()
    expect(() => managedConnectionOf({ results: { gmail: { ...row, toolkit: 'slack' } } }, 'gmail')).toThrow()
})

test.each([
    { renewal: { type: 'boolean', default: false }, advertised: true },
    { renewal: { type: 'boolean', const: false }, advertised: false },
    { renewal: undefined, advertised: false },
])('renews only the requested slug on an explicit request and a supported flag ($advertised)', async ({ renewal, advertised }) => {
    const calls: { name: string; arguments: Record<string, unknown> }[] = []
    const network: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion } })
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        if (body.method === 'tools/list') {
            const listing = await connectToolList(body.id, 'slugs').json()
            listing.result.tools[0].inputSchema.properties.reinitiate_all = renewal
            return Response.json(listing)
        }
        calls.push(body.params)
        const data = body.params.name === 'COMPOSIO_SEARCH_TOOLS' ? { toolkit_connection_statuses: [{ toolkit: 'gmail', has_active_connection: false }] } : connection
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { successful: true, data } } })
    }
    const client = managedAppsConnectClient('fixture', network)
    await client.connect('gmail')
    await client.status('gmail')
    expect(calls.map(c => c.name)).toEqual(['COMPOSIO_MANAGE_CONNECTIONS', 'COMPOSIO_SEARCH_TOOLS'])
    expect(calls[0]!.arguments).toEqual({ toolkits: ['gmail'] })
    const reopen = client.connect('gmail', undefined, 'renew')
    if (advertised) {
        await expect(reopen).resolves.toMatchObject({ state: 'pending' })
        expect(calls.at(-1)!.arguments).toEqual({ toolkits: ['gmail'], reinitiate_all: true })
    } else {
        await expect(reopen).rejects.toMatchObject({ status: 409 })
        expect(calls).toHaveLength(2)
    }
})

test.each([
    { action: { type: 'string', const: 'add' } },
    { action: { $ref: '#/$defs/AddOnly' } },
    { action: { type: 'string', pattern: '^add$' } },
    { action: { type: 'string', enum: ['add', 'list'], not: { const: 'list' } } },
])('does not use a restricted action schema for passive listing', async ({ action }) => {
    const methods: string[] = []
    const network: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        methods.push(body.method)
        if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion } })
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        const listing = await connectToolList(body.id).json()
        const schema = listing.result.tools[0].inputSchema
        schema.$defs.ToolkitAction.properties.action = action
        schema.$defs.AddOnly = { const: 'add' }
        listing.result.tools.length = 1
        return Response.json(listing)
    }
    const client = managedAppsConnectClient('fixture', network)
    await expect(client.status('gmail')).rejects.toMatchObject({ status: 409 })
    await expect(client.signedIn(['gmail'])).rejects.toMatchObject({ status: 409 })
    expect(methods).not.toContain('tools/call')
})


test('recognizes the documented legacy actions only for an unrestricted, named toolkit object', () => {
    const name = { type: 'string' }
    const bare = { type: 'string', title: 'Action', description: 'Further details supplied by the gateway' }
    function actions(item: unknown) {
        return [...connectionCapabilities({ properties: { toolkits: { type: 'array', items: item } } }).actions]
    }
    const item = (action: unknown) => ({ type: 'object', properties: { name, action } })
    expect(actions(item(bare))).toEqual(['add', 'list', 'remove'])
    expect(actions(item({ ...bare, enum: ['list'] }))).toEqual(['list'])
    expect(actions(item({ ...bare, pattern: '^list$' }))).toEqual([])
    expect(actions(item({ oneOf: [bare, { const: 'list' }] }))).toEqual(['add', 'remove'])
    expect(actions(item({ oneOf: [bare, { type: 'string', pattern: '^list$' }] }))).toEqual([])
    expect(actions(item({ description: 'add, list, remove' }))).toEqual([])
    expect(actions({ type: 'object', properties: { name: {}, action: bare } })).toEqual([])
    expect(actions({ ...item(bare), not: { properties: { action: { const: 'list' } } } })).toEqual([])
})
