import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import type { IncomingMessage, Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { Hono } from 'hono'
import { WebSocketServer, type WebSocket } from 'ws'
import { z } from 'zod'

export const ISOLATED_VIEWER_WS_PATH = '/desktop/isolated-viewer-ws'
export const ISOLATED_VIEWER_TICKET_TTL_MS = 60_000
const id = z.string().min(1).max(200)
const ownerSchema = z.strictObject({ engineAgentId: id, launchNonce: id })
const targetSchema = ownerSchema.extend({ sessionGeneration: id })
const modeSchema = z.enum(['watch', 'drive'])
export type IsolatedScreenOwner = z.infer<typeof ownerSchema>
export type IsolatedScreenMode = z.infer<typeof modeSchema>
export type IsolatedScreenTarget = z.infer<typeof targetSchema>
export type IsolatedScreenStatus = {
    state: 'available' | 'unavailable' | 'starting' | 'taken-over' | 'disconnected'
    reason?: string; driving: boolean; width?: number; height?: number
}
// A supplies a *server-enforced* read-only VNC endpoint for watch. WebSocket frames are not
// RFB message boundaries; filtering their first byte cannot enforce read-only access.
export type IsolatedScreenEndpoint = { host: '127.0.0.1'; port: number; readOnly: boolean }
export interface IsolatedScreenService {
    status(owner: IsolatedScreenOwner, signal: AbortSignal): Promise<IsolatedScreenStatus>
    ensure(owner: IsolatedScreenOwner, signal: AbortSignal): Promise<{ target: IsolatedScreenTarget; width: number; height: number }>
    navigate(target: IsolatedScreenTarget, input: { url: string }, signal: AbortSignal): Promise<unknown>
    startTakeover(target: IsolatedScreenTarget, signal: AbortSignal): Promise<string>
    finishTakeover(target: IsolatedScreenTarget, lease: string, signal: AbortSignal): Promise<{ url: string | null; expired?: boolean }>
    stop(target: IsolatedScreenTarget, signal: AbortSignal): Promise<void>
    withViewer(target: IsolatedScreenTarget, mode: IsolatedScreenMode, signal: AbortSignal, connect: (endpoint: IsolatedScreenEndpoint) => void): Promise<void> | void
}
export type IsolatedViewerAuthority = {
    launchNonce: string
    uiOrigin: string
    /** Required: reread current exact coworker, enabled/deleting state and browser/computer grants. */
    authorize: (owner: IsolatedScreenOwner, mode: IsolatedScreenMode, signal: AbortSignal) => Promise<void>
}
type Ticket = { owner: IsolatedScreenOwner; target: IsolatedScreenTarget; mode: IsolatedScreenMode; lease?: string; expiresAt: number }
const keyOf = (owner: IsolatedScreenOwner) => JSON.stringify([owner.engineAgentId, owner.launchNonce])
const sameTarget = (a: IsolatedScreenTarget, b: IsolatedScreenTarget) => keyOf(a) === keyOf(b) && a.sessionGeneration === b.sessionGeneration

export function createIsolatedViewerTickets() {
    const entries = new Map<string, Ticket>()
    const sweep = (now: number) => { for (const [key, value] of entries) if (value.expiresAt <= now) entries.delete(key) }
    return {
        issue(input: Omit<Ticket, 'expiresAt'>, now = Date.now()) {
            const owner = ownerSchema.parse(input.owner), target = targetSchema.parse(input.target), mode = modeSchema.parse(input.mode)
            if (keyOf(owner) !== keyOf(target) || (mode === 'drive' && !input.lease)) throw new Error('Invalid screen authority')
            sweep(now)
            if (entries.size >= 256) throw new Error('Too many screen requests')
            const ticket = randomBytes(24).toString('base64url'), expiresAt = now + ISOLATED_VIEWER_TICKET_TTL_MS
            entries.set(ticket, { owner, target, mode, ...(input.lease && { lease: input.lease }), expiresAt })
            return { ticket, expiresAt }
        },
        redeem(token: string, now = Date.now()): Ticket | null {
            sweep(now)
            const ticket = entries.get(token)
            entries.delete(token)
            return ticket ?? null
        },
        revoke(owner: IsolatedScreenOwner) { for (const [key, value] of entries) if (keyOf(value.owner) === keyOf(owner)) entries.delete(key) },
        clear() { entries.clear() },
    }
}

const launch = z.strictObject({ launchNonce: id })
const viewInput = launch.extend({ mode: modeSchema, lease: z.string().min(1).max(500).optional() })
const takeoverInput = launch.extend({ url: z.string().url().refine(url => /^https?:\/\//i.test(url)).optional() })
const finishInput = launch.extend({ lease: z.string().min(1).max(500) })

/** Deliberately unmounted until A/B and the required current-authority hooks are integrated.
 * No global tickets, implicit grants, host desktop fallback or unowned background connections. */
export function createIsolatedViewer(service: IsolatedScreenService, authority: IsolatedViewerAuthority) {
    const tickets = createIsolatedViewerTickets()
    const targets = new Map<string, IsolatedScreenTarget>()
    const leases = new Map<string, { target: IsolatedScreenTarget; lease: string }>()
    const acquiring = new Set<string>()
    const leaseTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const releasing = new Map<string, Promise<{ url: string | null }>>()
    const finished = new Map<string, { url: string | null }>()
    const pending = new Map<AbortController, IsolatedScreenOwner>()
    const sockets = new Map<() => void, IsolatedScreenOwner>()
    const epochs = new Map<string, number>()
    const detach = new Set<() => void>()
    let closed = false
    const owner = (engineAgentId: string, launchNonce: string) => {
        const value = ownerSchema.parse({ engineAgentId, launchNonce })
        if (closed || launchNonce !== authority.launchNonce) throw new Error('Screen launch expired')
        return value
    }
    async function authorize(value: IsolatedScreenOwner, mode: IsolatedScreenMode, signal: AbortSignal) {
        signal.throwIfAborted()
        owner(value.engineAgentId, value.launchNonce)
        await authority.authorize(value, mode, signal)
        signal.throwIfAborted()
        if (closed) throw new Error('Screen stopped')
    }
    async function operation<T>(value: IsolatedScreenOwner, mode: IsolatedScreenMode, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>) {
        if (pending.size >= 64) throw new Error('Too many screen requests')
        const controller = new AbortController(), epoch = epochs.get(keyOf(value)) ?? 0
        pending.set(controller, value)
        const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(45_000)])
        try {
            await authorize(value, mode, combined)
            const result = await work(combined)
            await authorize(value, mode, combined)
            if (epoch !== (epochs.get(keyOf(value)) ?? 0)) throw new Error('Screen stopped')
            return result
        } finally { pending.delete(controller) }
    }
    async function ensure(value: IsolatedScreenOwner, signal: AbortSignal) {
        const result = await service.ensure(value, signal)
        signal.throwIfAborted()
        const target = targetSchema.parse(result.target)
        if (keyOf(target) !== keyOf(value)) throw new Error('Screen owner mismatch')
        if (![result.width, result.height].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw new Error('Invalid screen dimensions')
        targets.set(keyOf(value), target)
        return { ...result, target }
    }
    function release(value: IsolatedScreenOwner, lease: string): Promise<{ url: string | null; expired?: boolean }> {
        const key = keyOf(value), receipt = `${key}:${lease}`
        if (finished.has(receipt)) return Promise.resolve(finished.get(receipt)!)
        if (releasing.has(receipt)) return releasing.get(receipt)!
        const held = leases.get(key)
        if (!held || held.lease !== lease) return Promise.resolve({ url: null, expired: true })
        const work = Promise.resolve().then(async () => {
            tickets.revoke(value)
            for (const [shutdown, current] of sockets) if (keyOf(current) === key) shutdown()
            const result = await service.finishTakeover(held.target, lease, AbortSignal.timeout(10_000))
            if (leases.get(key) === held) { leases.delete(key); clearTimeout(leaseTimers.get(key)); leaseTimers.delete(key) }
            if (finished.size >= 256) finished.delete(finished.keys().next().value!)
            finished.set(receipt, result)
            return result
        }).finally(() => releasing.delete(receipt))
        releasing.set(receipt, work)
        return work
    }
    async function cleanup(value: IsolatedScreenOwner, held: { target: IsolatedScreenTarget; lease: string }) {
        try { await release(value, held.lease) }
        catch {
            // A failed release must not leave an untracked input lock. Stop the exact guest;
            // if that also fails keep the lease/target so a later Stop can retry cleanup.
            await service.stop(held.target, AbortSignal.timeout(10_000))
            if (leases.get(keyOf(value)) === held) leases.delete(keyOf(value))
            clearTimeout(leaseTimers.get(keyOf(value))); leaseTimers.delete(keyOf(value))
        }
    }
    async function revoke(value: IsolatedScreenOwner) {
        const key = keyOf(value)
        epochs.set(key, (epochs.get(key) ?? 0) + 1)
        tickets.revoke(value)
        for (const [controller, current] of pending) if (keyOf(current) === key) controller.abort()
        for (const [shutdown, current] of sockets) if (keyOf(current) === key) shutdown()
        const held = leases.get(key)
        if (held) await release(value, held.lease)
    }
    const routes = new Hono()
    routes.onError((error, c) => c.json({ error: error instanceof z.ZodError ? 'Invalid screen request' : 'Isolated screen unavailable' }, error instanceof z.ZodError ? 400 : 409))
    routes.get('/status', async c => {
        const input = launch.parse(c.req.query()), value = owner(c.req.param('id')!, input.launchNonce)
        return c.json(await operation(value, 'watch', c.req.raw.signal, signal => service.status(value, signal)))
    })
    routes.post('/view', async c => {
        const input = viewInput.parse(await c.req.json().catch(() => null)), value = owner(c.req.param('id')!, input.launchNonce)
        const result = await operation(value, input.mode, c.req.raw.signal, async signal => {
            const ensured = await ensure(value, signal)
            const held = leases.get(keyOf(value))
            if (input.mode === 'drive' && (!held || held.lease !== input.lease || !sameTarget(held.target, ensured.target))) throw new Error('Take control first')
            return ensured
        })
        const issued = tickets.issue({ owner: value, target: result.target, mode: input.mode, lease: input.lease })
        return c.json({ ...issued, expiresAt: new Date(issued.expiresAt).toISOString(), width: result.width, height: result.height })
    })
    routes.post('/takeover', async c => {
        const input = takeoverInput.parse(await c.req.json().catch(() => null)), value = owner(c.req.param('id')!, input.launchNonce)
        let acquired: { target: IsolatedScreenTarget; lease: string } | undefined
        if (acquiring.has(keyOf(value))) throw new Error('Control is being acquired')
        acquiring.add(keyOf(value))
        try {
            const result = await operation(value, 'drive', c.req.raw.signal, async signal => {
                if (leases.has(keyOf(value))) throw new Error('Screen already controlled')
                const ensured = await ensure(value, signal)
                if (input.url) await service.navigate(ensured.target, { url: input.url }, signal)
                const lease = await service.startTakeover(ensured.target, signal)
                acquired = { target: ensured.target, lease }
                leases.set(keyOf(value), acquired)
                // A lost HTTP response must not hold human control forever without a viewer.
                const held = acquired
                const timer = setTimeout(() => { void cleanup(value, held).catch(() => {}) }, ISOLATED_VIEWER_TICKET_TTL_MS)
                timer.unref?.(); leaseTimers.set(keyOf(value), timer)
                signal.throwIfAborted()
                return { lease }
            })
            return c.json(result)
        } catch (error) {
            if (acquired) await cleanup(value, acquired)
            throw error
        } finally { acquiring.delete(keyOf(value)) }
    })
    routes.post('/takeover/finish', async c => {
        const input = finishInput.parse(await c.req.json().catch(() => null)), value = owner(c.req.param('id')!, input.launchNonce)
        // Exact opaque lease permits cleanup after grant revocation; it never creates a screen.
        return c.json(await release(value, input.lease))
    })
    routes.post('/stop', async c => {
        const input = launch.parse(c.req.query()), value = owner(c.req.param('id')!, input.launchNonce)
        try { await revoke(value) }
        finally {
            const target = targets.get(keyOf(value))
            if (target) {
                await service.stop(target, AbortSignal.timeout(10_000)); targets.delete(keyOf(value)); leases.delete(keyOf(value))
                clearTimeout(leaseTimers.get(keyOf(value))); leaseTimers.delete(keyOf(value))
            }
        }
        return c.json({ ok: true })
    })
    async function pipe(ws: WebSocket, ticket: Ticket) {
        const abort = new AbortController()
        let vnc: Socket | undefined, timer: ReturnType<typeof setInterval> | undefined, ended = false, checking = false
        const queue: Buffer[] = []
        let queuedBytes = 0, pumping = false
        const shutdown = () => {
            if (ended) return
            ended = true; abort.abort(); clearInterval(timer); sockets.delete(shutdown)
            queue.length = 0; queuedBytes = 0; vnc?.destroy(); ws.terminate()
            const held = leases.get(keyOf(ticket.owner))
            if (ticket.mode === 'drive' && held && held.lease === ticket.lease) void cleanup(ticket.owner, held).catch(() => {})
        }
        sockets.set(shutdown, ticket.owner)
        const valid = async () => {
            await authorize(ticket.owner, ticket.mode, abort.signal)
            if (ticket.mode === 'drive') {
                const held = leases.get(keyOf(ticket.owner))
                if (!held || held.lease !== ticket.lease || !sameTarget(held.target, ticket.target)) throw new Error('Control expired')
            }
        }
        ws.once('close', shutdown); ws.once('error', shutdown)
        try {
            await valid()
            if (ticket.mode === 'drive') { clearTimeout(leaseTimers.get(keyOf(ticket.owner))); leaseTimers.delete(keyOf(ticket.owner)) }
            timer = setInterval(() => {
                if (checking) return
                checking = true
                void valid().catch(shutdown).finally(() => { checking = false })
            }, 1000)
            timer.unref?.()
            await service.withViewer(ticket.target, ticket.mode, abort.signal, endpoint => {
                abort.signal.throwIfAborted()
                if (vnc || endpoint.host !== '127.0.0.1' || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || (ticket.mode === 'watch' && endpoint.readOnly !== true)) throw new Error('Unsafe screen transport')
                vnc = connect(endpoint.port, endpoint.host)
                vnc.once('close', shutdown); vnc.once('error', shutdown)
                vnc.on('data', chunk => {
                    if (ws.readyState !== ws.OPEN || ws.bufferedAmount > 2 * 1024 * 1024) return shutdown()
                    ws.send(chunk)
                })
                const pump = async () => {
                    if (pumping) return
                    pumping = true
                    try {
                        while (queue.length && !ended) {
                            const bytes = queue.shift()!; queuedBytes -= bytes.length
                            await valid()
                            if (!vnc || abort.signal.aborted) return shutdown()
                            if (!vnc.write(bytes)) await once(vnc, 'drain', { signal: abort.signal })
                        }
                    } catch { shutdown() }
                    finally { pumping = false; if (!ended) ws.resume() }
                }
                ws.on('message', (data, binary) => {
                    if (!binary || ended) return shutdown()
                    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
                    if (bytes.length > 65_536 || queue.length >= 32 || queuedBytes + bytes.length > 1_048_576) return shutdown()
                    queue.push(bytes); queuedBytes += bytes.length; ws.pause()
                    void pump()
                })
            })
        } catch { shutdown() }
    }
    function attach(server: Server) {
        const wss = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false })
        const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
            const url = new URL(request.url ?? '/', 'http://engine')
            if (url.pathname !== ISOLATED_VIEWER_WS_PATH) return
            const refuse = () => socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
            if (closed || request.headers.origin !== authority.uiOrigin || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') || sockets.size >= 16) return refuse()
            const ticket = tickets.redeem(url.searchParams.get('ticket') ?? '')
            if (!ticket || ticket.owner.launchNonce !== authority.launchNonce) return refuse()
            wss.handleUpgrade(request, socket, head, ws => void pipe(ws, ticket))
        }
        server.on('upgrade', upgrade)
        const dispose = () => { server.off('upgrade', upgrade); for (const ws of wss.clients) ws.terminate(); wss.close(); detach.delete(dispose) }
        detach.add(dispose)
        return dispose
    }
    async function close() {
        closed = true; tickets.clear()
        for (const timer of leaseTimers.values()) clearTimeout(timer)
        leaseTimers.clear()
        for (const controller of pending.keys()) controller.abort()
        for (const shutdown of [...sockets.keys()]) shutdown()
        for (const dispose of [...detach]) dispose()
        await Promise.allSettled([...leases.values()].map(held => release(held.target, held.lease)))
    }
    return { routes, attach, revoke, close }
}
