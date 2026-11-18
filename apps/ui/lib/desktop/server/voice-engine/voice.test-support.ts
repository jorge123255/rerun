// Test doubles for the voice conversation: a local ElevenLabs (it makes engines, mints conversation
// tokens and signs its connection tokens the way ElevenLabs documents), a relay that behaves like
// cloud-voice-relay for the Mac's one connection, and a Chief of Staff whose replies are scripted.
import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { VoiceSendRefused, type VoiceChief, type VoiceReplyChunk, type VoiceReplyWatcher, type VoiceSendRefusal } from './conversation'
import type { RelaySocketLike } from './relay-client'
import { RELAY_AUTH_HEADER, relaySigningInput } from './relay-protocol'
import { SPEECH_ENGINE_ISSUER, SPEECH_ENGINE_SUBJECT } from './jwt'

export const API_KEY = 'sk_test_voice_key_0123456789abcdef'
export const OTHER_KEY = 'sk_test_someone_else_0123456789ab'

export function signSpeechEngineToken(apiKey: string, claims: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }) {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const payload = { iss: SPEECH_ENGINE_ISSUER, sub: SPEECH_ENGINE_SUBJECT, iat: nowSeconds, exp: nowSeconds + 60, ...claims }
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const body = `${encode(header)}.${encode(payload)}`
    const secret = createHash('sha256').update(apiKey).digest()
    return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

/** ElevenLabs' REST side, as a fetch. */
export function fakeElevenLabsApi(options: { refuseRetentionZero?: boolean; ignorePrivacy?: boolean } = {}) {
    const requests: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = []
    const minted: string[] = []
    const remoteAudio = {
        tts: { voice_id: 'LegacyVoice1234' }, conversation: { client_events: ['audio', 'vad_score'] }, vad: { background_voice_detection: false },
    }
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const headers = Object.fromEntries(new Headers(init?.headers).entries())
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
        requests.push({ url: url.toString(), method: init?.method ?? 'GET', headers, body })
        if (headers['xi-api-key'] !== API_KEY) return Response.json({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, { status: 401 })
        if (url.pathname === '/v1/speech-engine' && init?.method === 'POST') {
            if (options.refuseRetentionZero && body.privacy.retention_days === 0) return Response.json({ detail: [{ loc: ['privacy'], msg: 'retention', type: 'value_error' }] }, { status: 422 })
            Object.assign(remoteAudio, { tts: body.tts, conversation: body.conversation, vad: body.vad })
            return Response.json({
                speech_engine_id: 'seng_test0001', name: body.name, speech_engine: body.speech_engine,
                auth: { enable_auth: options.ignorePrivacy ? false : body.auth.enable_auth }, privacy: { record_voice: options.ignorePrivacy ? true : body.privacy.record_voice },
            }, { status: 201 })
        }
        if (url.pathname === '/v1/speech-engine/seng_test0001' && (init?.method === 'PATCH' || init?.method === 'GET')) {
            if (init.method === 'PATCH') Object.assign(remoteAudio, body)
            return Response.json({ speech_engine_id: 'seng_test0001', auth: { enable_auth: true }, privacy: { record_voice: false }, ...remoteAudio })
        }
        if (url.pathname === '/v1/convai/conversation/token') {
            const conversationId = `conv_${randomUUID().replace(/-/g, '')}`
            minted.push(conversationId)
            return Response.json({ token: `webrtc-token-${minted.length}`, conversation_id: conversationId })
        }
        return Response.json({ detail: { message: 'not found' } }, { status: 404 })
    }) as typeof fetch
    return { fetcher, requests, minted, remoteAudio }
}

type Sent = { channel: string; message: { type: string; content?: string; event_id?: number; is_final?: boolean } }

/**
 * The relay, as the Mac sees it over its one connection: it checks the Mac's signature, says ready,
 * accepts announcements, and stands in for ElevenLabs connections coming through it.
 */
export function fakeRelay(secret: () => string) {
    const outgoing: Sent[] = []
    const closedByMac: string[] = []
    const announced = new Set<string>()
    const frames: string[] = []
    let socket: (RelaySocketLike & { deliver(value: unknown): void; drop(): void }) | null = null
    let connections = 0, refused = 0
    const headersSeen: Record<string, string>[] = []
    let accept = true

    function factory(url: string, headers: Record<string, string>): RelaySocketLike {
        connections++
        headersSeen.push(headers)
        const parsed = new URL(url)
        const [, timestamp, nonce, signature] = /^v1\.(\d+)\.([^.]+)\.(.+)$/.exec(headers[RELAY_AUTH_HEADER] ?? '') ?? []
        const expected = timestamp && createHmac('sha256', Buffer.from(secret(), 'base64url'))
            .update(relaySigningInput(parsed.pathname.split('/')[2], parsed.host, parsed.pathname, Number(timestamp), nonce)).digest('base64url')
        const authorized = accept && !!expected && expected === signature && Math.abs(Date.now() / 1000 - Number(timestamp)) <= 30
        const created: RelaySocketLike & { deliver(value: unknown): void; drop(): void } = {
            readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
            send(data: string) {
                frames.push(data)
                const message = JSON.parse(data)
                if (message.type === 'announce') { announced.add(message.conversationId); return created.deliver({ type: 'announced', conversationId: message.conversationId }) }
                if (message.type === 'send') return void outgoing.push({ channel: message.channel, message: message.message })
                if (message.type === 'close') return void closedByMac.push(message.channel)
                if (message.type === 'ping') return created.deliver({ type: 'pong' })
            },
            close() { if (created.readyState !== 3) { (created as { readyState: number }).readyState = 3; queueMicrotask(() => created.onclose?.({})) } },
            deliver(value: unknown) { queueMicrotask(() => { if (created.readyState === 1) created.onmessage?.({ data: JSON.stringify(value) }) }) },
            drop() { created.close() },
        }
        setTimeout(() => {
            if (!authorized) { refused++; (created as { readyState: number }).readyState = 3; created.onerror?.({}); created.onclose?.({}); return }
            ;(created as { readyState: number }).readyState = 1
            socket = created
            created.onopen?.({})
            created.deliver({ type: 'ready', maxConversations: 2, channels: [] })
        }, 1)
        return created
    }

    return {
        factory, outgoing, closedByMac, announced, frames, headersSeen,
        get connections() { return connections },
        get refused() { return refused },
        get open() { return socket?.readyState === 1 },
        refuseNext() { accept = false },
        acceptAgain() { accept = true },
        dropMac() { socket?.drop() },
        /** ElevenLabs opening a conversation through the relay. */
        elevenlabs(authorization: string) {
            const channel = randomUUID()
            socket?.deliver({ type: 'open', channel, authorization })
            return {
                channel,
                send(message: unknown) { socket?.deliver({ type: 'frame', channel, message }) },
                close() { socket?.deliver({ type: 'closed', channel }) },
                responses: () => outgoing.filter(item => item.channel === channel).map(item => item.message),
                closedByMac: () => closedByMac.includes(channel),
            }
        },
    }
}

type Script = (input: { text: string; emit(chunk: VoiceReplyChunk): void; end(): void; signal: AbortSignal }) => Promise<void> | void

/** A Chief of Staff conversation whose replies follow `script`. Keeps the full text of every reply, as the conversation would. */
export function fakeChief(script: Script, refusals: VoiceSendRefusal[] = []) {
    const watchers = new Map<string, VoiceReplyWatcher>()
    const sent: { chat: DesktopForemanChatRef; requestId: string; text: string }[] = []
    const replies: string[] = []
    const stops: DesktopForemanChatRef[] = []
    let running: AbortController | null = null
    const chief: VoiceChief & { assertChat(chat: DesktopForemanChatRef): Promise<void> } = {
        async assertChat(chat) { if (chat.chatId === 'fmc_missing0000') throw Object.assign(new Error('Not found'), { status: 404 }) },
        async send(chat, requestId, text) {
            const refusal = refusals.shift()
            if (refusal) throw new VoiceSendRefused(refusal)
            sent.push({ chat, requestId, text })
            const controller = new AbortController()
            running = controller
            let full = ''
            replies.push('')
            const index = replies.length - 1
            queueMicrotask(() => void Promise.resolve(script({
                text,
                signal: controller.signal,
                emit(chunk) {
                    if (controller.signal.aborted) return
                    if (chunk.type === 'text') { full += chunk.delta; replies[index] = full }
                    watchers.get(requestId)?.chunk(chunk)
                },
                end() { watchers.get(requestId)?.end() },
            })).catch(() => {}))
            return { runId: requestId }
        },
        async stop(chat) {
            stops.push(chat)
            running?.abort()
        },
        async watch(runId, watcher) {
            watchers.set(runId, watcher)
            return () => { watchers.delete(runId) }
        },
    }
    return { chief, sent, replies, stops }
}

export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
export async function until(check: () => boolean, ms = 2_000) {
    const started = Date.now()
    while (!check()) {
        if (Date.now() - started > ms) throw new Error('timed out')
        await delay(5)
    }
}
