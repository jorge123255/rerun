import { randomBytes } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { Hono } from 'hono'
import { WebSocketServer, type WebSocket } from 'ws'
import { z } from 'zod'
import { logger } from '../lib/logger.js'

export const ISOLATED_VIEWER_WS_PATH = '/desktop/isolated-viewer-ws'
export const ISOLATED_VIEWER_TICKET_TTL_MS = 60_000

export type IsolatedScreenOwner = { engineAgentId: string; launchNonce: string }
export type IsolatedScreenMode = 'watch' | 'drive'
export type IsolatedScreenTarget = IsolatedScreenOwner & { sessionGeneration: string }
export type IsolatedScreenStatus = {
    state: 'available' | 'unavailable' | 'starting' | 'taken-over' | 'disconnected'
    reason?: string
    driving: boolean
    width?: number
    height?: number
}
export type IsolatedScreenEndpoint = { host: string; port: number }
export type IsolatedScreenViewerConnect = (endpoint: IsolatedScreenEndpoint) => void

export interface IsolatedScreenService {
    status(owner: IsolatedScreenOwner, signal: AbortSignal): Promise<IsolatedScreenStatus>
    ensure(owner: IsolatedScreenOwner, signal: AbortSignal): Promise<{ target: IsolatedScreenTarget; width: number; height: number }>
    navigate(target: IsolatedScreenTarget, input: { url: string }, signal: AbortSignal): Promise<unknown>
    startTakeover(target: IsolatedScreenTarget, signal: AbortSignal): Promise<string>
    finishTakeover(target: IsolatedScreenTarget, lease: string, signal: AbortSignal): Promise<{ url: string | null }>
    stop(target: IsolatedScreenTarget, signal: AbortSignal): Promise<void>
    withViewer(target: IsolatedScreenTarget, mode: IsolatedScreenMode, signal: AbortSignal, connect: IsolatedScreenViewerConnect): Promise<void> | void
}

type ViewerTicket = {
    ticketId: string
    owner: IsolatedScreenOwner
    target: IsolatedScreenTarget
    mode: IsolatedScreenMode
    expiresAt: number
    used: boolean
}

const tickets = new Map<string, ViewerTicket>()

function sweep(now: number): void {
    for (const [id, ticket] of tickets) if (ticket.expiresAt <= now || ticket.used) tickets.delete(id)
}

export function issueIsolatedViewerTicket(input: { owner: IsolatedScreenOwner; target: IsolatedScreenTarget; mode: IsolatedScreenMode }, now: number = Date.now()): { ticket: string; expiresAt: number } {
    sweep(now)
    const ticketId = randomBytes(24).toString('base64url')
    const expiresAt = now + ISOLATED_VIEWER_TICKET_TTL_MS
    tickets.set(ticketId, { ticketId, owner: input.owner, target: input.target, mode: input.mode, expiresAt, used: false })
    return { ticket: ticketId, expiresAt }
}

export function redeemIsolatedViewerTicket(ticketId: string, now: number = Date.now()): ViewerTicket | null {
    sweep(now)
    const ticket = tickets.get(ticketId)
    if (!ticket || ticket.used) return null
    ticket.used = true
    return ticket
}

export function revokeIsolatedViewerTickets(owner: IsolatedScreenOwner): void {
    for (const [id, ticket] of tickets) if (ticket.owner.engineAgentId === owner.engineAgentId && ticket.owner.launchNonce === owner.launchNonce) tickets.delete(id)
}

const ownerQuery = z.object({ launchNonce: z.string().min(1).max(200) })
const viewInput = z.strictObject({ mode: z.enum(['watch', 'drive']), launchNonce: z.string().min(1).max(200) })
const takeoverInput = z.strictObject({ url: z.string().url().refine(u => /^https?:\/\//i.test(u)).optional(), launchNonce: z.string().min(1).max(200) })
const finishInput = z.strictObject({ launchNonce: z.string().min(1).max(200), lease: z.string().min(1).max(500).optional() })

function ownerOf(engineAgentId: string, launchNonce: string): IsolatedScreenOwner {
    return { engineAgentId, launchNonce }
}

export function isolatedScreenRoutes(service: IsolatedScreenService): Hono {
    const routes = new Hono()

    routes.get('/status', async c => {
        const { launchNonce } = ownerQuery.parse(c.req.query())
        return c.json(await service.status(ownerOf(c.req.param('id')!, launchNonce), c.req.raw.signal))
    })

    routes.post('/view', async c => {
        const { mode, launchNonce } = viewInput.parse(await c.req.json().catch(() => null))
        const owner = ownerOf(c.req.param('id')!, launchNonce)
        const ensured = await service.ensure(owner, c.req.raw.signal)
        const { ticket, expiresAt } = issueIsolatedViewerTicket({ owner, target: ensured.target, mode })
        return c.json({ ticket, expiresAt: new Date(expiresAt).toISOString(), sessionGeneration: ensured.target.sessionGeneration, width: ensured.width, height: ensured.height })
    })

    routes.post('/takeover', async c => {
        const { url, launchNonce } = takeoverInput.parse(await c.req.json().catch(() => null))
        const owner = ownerOf(c.req.param('id')!, launchNonce)
        const ensured = await service.ensure(owner, c.req.raw.signal)
        if (url) await service.navigate(ensured.target, { url }, c.req.raw.signal)
        const lease = await service.startTakeover(ensured.target, c.req.raw.signal)
        return c.json({ lease, sessionGeneration: ensured.target.sessionGeneration })
    })

    routes.post('/takeover/finish', async c => {
        const { launchNonce, lease } = finishInput.parse(await c.req.json().catch(() => null))
        const owner = ownerOf(c.req.param('id')!', launchNonce)
        const status = await service.status(owner, c.req.raw.signal)
        if (status.state === 'disconnected' || status.state === 'unavailable') return c.json({ url: null })
        const ensured = await service.ensure(owner, c.req.raw.signal)
        return c.json(await service.finishTakeover(ensured.target, lease ?? '', c.req.raw.signal))
    })

    routes.post('/stop', async c => {
        const { launchNonce } = ownerQuery.parse(c.req.query())
        const owner = ownerOf(c.req.param('id')!, launchNonce)
        const ensured = await service.ensure(owner, c.req.raw.signal).catch(() => null)
        if (ensured) await service.stop(ensured.target, c.req.raw.signal)
        revokeIsolatedViewerTickets(owner)
        return c.json({ ok: true })
    })

    return routes
}

const INPUT_MESSAGE_TYPES = new Set([4, 5, 255])
const SHORTEST_INPUT_MESSAGE = 6
const POINTER_EVENT = 5

const isInput = (data: Buffer): boolean => data.length >= SHORTEST_INPUT_MESSAGE && INPUT_MESSAGE_TYPES.has(data[0]!) && (data[0] !== POINTER_EVENT || data[1] !== 0)

function refuse(socket: Duplex, status: string): void {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
}

async function pipeToIsolatedVnc(service: IsolatedScreenService, ws: WebSocket, ticket: ViewerTicket): Promise<void> {
    const abort = new AbortController()
    let closed = false
    const shutdown = () => {
        if (closed) return
        closed = true
        abort.abort()
        ws.close()
    }
    ws.once('close', shutdown)
    ws.once('error', shutdown)
    try {
        await service.withViewer(ticket.target, ticket.mode, abort.signal, endpoint => {
            const vnc = connect(endpoint.port, endpoint.host)
            vnc.on('data', chunk => {
                if (ws.readyState === ws.OPEN) ws.send(chunk)
            })
            vnc.once('close', shutdown)
            vnc.once('error', shutdown)
            ws.on('message', data => {
                if (ticket.mode === 'watch' && isInput(data as Buffer)) return
                vnc.write(data as Buffer)
            })
        })
    } catch (err) {
        logger.warn({ err: String(err), agentId: ticket.owner.engineAgentId }, 'isolated screen viewer refused')
        shutdown()
    }
}

export function attachIsolatedViewerBridge(server: Server, service: IsolatedScreenService): void {
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(request.url ?? '/', 'http://engine')
        if (url.pathname !== ISOLATED_VIEWER_WS_PATH) return
        const ticket = redeemIsolatedViewerTicket(url.searchParams.get('ticket') ?? '')
        if (!ticket) return refuse(socket, '401 Unauthorized')
        wss.handleUpgrade(request, socket, head, ws => void pipeToIsolatedVnc(service, ws, ticket))
    })
}
