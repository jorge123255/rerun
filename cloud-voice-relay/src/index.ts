import { installSecret, RELAY_AUTH_HEADER, verifyRelayAuth } from './auth.ts'
import { CLOSE, LIMITS, macMessage, upstreamMessage, type RelayToMac } from './protocol.ts'
import { runtimeGlobals, type Env, type RelaySocket, type RelayState } from './runtime.ts'

export type { Env } from './runtime.ts'

// Paths: /v1/<install id>/mac for the Mac's outbound connection, /v1/<install id>/speech-engine for
// ElevenLabs. The install id is unguessable; an id this Worker was not given does not exist.
const ROUTE = /^\/v1\/([A-Za-z0-9_-]{43})\/(mac|speech-engine)$/
const ELEVENLABS_AUTHORIZATION = 'x-elevenlabs-speech-engine-authorization'
const INTERNAL = { role: 'x-relay-role', nonce: 'x-relay-nonce', timestamp: 'x-relay-timestamp', authorization: 'x-relay-authorization' } as const

export const relayClock = { now: () => Date.now() }

const empty = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store' } })

function egressAllowed(env: Env, address: string | null): boolean {
    if ((env.ELEVENLABS_EGRESS_CHECK ?? '').trim().toLowerCase() !== 'on') return true
    const allowed = (env.ELEVENLABS_EGRESS_IPS ?? '').split(',').map(entry => entry.trim()).filter(Boolean)
    return !!address && allowed.includes(address.trim())
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url)
        const route = ROUTE.exec(url.pathname)
        if (!route || url.search) return empty(404)
        const [, installId, role] = route
        const secret = installSecret(env.RELAY_INSTALLS, installId)
        if (!secret) return empty(404)
        if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return empty(426)
        // Only the headers named here reach the Durable Object, so a caller cannot set the internal ones.
        const forwarded = new Headers({ upgrade: 'websocket', [INTERNAL.role]: role })
        if (role === 'mac') {
            const verdict = await verifyRelayAuth({
                secret, installId, host: url.host, path: url.pathname, header: request.headers.get(RELAY_AUTH_HEADER),
                nowSeconds: Math.floor(relayClock.now() / 1000), windowSeconds: LIMITS.authWindowSeconds,
            })
            if (!verdict.ok) return empty(401)
            forwarded.set(INTERNAL.nonce, verdict.nonce)
            forwarded.set(INTERNAL.timestamp, String(verdict.timestamp))
        } else {
            if (!egressAllowed(env, request.headers.get('cf-connecting-ip'))) return empty(403)
            // The relay cannot check this token: only the Mac holds what it is signed with. It is
            // required here and handed to the Mac untouched, which refuses the conversation without it.
            const authorization = request.headers.get(ELEVENLABS_AUTHORIZATION)
            if (!authorization || authorization.length > LIMITS.authorizationMaxChars) return empty(401)
            forwarded.set(INTERNAL.authorization, authorization)
        }
        const relay = env.VOICE_RELAY.get(env.VOICE_RELAY.idFromName(installId))
        return relay.fetch(new Request(url.toString(), { method: 'GET', headers: forwarded }))
    },
}

type Bucket = { tokens: number; refilledAt: number }
type MacAttachment = Bucket & { role: 'mac'; at: number; closing?: boolean; replaced?: boolean }
type UpstreamAttachment = Bucket & { role: 'upstream'; channel: string; conversationId: string | null; openedAt: number; at: number; closing?: boolean }
type Attachment = MacAttachment | UpstreamAttachment

const encoder = new TextEncoder()
const tooLarge = (message: string, limit: number) => message.length > limit || (message.length * 3 > limit && encoder.encode(message).byteLength > limit)

/**
 * One per install: pairs the Mac's connection with ElevenLabs' connections. Every piece of state it
 * needs between messages is in socket attachments or storage, so it can hibernate between frames.
 * Nothing is logged: frames carry what people say, and the open frame carries ElevenLabs' token.
 */
export class VoiceRelay {
    private readonly claiming = new Set<string>()
    private readonly ctx: RelayState
    readonly env: Env
    constructor(ctx: RelayState, env: Env) {
        this.ctx = ctx
        this.env = env
        const Pair = runtimeGlobals().WebSocketRequestResponsePair
        // Keep-alive pings are answered without waking the object. Both the Mac and ElevenLabs send this frame.
        if (Pair && ctx.setWebSocketAutoResponse) ctx.setWebSocketAutoResponse(new Pair('{"type":"ping"}', '{"type":"pong"}'))
    }

    async fetch(request: Request): Promise<Response> {
        const role = request.headers.get(INTERNAL.role)
        if (role === 'mac') return this.acceptMac(request)
        if (role === 'speech-engine') return this.acceptUpstream(request)
        return empty(404)
    }

    private attachment(socket: RelaySocket): Attachment | null {
        const value = socket.deserializeAttachment() as Attachment | null
        return value && (value.role === 'mac' || value.role === 'upstream') ? value : null
    }

    private live(tag: string): RelaySocket[] {
        return this.ctx.getWebSockets(tag).filter(socket => {
            const state = this.attachment(socket)
            return !!state && !state.closing
        })
    }

    private mac(): RelaySocket | null { return this.live('mac')[0] ?? null }

    private tell(socket: RelaySocket | null, message: RelayToMac) {
        try { socket?.send(JSON.stringify(message)) } catch { /* the close handler tidies up */ }
    }

    private shut(socket: RelaySocket, code: number, reason: string) {
        const state = this.attachment(socket)
        if (state?.closing) return
        if (state) socket.serializeAttachment({ ...state, closing: true })
        try { socket.close(code, reason) } catch { /* already closed */ }
        if (state?.role === 'upstream') this.tell(this.mac(), { type: 'closed', channel: state.channel })
    }

    private take(bucket: Bucket, rate: { burst: number; perSecond: number }, now: number): boolean {
        bucket.tokens = Math.min(rate.burst, bucket.tokens + ((now - bucket.refilledAt) / 1000) * rate.perSecond)
        bucket.refilledAt = now
        if (bucket.tokens < 1) return false
        bucket.tokens -= 1
        return true
    }

    private async schedule() {
        if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(relayClock.now() + LIMITS.alarmEveryMs)
    }

    private upgraded(client: RelaySocket): Response {
        return new Response(null, { status: 101, webSocket: client } as ResponseInit)
    }

    private async acceptMac(request: Request): Promise<Response> {
        const nonce = request.headers.get(INTERNAL.nonce), timestamp = Number(request.headers.get(INTERNAL.timestamp))
        if (!nonce || !Number.isSafeInteger(timestamp)) return empty(401)
        if (await this.ctx.storage.get(`nonce:${nonce}`) !== undefined) return empty(401)
        await this.ctx.storage.put(`nonce:${nonce}`, (timestamp + 2 * LIMITS.authWindowSeconds) * 1000)
        // A reconnecting Mac takes over. Conversations already open stay open: the Mac closes the ones it no longer knows.
        for (const previous of this.ctx.getWebSockets('mac')) {
            const state = this.attachment(previous)
            if (state?.role === 'mac') previous.serializeAttachment({ ...state, replaced: true })
            this.shut(previous, CLOSE.replaced, 'replaced')
        }
        const now = relayClock.now()
        const { 0: client, 1: server } = new (runtimeGlobals().WebSocketPair)()
        this.ctx.acceptWebSocket(server, ['mac'])
        server.serializeAttachment({ role: 'mac', at: now, tokens: LIMITS.macRate.burst, refilledAt: now } satisfies MacAttachment)
        const channels = this.live('upstream').flatMap(socket => {
            const state = this.attachment(socket)
            return state?.role === 'upstream' ? [state.channel] : []
        })
        this.tell(server, { type: 'ready', maxConversations: LIMITS.maxConversations, channels })
        await this.schedule()
        return this.upgraded(client)
    }

    private async acceptUpstream(request: Request): Promise<Response> {
        const authorization = request.headers.get(INTERNAL.authorization)
        if (!authorization) return empty(401)
        const mac = this.mac()
        if (!mac) return empty(503)
        if (this.live('upstream').length >= LIMITS.maxConversations) return empty(429)
        const now = relayClock.now(), channel = crypto.randomUUID()
        const { 0: client, 1: server } = new (runtimeGlobals().WebSocketPair)()
        this.ctx.acceptWebSocket(server, ['upstream', `ch:${channel}`])
        server.serializeAttachment({
            role: 'upstream', channel, conversationId: null, openedAt: now, at: now, tokens: LIMITS.upstreamRate.burst, refilledAt: now,
        } satisfies UpstreamAttachment)
        this.tell(mac, { type: 'open', channel, authorization })
        await this.schedule()
        return this.upgraded(client)
    }

    async webSocketMessage(socket: RelaySocket, message: string | ArrayBuffer): Promise<void> {
        const state = this.attachment(socket)
        if (!state || state.closing) return
        if (typeof message !== 'string') return this.shut(socket, CLOSE.unsupported, 'text only')
        if (tooLarge(message, state.role === 'mac' ? LIMITS.macFrameBytes : LIMITS.upstreamFrameBytes)) return this.shut(socket, CLOSE.tooBig, 'too large')
        const now = relayClock.now()
        if (!this.take(state, state.role === 'mac' ? LIMITS.macRate : LIMITS.upstreamRate, now)) {
            socket.serializeAttachment(state)
            return this.shut(socket, CLOSE.rate, 'too many frames')
        }
        state.at = now
        socket.serializeAttachment(state)
        let parsed: unknown
        try { parsed = JSON.parse(message) } catch { return this.shut(socket, CLOSE.invalid, 'not json') }
        if (state.role === 'mac') return this.fromMac(socket, parsed)
        return this.fromUpstream(socket, state, parsed)
    }

    private async fromMac(socket: RelaySocket, parsed: unknown) {
        const message = macMessage(parsed)
        if (!message) return
        if (message.type === 'ping') return void socket.send('{"type":"pong"}')
        if (message.type === 'announce') {
            const now = relayClock.now(), key = `announce:${message.conversationId}`
            const pending = await this.ctx.storage.list<number>({ prefix: 'announce:' })
            let live = 0
            for (const [name, expiresAt] of pending) {
                if (expiresAt <= now) await this.ctx.storage.delete(name)
                else if (name !== key) live++
            }
            if (live >= LIMITS.maxAnnounced) return this.tell(socket, { type: 'refused', conversationId: message.conversationId, reason: 'full' })
            await this.ctx.storage.put(key, now + message.ttlMs)
            await this.schedule()
            return this.tell(socket, { type: 'announced', conversationId: message.conversationId })
        }
        if (message.type === 'withdraw') return void await this.ctx.storage.delete(`announce:${message.conversationId}`)
        const target = this.live(`ch:${message.channel}`)[0]
        if (!target) return
        if (message.type === 'close') return this.shut(target, CLOSE.normal, 'closed by the Mac')
        const state = this.attachment(target)
        // Text reaches ElevenLabs only on a connection bound to a conversation the Mac announced.
        if (state?.role !== 'upstream' || !state.conversationId) return
        try { target.send(JSON.stringify(message.message)) } catch { /* the close handler tidies up */ }
    }

    private async fromUpstream(socket: RelaySocket, state: UpstreamAttachment, parsed: unknown) {
        const mac = this.mac()
        if (!mac) return this.shut(socket, CLOSE.internal, 'mac unavailable')
        const message = upstreamMessage(parsed)
        if (!message) return
        if (message.type === 'ping') return void socket.send('{"type":"pong"}')
        if (!state.conversationId) {
            if (message.type !== 'init') return this.shut(socket, CLOSE.policy, 'init first')
            const key = `announce:${message.conversation_id}`
            if (this.claiming.has(key)) return this.shut(socket, CLOSE.notAnnounced, 'not announced')
            this.claiming.add(key)
            try {
                const expiresAt = await this.ctx.storage.get<number>(key)
                if (expiresAt === undefined || expiresAt <= relayClock.now()) return this.shut(socket, CLOSE.notAnnounced, 'not announced')
                // One connection per announced conversation: the announcement is spent here.
                await this.ctx.storage.delete(key)
            } finally { this.claiming.delete(key) }
            const current = this.attachment(socket)
            if (current?.role !== 'upstream' || current.closing) return
            socket.serializeAttachment({ ...current, conversationId: message.conversation_id })
            return this.tell(mac, { type: 'frame', channel: state.channel, message })
        }
        if (message.type === 'init') return this.shut(socket, CLOSE.policy, 'already started')
        this.tell(mac, { type: 'frame', channel: state.channel, message })
    }

    async webSocketClose(socket: RelaySocket, code: number): Promise<void> {
        const state = this.attachment(socket)
        try { socket.close(code === 1005 || code === 1006 ? CLOSE.normal : code, 'closed') } catch { /* already closed */ }
        // A connection this relay closed itself was already accounted for when it was closed.
        if (!state || state.closing) return
        socket.serializeAttachment({ ...state, closing: true })
        if (state.role === 'upstream') return this.tell(this.mac(), { type: 'closed', channel: state.channel })
        if (state.replaced || this.mac()) return
        // No Mac, no conversation.
        for (const upstream of this.live('upstream')) this.shut(upstream, CLOSE.internal, 'mac unavailable')
    }

    async webSocketError(socket: RelaySocket): Promise<void> {
        await this.webSocketClose(socket, CLOSE.internal)
    }

    async alarm(): Promise<void> {
        const now = relayClock.now()
        for (const prefix of ['announce:', 'nonce:']) {
            for (const [key, expiresAt] of await this.ctx.storage.list<number>({ prefix })) if (expiresAt <= now) await this.ctx.storage.delete(key)
        }
        const lastSeen = (socket: RelaySocket, at: number) => Math.max(at, this.ctx.getWebSocketAutoResponseTimestamp?.(socket)?.getTime() ?? 0)
        for (const socket of this.live('upstream')) {
            const state = this.attachment(socket)
            if (state?.role !== 'upstream') continue
            if ((!state.conversationId && now - state.openedAt > LIMITS.initTimeoutMs) || now - lastSeen(socket, state.at) > LIMITS.upstreamIdleMs) {
                this.shut(socket, CLOSE.timeout, 'idle')
            }
        }
        for (const socket of this.live('mac')) {
            const state = this.attachment(socket)
            if (state && now - lastSeen(socket, state.at) > LIMITS.macIdleMs) this.shut(socket, CLOSE.timeout, 'idle')
        }
        if (!this.mac()) for (const upstream of this.live('upstream')) this.shut(upstream, CLOSE.internal, 'mac unavailable')
        const remaining = (await this.ctx.storage.list({ prefix: 'announce:' })).size + (await this.ctx.storage.list({ prefix: 'nonce:' })).size
        if (this.live('mac').length || this.live('upstream').length || remaining) await this.ctx.storage.setAlarm(now + LIMITS.alarmEveryMs)
    }
}
