import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import type { DesktopDataScope } from '@/lib/desktop/data-scope'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { handleDesktopData } from '@/lib/desktop/server/coworker-data'

type Call = { method: string; path: string; body: unknown }

let root: string
let server: Server
let runtime: DesktopRuntime
let coworker: string
let other: string
let calls: Call[]

const TABLES = {
    'engine-a': { tables: [{ name: 'notes', columns: [{ name: 'body', type: 'TEXT', pk: false, notnull: false }] }] },
    'engine-b': { tables: [{ name: 'leads', columns: [{ name: 'email', type: 'TEXT', pk: false, notnull: false }] }] },
}

const shared: DesktopDataScope = { kind: 'shared' }
const agent = (): DesktopDataScope => ({ kind: 'agent', agentId: coworker })

function request(url: string, method = 'GET', body?: unknown): Request {
    return new Request(`http://127.0.0.1:3189${url}`, {
        method,
        ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    })
}

const send = (res: import('node:http').ServerResponse, status: number, body: unknown, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type }).end(type === 'application/json' ? JSON.stringify(body) : String(body))
}

async function errorOf(promise: Promise<unknown>): Promise<DesktopHttpError> {
    try { await promise } catch (error) {
        if (error instanceof DesktopHttpError) return error
        throw error
    }
    throw new Error('Expected the adapter to reject')
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-data-'))
    calls = []
    server = createServer(async (req, res) => {
        let text = ''
        for await (const chunk of req) text += chunk
        const url = req.url ?? '/'
        const body = text ? JSON.parse(text) : undefined
        calls.push({ method: req.method ?? 'GET', path: url, body })
        const path = url.split('?')[0]!

        const agentId = /^\/agents\/([^/]+)\/data/.exec(path)?.[1]
        if (agentId && path.endsWith('/tables')) return send(res, 200, TABLES[agentId as keyof typeof TABLES] ?? { tables: [] })
        if (path === '/shared/data/tables') return send(res, 200, { tables: [{ name: 'catalog', columns: [] }] })
        if (path.includes('/tables/missing')) return send(res, 500, { error: 'no such table: missing' })
        if (path.endsWith('/rows') && req.method === 'GET') return send(res, 200, { columns: ['body'], rows: [{ body: 'one' }], total: 1 })
        if (path.endsWith('/rows') && req.method === 'DELETE') return send(res, 200, { deleted: 2 })
        if (/\/rows\/[^/]+$/.test(path) && req.method === 'PATCH') return send(res, 200, { row: { body: 'changed' } })
        if (path.endsWith('/purge')) return send(res, 200, { deleted: 3 })
        if (path.endsWith('/views')) return send(res, 200, { views: [] })
        if (path.endsWith('/export')) return send(res, 200, 'body\none', 'text/csv')
        if (path.endsWith('/tables/notes') && req.method === 'DELETE') { res.writeHead(204).end(); return }
        send(res, 404, { error: 'not found' })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test engine address')

    const db = await openDesktopDatabase(root)
    coworker = (await createDesktopAgent(db, { engineAgentId: 'engine-a', name: 'Alpha' })).id
    other = (await createDesktopAgent(db, { engineAgentId: 'engine-b', name: 'Bravo' })).id
    runtime = {
        protocolVersion: 1, launchNonce: 'data', buildId: 'data-test', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3189', sessionToken: 'r'.repeat(48) },
        engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-engine' },
    }
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
})

test('a coworker browser always addresses that coworker’s engine agent, never an id from the URL', async () => {
    const listed = await handleDesktopData(runtime, request('/api/desktop/agents/x/data'), agent(), [])
    expect(await listed.json()).toEqual(TABLES['engine-a'])
    expect(calls.map(call => call.path)).toContain('/agents/engine-a/data/tables')
    expect(calls.some(call => call.path.includes(encodeURIComponent(coworker)))).toBe(false)

    expect(await (await handleDesktopData(runtime, request('/api/desktop/agents/y/data'), { kind: 'agent', agentId: other }, [])).json()).toEqual(TABLES['engine-b'])
    expect(calls.map(call => call.path)).toContain('/agents/engine-b/data/tables')

    const missing = await errorOf(handleDesktopData(runtime, request('/api/desktop/agents/nope/data'), { kind: 'agent', agentId: 'nope' }, []))
    expect(missing.status).toBe(404)
    expect(missing.message).toBe('Coworker not found')
})

test('the shared browser always addresses /shared/data and can never name an agent', async () => {
    const listed = await handleDesktopData(runtime, request('/api/desktop/shared-data'), shared, [])
    expect(await listed.json()).toEqual({ tables: [{ name: 'catalog', columns: [] }] })
    expect(calls.map(call => call.path)).toEqual(['/shared/data/tables'])
})

test('refuses the internal bookkeeping tables before the engine is asked', async () => {
    for (const name of ['_rerun_views', '_rerun_shared_tables', 'sqlite_master', 'SQLITE_SCHEMA']) {
        const error = await errorOf(handleDesktopData(runtime, request(`/api/desktop/agents/x/data/tables/${name}/rows?limit=10`), agent(), ['tables', name, 'rows']))
        expect(error.status).toBe(404)
        expect(error.message).toBe('Table not found.')
    }
    expect(calls).toEqual([])
})

test('clamps the page, the filters and the terms the browser may ask for', async () => {
    const response = await handleDesktopData(runtime, request('/api/desktop/agents/x/data/tables/notes/rows?limit=10000&offset=-4&q=one'), agent(), ['tables', 'notes', 'rows'])
    expect(response.status).toBe(200)
    const rows = calls.find(call => call.path.includes('/tables/notes/rows'))
    expect(rows?.path).toContain('limit=200')
    expect(rows?.path).toContain('offset=0')
    expect(rows?.path).toContain('q=one')

    const filters = Array.from({ length: 9 }, (_, index) => ({ column: `c${index}`, equals: index }))
    const tooMany = await errorOf(handleDesktopData(
        runtime,
        request(`/api/desktop/agents/x/data/tables/notes/rows?where=${encodeURIComponent(JSON.stringify(filters))}`),
        agent(), ['tables', 'notes', 'rows'],
    ))
    expect(tooMany.status).toBe(400)
    expect(tooMany.message).toBe('That table filter is not valid.')

    const long = await errorOf(handleDesktopData(runtime, request(`/api/desktop/agents/x/data/tables/notes/rows?q=${'x'.repeat(201)}`), agent(), ['tables', 'notes', 'rows']))
    expect(long.status).toBe(400)
    expect(long.message).toBe('That search is too long.')
})

test('reports a missing table as a 404 after checking the listing once', async () => {
    const error = await errorOf(handleDesktopData(runtime, request('/api/desktop/agents/x/data/tables/missing/rows'), agent(), ['tables', 'missing', 'rows']))
    expect(error.status).toBe(404)
    expect(error.message).toBe('Table not found.')
    expect(calls.filter(call => call.path.endsWith('/tables')).length).toBe(1)
})

test('dispatches row, table and view writes only on their explicit routes', async () => {
    const updated = await handleDesktopData(runtime, request('/api/desktop/agents/x/data/tables/notes/rows/5', 'PATCH', { values: { body: 'changed' } }), agent(), ['tables', 'notes', 'rows', '5'])
    expect(await updated.json()).toEqual({ row: { body: 'changed' } })
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', path: '/agents/engine-a/data/tables/notes/rows/5', body: { values: { body: 'changed' } } })

    const deleted = await handleDesktopData(runtime, request('/api/desktop/agents/x/data/tables/notes/rows', 'DELETE', { rowids: [1, 2] }), agent(), ['tables', 'notes', 'rows'])
    expect(await deleted.json()).toEqual({ deleted: 2 })

    const purged = await handleDesktopData(runtime, request('/api/desktop/agents/x/data/tables/notes/purge', 'POST'), agent(), ['tables', 'notes', 'purge'])
    expect(await purged.json()).toEqual({ deleted: 3 })

    const dropped = await handleDesktopData(runtime, request('/api/desktop/agents/x/data/tables/notes', 'DELETE'), agent(), ['tables', 'notes'])
    expect(dropped.status).toBe(204)

    const views = await handleDesktopData(runtime, request('/api/desktop/shared-data/tables/notes/views'), shared, ['tables', 'notes', 'views'])
    expect(await views.json()).toEqual({ views: [] })
    expect(calls.at(-1)?.path).toBe('/shared/data/tables/notes/views')

    const sql = await errorOf(handleDesktopData(runtime, request('/api/desktop/agents/x/data/sql', 'POST', { sql: 'SELECT 1' }), agent(), ['sql']))
    expect(sql.status).toBe(404)
    expect(calls.some(call => call.path.endsWith('/query') || call.path.endsWith('/execute'))).toBe(false)
})

test('streams an export with a safe content type and no caching', async () => {
    const response = await handleDesktopData(runtime, request('/api/desktop/shared-data/export?table=notes&format=csv'), shared, ['export'])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/csv')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe('body\none')
    expect(calls.at(-1)?.path).toBe('/shared/data/tables/notes/export?format=csv')
})

test('reports malformed saved-view input as a client error', async () => {
    const error = await errorOf(handleDesktopData(runtime, request('/api/desktop/shared-data/tables/notes/views', 'POST', { name: '' }), shared, ['tables', 'notes', 'views']))
    expect(error.status).toBe(400)
    expect(calls).toEqual([])
})
