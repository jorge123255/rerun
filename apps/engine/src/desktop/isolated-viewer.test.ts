import { createServer as httpServer } from 'node:http'
import { connect as tcpConnect, createServer as tcpServer, type Socket } from 'node:net'
import { once } from 'node:events'
import { Hono } from 'hono'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIsolatedViewer, createIsolatedViewerTickets, ISOLATED_VIEWER_TICKET_TTL_MS, ISOLATED_VIEWER_WS_PATH, type IsolatedScreenService } from './isolated-viewer.js'
const run = { sessionId: 'session-1', runId: 'run-1' }
const owner = { engineAgentId: 'agent-1', launchNonce: 'nonce-1' }, target = { ...owner, sessionGeneration: 'gen-1' }
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function setup() {
    const service = {
        status: vi.fn(async () => ({ state: 'available' as const, driving: false })),
        ensure: vi.fn(async () => ({ target, width: 1200, height: 800 })),
        running: vi.fn(async () => ({ target, width: 1200, height: 800 })),
        navigate: vi.fn(async () => undefined), startTakeover: vi.fn(async () => 'lease-1'),
        finishTakeover: vi.fn(async () => ({ url: 'https://example.com' })), stop: vi.fn(async () => {}),
        withViewer: vi.fn<IsolatedScreenService['withViewer']>(async () => {}),
    }
    const authority = { launchNonce: 'nonce-1', uiOrigin: 'http://127.0.0.1:12345', currentRun: vi.fn<() => typeof run | null>(() => run), authorize: vi.fn(async () => {}) }
    const controller = createIsolatedViewer(service, authority)
    cleanups.push(() => controller.close())
    const app = new Hono().route('/agents/:id/screen', controller.routes)
    const post = (action: string, input = {}, signal?: AbortSignal) => app.request(`/agents/agent-1/screen/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ launchNonce: owner.launchNonce, ...input }), signal })
    return { service, authority, controller, app, post }
}
describe('viewer tickets', () => {
    it('enforces mode/owner/lease, expiry, single use and exact revocation', () => {
        const tickets = createIsolatedViewerTickets()
        expect(() => tickets.issue({ owner, target, mode: 'drive' })).toThrow()
        expect(() => tickets.issue({ owner, target: { ...target, engineAgentId: 'other' }, mode: 'watch' })).toThrow()
        expect(() => tickets.issue({ owner, target, mode: 'bad' as 'watch' })).toThrow()
        const first = tickets.issue({ owner, target, mode: 'watch' })
        expect(tickets.redeem(first.ticket)?.target).toEqual(target)
        expect(tickets.redeem(first.ticket)).toBeNull()
        const expired = tickets.issue({ owner, target, mode: 'watch' }, 10)
        expect(tickets.redeem(expired.ticket, 10 + ISOLATED_VIEWER_TICKET_TTL_MS)).toBeNull()
        const mine = tickets.issue({ owner, target, mode: 'watch' })
        const other = { engineAgentId: 'other', launchNonce: owner.launchNonce }
        const theirs = tickets.issue({ owner: other, target: { ...other, sessionGeneration: 'x' }, mode: 'watch' })
        tickets.revoke(owner)
        expect(tickets.redeem(mine.ticket)).toBeNull(); expect(tickets.redeem(theirs.ticket)).not.toBeNull()
    })
})
it('requires current authority before starting a screen and rejects old launches', async () => {
    const f = setup(); f.authority.authorize.mockRejectedValue(new Error('revoked'))
    expect((await f.post('view', { mode: 'watch' })).status).toBe(409)
    expect(f.service.ensure).not.toHaveBeenCalled()
    expect((await f.post('view', { mode: 'watch', launchNonce: 'old' })).status).toBe(409)
})
it('passive tickets inspect only an existing generation and cannot restart a stopped guest', async () => {
    const f = setup()
    expect((await f.post('view', { mode: 'watch', requireRunning: true })).status).toBe(200)
    expect(f.service.running).toHaveBeenCalledTimes(1)
    expect(f.service.ensure).not.toHaveBeenCalled()
    f.service.running.mockRejectedValue(new Error('stopped'))
    expect((await f.post('view', { mode: 'watch', requireRunning: true })).status).toBe(409)
    expect(f.service.ensure).not.toHaveBeenCalled()
    expect((await f.post('view', { mode: 'drive', requireRunning: true })).status).toBe(400)
    expect(f.service.startTakeover).not.toHaveBeenCalled()
})
it('rejects malformed view modes and drive without its exact current lease', async () => {
    const f = setup()
    expect((await f.post('view', { mode: 'wrong' })).status).toBe(400)
    expect((await f.post('view', { mode: 'drive' })).status).toBe(409)
    expect((await f.post('takeover')).status).toBe(200)
    expect((await f.post('view', { mode: 'drive', lease: 'foreign' })).status).toBe(409)
    expect((await f.post('view', { mode: 'drive', lease: 'lease-1' })).status).toBe(200)
    f.service.ensure.mockResolvedValue({ target: { ...target, sessionGeneration: 'new' }, width: 1200, height: 800 })
    expect((await f.post('view', { mode: 'drive', lease: 'lease-1' })).status).toBe(409)
})
it('Stop does not start an unused guest; exact finish is replay-safe', async () => {
    const f = setup()
    expect((await f.app.request('/agents/agent-1/screen/stop?launchNonce=nonce-1', { method: 'POST' })).status).toBe(200)
    expect(f.service.ensure).not.toHaveBeenCalled()
    await f.post('takeover')
    expect(await (await f.post('takeover/finish', { lease: 'wrong' })).json()).toEqual({ url: null, expired: true })
    expect(f.service.finishTakeover).not.toHaveBeenCalled()
    expect((await f.post('takeover/finish', { lease: 'lease-1' })).status).toBe(200)
    expect((await f.post('takeover/finish', { lease: 'lease-1' })).status).toBe(200)
    expect(f.service.finishTakeover).toHaveBeenCalledTimes(1)
})
it('releases a lease acquired after caller cancellation', async () => {
    const f = setup(), abort = new AbortController()
    f.service.startTakeover.mockImplementation(async () => { abort.abort(); return 'late' })
    expect((await f.post('takeover', {}, abort.signal)).status).toBe(409)
    expect(f.service.finishTakeover).toHaveBeenCalledWith(target, 'late', expect.any(AbortSignal))
})
it('reuses only an exact live lease and replaces a released lease in one open', async () => {
    const f = setup()
    await f.post('takeover', { url: 'https://example.com/start' })
    expect(await (await f.post('takeover', { lease: 'lease-1', url: 'https://example.com/ignored' })).json()).toEqual({ lease: 'lease-1' })
    expect(f.service.navigate).toHaveBeenCalledTimes(1)
    expect(f.service.startTakeover).toHaveBeenCalledTimes(1)
    expect((await f.post('takeover', { lease: 'foreign' })).status).toBe(409)
    expect(f.service.finishTakeover).not.toHaveBeenCalled()
    await f.post('takeover/finish', { lease: 'lease-1' })
    f.service.startTakeover.mockResolvedValue('lease-2')
    expect(await (await f.post('takeover', { lease: 'lease-1' })).json()).toEqual({ lease: 'lease-2' })
})
it('rechecks a pending release after ensure before replacing control', async () => {
    const f = setup(); await f.post('takeover')
    let complete!: () => void
    f.service.finishTakeover.mockImplementation(() => new Promise(resolve => { complete = () => resolve({ url: null }) }))
    let ending!: Promise<Response>
    f.service.ensure.mockImplementationOnce(async () => {
        ending = f.post('takeover/finish', { lease: 'lease-1' })
        await vi.waitFor(() => expect(complete).toBeDefined())
        return { target, width: 1200, height: 800 }
    })
    f.service.startTakeover.mockResolvedValue('lease-2')
    const opening = f.post('takeover', { lease: 'lease-1' })
    await vi.waitFor(() => expect(complete).toBeDefined())
    expect(f.service.startTakeover).toHaveBeenCalledTimes(1)
    complete(); await ending
    expect(await (await opening).json()).toEqual({ lease: 'lease-2' })
    f.service.finishTakeover.mockResolvedValue({ url: 'https://example.com' })
})
it('replaces only the old exact generation when reopening', async () => {
    const f = setup(); await f.post('takeover')
    f.service.ensure.mockResolvedValue({ target: { ...target, sessionGeneration: 'new' }, width: 1200, height: 800 })
    f.service.startTakeover.mockResolvedValue('lease-2')
    expect(await (await f.post('takeover', { lease: 'lease-1' })).json()).toEqual({ lease: 'lease-2' })
    expect(f.service.finishTakeover).toHaveBeenCalledWith(target, 'lease-1', expect.any(AbortSignal))
    expect(f.service.stop).not.toHaveBeenCalled()
})
it('rechecks authority after ensure and refuses wrong runtime owner', async () => {
    const f = setup()
    f.service.ensure.mockImplementation(async () => { f.authority.authorize.mockRejectedValue(new Error('revoked')); return { target, width: 1200, height: 800 } })
    expect((await f.post('view', { mode: 'watch' })).status).toBe(409)
    f.authority.authorize.mockResolvedValue(undefined)
    f.service.ensure.mockResolvedValue({ target: { ...target, engineAgentId: 'other' }, width: 1200, height: 800 })
    expect((await f.post('view', { mode: 'watch' })).status).toBe(409)
})
async function network(f: ReturnType<typeof setup>, readOnly: boolean) {
    const sockets = new Set<Socket>()
    const guest = tcpServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.write('RFB') })
    guest.listen(0, '127.0.0.1'); await once(guest, 'listening')
    cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => guest.close(() => resolve())) })
    const port = (guest.address() as { port: number }).port
    f.service.withViewer.mockImplementation(async (_target, _mode, _signal, connect) => { const stream = tcpConnect(port, '127.0.0.1'); try { await connect(stream) } finally { stream.destroy() } })
    const server = httpServer(); f.controller.attach(server); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    cleanups.push(async () => { await f.controller.close(); await new Promise<void>(resolve => server.close(() => resolve())) })
    const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}${ISOLATED_VIEWER_WS_PATH}`
    return { sockets, url }
}
it('keeps the watch stream alive until its viewer closes', async () => {
    const f = setup(), n = await network(f, true), body = await (await f.post('view', { mode: 'watch' })).json()
    const ws = new WebSocket(`${n.url}?ticket=${body.ticket}`, { origin: f.authority.uiOrigin })
    const frame = await once(ws, 'message')
    expect(frame[0].toString()).toBe('RFB')
    expect(f.service.withViewer.mock.calls[0]?.[1]).toBe('watch')
    expect(n.sockets.size).toBe(1)
    ws.close()
    await vi.waitFor(() => expect(n.sockets.size).toBe(0))
})

it('revocation destroys active TCP/WebSocket connections and ticket replay fails', async () => {
    const f = setup(), n = await network(f, true), body = await (await f.post('view', { mode: 'watch' })).json()
    const ws = new WebSocket(`${n.url}?ticket=${body.ticket}`, { origin: f.authority.uiOrigin })
    await once(ws, 'message'); expect(n.sockets.size).toBe(1)
    const closed = once(ws, 'close'); await f.controller.revoke(owner); await closed
    await vi.waitFor(() => expect(n.sockets.size).toBe(0))
    const replay = new WebSocket(`${n.url}?ticket=${body.ticket}`, { origin: f.authority.uiOrigin })
    replay.on('error', () => {})
    const [, response] = await once(replay, 'unexpected-response'); response.resume()
    replay.terminate()
})
it('rejects another website origin without spending the ticket', async () => {
    const f = setup(), n = await network(f, true), body = await (await f.post('view', { mode: 'watch' })).json()
    const ws = new WebSocket(`${n.url}?ticket=${body.ticket}`, { origin: 'https://other.example' })
    ws.on('error', () => {})
    const rejected = await new Promise<number | undefined>(resolve => ws.on('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); ws.terminate() }))
    expect(rejected).toBe(401); expect(f.service.withViewer).not.toHaveBeenCalled()
})


it('Stop still stops the exact guest when takeover release fails', async () => {
    const f = setup(); await f.post('takeover')
    f.service.finishTakeover.mockRejectedValue(new Error('release failed'))
    expect((await f.app.request('/agents/agent-1/screen/stop?launchNonce=nonce-1', { method: 'POST' })).status).toBe(200)
    expect(f.service.stop).toHaveBeenCalledWith(target, expect.any(AbortSignal))
})
it('failed cancellation release falls back to stopping the acquired target', async () => {
    const f = setup(), abort = new AbortController()
    f.service.startTakeover.mockImplementation(async () => { abort.abort(); return 'late' })
    f.service.finishTakeover.mockRejectedValue(new Error('release failed'))
    expect((await f.post('takeover', {}, abort.signal)).status).toBe(409)
    expect(f.service.stop).toHaveBeenCalledWith(target, expect.any(AbortSignal))
})
it('serializes buffered WebSocket messages across asynchronous authority checks', async () => {
    const f = setup(), n = await network(f, true), body = await (await f.post('view', { mode: 'watch' })).json()
    const ws = new WebSocket(`${n.url}?ticket=${body.ticket}`, { origin: f.authority.uiOrigin })
    await once(ws, 'message')
    const chunks: Buffer[] = []; [...n.sockets][0]!.on('data', data => chunks.push(data))
    let resolve!: () => void
    f.authority.authorize.mockImplementationOnce(() => new Promise<void>(r => { resolve = r }))
    ws.send(Buffer.from('A')); ws.send(Buffer.from('B'))
    await vi.waitFor(() => expect(resolve).toBeDefined())
    expect(Buffer.concat(chunks).toString()).toBe('')
    resolve()
    await vi.waitFor(() => expect(Buffer.concat(chunks).toString()).toBe('AB'))
    const closed = once(ws, 'close'); ws.close(); await closed
})


describe('run-bound passive viewer', () => {
    it('requires the exact current session and run before inspecting an existing guest', async () => {
        const f = setup()
        for (const input of [
            { mode: 'watch', run },
            { mode: 'drive', requireRunning: true, run },
        ]) expect((await f.post('view', input)).status).toBe(400)
        for (const current of [null, { ...run, sessionId: 'sibling' }, { ...run, runId: 'next' }]) {
            f.authority.currentRun.mockReturnValue(current)
            expect((await f.post('view', { mode: 'watch', requireRunning: true, run })).status).toBe(409)
        }
        expect(f.service.running).not.toHaveBeenCalled()
        expect(f.service.ensure).not.toHaveBeenCalled()
    })

    it('rejects a run replaced during the final asynchronous authorization check', async () => {
        const f = setup()
        f.authority.authorize.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
            f.authority.currentRun.mockReturnValue({ ...run, runId: 'next' })
        })
        const response = await f.post('view', { mode: 'watch', requireRunning: true, run })
        expect(response.status).toBe(409)
        expect(await response.json()).not.toHaveProperty('ticket')
        expect(f.service.running).toHaveBeenCalledTimes(1)
        expect(f.service.ensure).not.toHaveBeenCalled()
    })

    it('cannot redeem a previously issued ticket into a later run of the same coworker', async () => {
        const f = setup(), n = await network(f, true)
        const body = await (await f.post('view', { mode: 'watch', requireRunning: true, run })).json()
        f.authority.currentRun.mockReturnValue({ ...run, runId: 'next' })
        const ws = new WebSocket(`${n.url}?ticket=${body.ticket}`, { origin: f.authority.uiOrigin })
        ws.on('error', () => {})
        await once(ws, 'close')
        expect(f.service.withViewer).not.toHaveBeenCalled()
        expect(f.service.ensure).not.toHaveBeenCalled()
    })

    it('closes a stale observer before forwarding a frame from a replacement run', async () => {
        const f = setup(), n = await network(f, true)
        const body = await (await f.post('view', { mode: 'watch', requireRunning: true, run })).json()
        const ws = new WebSocket(`${n.url}?ticket=${body.ticket}`, { origin: f.authority.uiOrigin })
        await once(ws, 'message')
        const frames: string[] = []
        ws.on('message', data => frames.push(data.toString()))
        const closed = once(ws, 'close')
        f.authority.currentRun.mockReturnValue({ ...run, runId: 'next' })
        for (const socket of n.sockets) socket.write('replacement frame')
        await closed
        expect(frames).toEqual([])
        await vi.waitFor(() => expect(n.sockets.size).toBe(0))
        expect(f.service.stop).not.toHaveBeenCalled()
    })
})
