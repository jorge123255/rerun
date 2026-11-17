// What the relay says to the Mac and to ElevenLabs. The Mac's side lives in
// apps/ui/lib/desktop/server/voice-engine/relay-protocol.ts and must stay in step with this file.

export const RELAY_PROTOCOL = 'rerun-voice-relay-v1'

export const LIMITS = {
    maxConversations: 2,
    maxAnnounced: 8,
    announceTtlMaxMs: 5 * 60_000,
    upstreamFrameBytes: 128 * 1024,
    macFrameBytes: 64 * 1024,
    agentContentChars: 8_000,
    transcriptEntries: 400,
    upstreamRate: { burst: 20, perSecond: 10 },
    macRate: { burst: 120, perSecond: 60 },
    initTimeoutMs: 15_000,
    upstreamIdleMs: 120_000,
    macIdleMs: 75_000,
    authWindowSeconds: 30,
    authorizationMaxChars: 4096,
    alarmEveryMs: 10_000,
} as const

export const CLOSE = {
    normal: 1000,
    unsupported: 1003,
    invalid: 1007,
    policy: 1008,
    tooBig: 1009,
    internal: 1011,
    notAnnounced: 4403,
    timeout: 4408,
    replaced: 4409,
    rate: 4429,
} as const

export const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/
export const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type TranscriptEntry = { role: 'user' | 'agent'; content: string }

/** What ElevenLabs may send, reduced to the fields this relay passes on. Anything else is dropped. */
export type UpstreamMessage =
    | { type: 'init'; conversation_id: string }
    | { type: 'user_transcript'; user_transcript: TranscriptEntry[]; event_id?: number }
    | { type: 'ping' }
    | { type: 'close' }
    | { type: 'error'; message: string }

/** What the Mac may have the relay say to ElevenLabs. */
export type DownstreamMessage =
    | { type: 'agent_response'; content: string; event_id?: number; is_final: boolean }
    | { type: 'pong' }

export type MacToRelay =
    | { type: 'announce'; conversationId: string; ttlMs: number }
    | { type: 'withdraw'; conversationId: string }
    | { type: 'send'; channel: string; message: DownstreamMessage }
    | { type: 'close'; channel: string }
    | { type: 'ping' }

export type RelayToMac =
    | { type: 'ready'; maxConversations: number; channels: string[] }
    | { type: 'announced'; conversationId: string }
    | { type: 'refused'; conversationId: string; reason: 'invalid' | 'full' }
    | { type: 'open'; channel: string; authorization: string }
    | { type: 'frame'; channel: string; message: UpstreamMessage }
    | { type: 'closed'; channel: string }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const eventId = (value: unknown) => value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0)

export function upstreamMessage(value: unknown): UpstreamMessage | null {
    if (!object(value)) return null
    switch (value.type) {
        case 'init':
            return typeof value.conversation_id === 'string' && CONVERSATION_ID.test(value.conversation_id) ? { type: 'init', conversation_id: value.conversation_id } : null
        case 'user_transcript': {
            const entries = value.user_transcript
            if (!Array.isArray(entries) || entries.length > LIMITS.transcriptEntries || !eventId(value.event_id)) return null
            const transcript: TranscriptEntry[] = []
            for (const entry of entries) {
                if (!object(entry) || (entry.role !== 'user' && entry.role !== 'agent') || typeof entry.content !== 'string') return null
                transcript.push({ role: entry.role, content: entry.content })
            }
            return { type: 'user_transcript', user_transcript: transcript, ...(value.event_id !== undefined && { event_id: value.event_id as number }) }
        }
        case 'ping': return { type: 'ping' }
        case 'close': return { type: 'close' }
        case 'error': return { type: 'error', message: typeof value.message === 'string' ? value.message.slice(0, 200) : '' }
        default: return null
    }
}

export function downstreamMessage(value: unknown): DownstreamMessage | null {
    if (!object(value)) return null
    if (value.type === 'pong') return { type: 'pong' }
    if (value.type !== 'agent_response' || typeof value.content !== 'string' || value.content.length > LIMITS.agentContentChars
        || typeof value.is_final !== 'boolean' || !eventId(value.event_id)) return null
    return { type: 'agent_response', content: value.content, ...(value.event_id !== undefined && { event_id: value.event_id as number }), is_final: value.is_final }
}

export function macMessage(value: unknown): MacToRelay | null {
    if (!object(value)) return null
    switch (value.type) {
        case 'announce':
            return typeof value.conversationId === 'string' && CONVERSATION_ID.test(value.conversationId)
                && Number.isSafeInteger(value.ttlMs) && (value.ttlMs as number) > 0
                ? { type: 'announce', conversationId: value.conversationId, ttlMs: Math.min(value.ttlMs as number, LIMITS.announceTtlMaxMs) } : null
        case 'withdraw':
            return typeof value.conversationId === 'string' && CONVERSATION_ID.test(value.conversationId) ? { type: 'withdraw', conversationId: value.conversationId } : null
        case 'send': {
            const message = downstreamMessage(value.message)
            return typeof value.channel === 'string' && CHANNEL_ID.test(value.channel) && message ? { type: 'send', channel: value.channel, message } : null
        }
        case 'close':
            return typeof value.channel === 'string' && CHANNEL_ID.test(value.channel) ? { type: 'close', channel: value.channel } : null
        case 'ping': return { type: 'ping' }
        default: return null
    }
}
