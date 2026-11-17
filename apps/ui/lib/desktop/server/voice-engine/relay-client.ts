import 'server-only'
import { RELAY_AUTH_HEADER, relayAuthHeader, relayToMacSchema, type DownstreamMessage, type RelayToMac } from './relay-protocol'

export type RelaySocketLike = {
    readonly readyState: number
    send(data: string): void
    close(code?: number, reason?: string): void
    onopen: ((event: unknown) => void) | null
    onmessage: ((event: { data: unknown }) => void) | null
    onclose: ((event: unknown) => void) | null
    onerror: ((event: unknown) => void) | null
}
export type RelaySocketFactory = (url: string, headers: Record<string, string>) => RelaySocketLike

const OPEN = 1
// Node's WebSocket (undici) takes request headers as an option.
const nodeSocket: RelaySocketFactory = (url, headers) =>
    new (globalThis.WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => RelaySocketLike)(url, { headers })

export type RelayHandlers = {
    open(channel: string, authorization: string): void
    frame(channel: string, message: unknown): void
    closed(channel: string): void
    ready(channels: string[]): void
}

/**
 * The Mac's one outbound connection to its relay. It signs every connection with the install's
 * secret, keeps the connection alive, and reconnects with backoff until it is stopped. Nothing
 * listens on this Mac for it.
 */
export function createRelayClient(options: {
    url: URL
    installId: string
    secret: () => Promise<string | null>
    handlers: RelayHandlers
    socket?: RelaySocketFactory
    now?: () => number
    heartbeatMs?: number
    silenceMs?: number
    backoffMs?: readonly number[]
    announceTimeoutMs?: number
}) {
    const factory = options.socket ?? nodeSocket, now = options.now ?? Date.now
    const heartbeatMs = options.heartbeatMs ?? 20_000, silenceMs = options.silenceMs ?? 60_000
    const backoff = options.backoffMs ?? [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]
    const announceTimeoutMs = options.announceTimeoutMs ?? 4_000
    let socket: RelaySocketLike | null = null
    let ready = false, running = false, failures = 0, lastHeard = 0
    let retry: ReturnType<typeof setTimeout> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined
    const waiting = new Map<string, (accepted: boolean) => void>()

    function settleWaiting() {
        for (const settle of [...waiting.values()]) settle(false)
    }

    function drop(current: RelaySocketLike) {
        if (socket !== current) return
        socket = null
        ready = false
        clearInterval(heartbeat)
        settleWaiting()
        try { current.close(1000, 'reconnecting') } catch { /* already closed */ }
        if (!running) return
        const delay = backoff[Math.min(failures, backoff.length - 1)]
        failures++
        retry = setTimeout(() => void connect(), delay + Math.floor(Math.random() * delay * 0.2))
    }

    function receive(current: RelaySocketLike, data: unknown) {
        if (socket !== current || typeof data !== 'string' || data.length > 256 * 1024) return
        lastHeard = now()
        let parsed: RelayToMac
        try {
            const result = relayToMacSchema.safeParse(JSON.parse(data))
            if (!result.success) return
            parsed = result.data
        } catch { return }
        switch (parsed.type) {
            case 'ready':
                ready = true
                failures = 0
                return options.handlers.ready(parsed.channels)
            case 'announced':
            case 'refused': return waiting.get(parsed.conversationId)?.(parsed.type === 'announced')
            case 'open': return options.handlers.open(parsed.channel, parsed.authorization)
            case 'frame': return options.handlers.frame(parsed.channel, parsed.message)
            case 'closed': return options.handlers.closed(parsed.channel)
            case 'pong': return
        }
    }

    async function connect() {
        retry = undefined
        if (!running || socket) return
        const secret = await options.secret().catch(() => null)
        if (!running || socket) return
        if (!secret) { running = false; return }
        let current: RelaySocketLike
        try {
            current = factory(options.url.toString(), { [RELAY_AUTH_HEADER]: relayAuthHeader({ secret, installId: options.installId, url: options.url, nowMs: now() }) })
        } catch {
            const delay = backoff[Math.min(failures++, backoff.length - 1)]
            retry = setTimeout(() => void connect(), delay)
            return
        }
        socket = current
        lastHeard = now()
        current.onmessage = event => receive(current, event.data)
        current.onclose = () => drop(current)
        current.onerror = () => drop(current)
        current.onopen = () => {
            if (socket !== current) return
            lastHeard = now()
            heartbeat = setInterval(() => {
                if (socket !== current) return
                if (now() - lastHeard > silenceMs) return drop(current)
                try { current.send('{"type":"ping"}') } catch { drop(current) }
            }, heartbeatMs)
        }
    }

    function sendJson(value: unknown): boolean {
        if (!socket || !ready || socket.readyState !== OPEN) return false
        try { socket.send(JSON.stringify(value)); return true } catch { return false }
    }

    return {
        start() {
            if (running) return
            running = true
            failures = 0
            void connect()
        },
        stop() {
            running = false
            clearTimeout(retry)
            retry = undefined
            const current = socket
            socket = null
            ready = false
            clearInterval(heartbeat)
            settleWaiting()
            if (current) { try { current.close(1000, 'stopped') } catch { /* already closed */ } }
        },
        get connected() { return ready && socket?.readyState === OPEN },
        get running() { return running },
        /** Tells the relay to expect ElevenLabs for this conversation. Resolves once the relay agreed. */
        announce(conversationId: string, ttlMs: number): Promise<boolean> {
            if (waiting.has(conversationId)) return Promise.resolve(false)
            return new Promise<boolean>(resolve => {
                const settle = (accepted: boolean) => { clearTimeout(timer); waiting.delete(conversationId); resolve(accepted) }
                const timer = setTimeout(() => settle(false), announceTimeoutMs)
                waiting.set(conversationId, settle)
                if (!sendJson({ type: 'announce', conversationId, ttlMs })) settle(false)
            })
        },
        withdraw(conversationId: string) { sendJson({ type: 'withdraw', conversationId }) },
        send(channel: string, message: DownstreamMessage) { return sendJson({ type: 'send', channel, message }) },
        close(channel: string) { sendJson({ type: 'close', channel }) },
    }
}
export type RelayClient = ReturnType<typeof createRelayClient>
