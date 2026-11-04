import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopBoardStateSchema } from '@/lib/desktop/spaces'
import { GET, POST } from './route'

const env = { ...process.env }
const origin = 'http://127.0.0.1:3191', token = 'b'.repeat(48)
const headers = { host: '127.0.0.1:3191', origin, cookie: `rerun-desktop-session=${token}`, 'content-type': 'application/json' }
let root: string
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-boxes-route-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'boxes-launch', buildId: 'boxes-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:3192', apiKey: 'unused' } }), { mode: 0o600 })
})
afterEach(async () => { await closeDesktopDatabase(root); process.env = { ...env }; await rm(root, { recursive: true, force: true }) })
const get = (override: Record<string, string> = {}) => GET(new Request(origin + '/api/desktop/spaces', { headers: { ...headers, ...override } }))
const post = (body: unknown, override: Record<string, string> = {}) => POST(new Request(origin + '/api/desktop/spaces', { method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify(body) }))
const create = () => ({ requestId: crypto.randomUUID(), expectedRevision: 0, command: { kind: 'create', name: 'Research' } })

it('uses desktop authentication and origin protection before accepting a Box change', async () => {
    expect((await get({ cookie: '' })).status).toBe(401)
    expect((await get({ host: 'outside.test' })).status).toBe(403)
    expect((await post(create(), { origin: 'https://outside.test' })).status).toBe(403)
    expect((await post(create(), { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(desktopBoardStateSchema.parse((await response.json()).board).revision).toBe(0)
})

it('returns a durable board and authoritative receipt replay with no engine connection', async () => {
    const body = create()
    const created = await post(body)
    expect(created.status).toBe(200)
    expect(created.headers.get('cache-control')).toBe('no-store')
    const first = desktopBoardStateSchema.parse((await created.json()).board)
    expect(first.spaces).toHaveLength(2)
    const renamed = await post({ requestId: crypto.randomUUID(), expectedRevision: first.revision, command: { kind: 'rename', spaceId: first.spaces[1]!.id, name: 'Later name' } })
    expect(renamed.status).toBe(200)
    const latest = await renamed.json()
    await closeDesktopDatabase(root)
    expect(await (await post(body)).json()).toEqual(latest)
    expect((await post(create())).status).toBe(409)
    expect((await post({ ...body, command: { kind: 'create', name: 'Reused UUID' } })).status).toBe(409)
    expect(await (await get()).json()).toEqual(latest)
})

it('rejects malformed, oversized, unbounded-coordinate, and unknown-field payloads without writing', async () => {
    expect((await post(create(), { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await post({ ...create(), surprise: true })).status).toBe(400)
    expect((await post({ ...create(), expectedRevision: -1 })).status).toBe(400)
    expect((await post({ ...create(), command: { kind: 'create', name: 'Research', side: 'top-right' } })).status).toBe(400)
    expect((await post({ ...create(), command: { kind: 'create', name: 'x'.repeat(61) } })).status).toBe(400)
    const existing = (await (await get()).json()).board.spaces[0]
    expect((await post({ ...create(), command: { kind: 'resize-space', spaceId: existing.id, rect: { col_start: 0, row_start: 0, col_end: 1_000_001, row_end: 7 } } })).status).toBe(400)
    expect((await POST(new Request(origin + '/api/desktop/spaces', { method: 'POST', headers, body: '{broken' }))).status).toBe(400)
    expect((await post({ ...create(), junk: 'x'.repeat(5000) })).status).toBe(413)
    expect((await post(create(), { 'content-length': '5000' })).status).toBe(413)
    const streamed = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2048).fill(32)); controller.enqueue(new Uint8Array(2049).fill(32)); controller.close() } })
    expect((await POST(new Request(origin + '/api/desktop/spaces', { method: 'POST', headers, body: streamed, duplex: 'half' } as RequestInit))).status).toBe(413)
    expect((await (await get()).json()).board.revision).toBe(0)
    expect((await (await openDesktopDatabase(root)).execute('SELECT * FROM desktop_space_writes')).rows).toEqual([])
})
