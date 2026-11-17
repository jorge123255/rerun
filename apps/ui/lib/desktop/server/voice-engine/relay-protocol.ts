import 'server-only'
import { createHmac, randomBytes } from 'node:crypto'
import { z } from 'zod'

// The Mac's half of cloud-voice-relay/src/protocol.ts and src/auth.ts. Both are tested against
// the same fixed signature vector.
export const RELAY_PROTOCOL = 'rerun-voice-relay-v1'
export const RELAY_AUTH_HEADER = 'x-rerun-relay-auth'
export const RELAY_SECRET = /^[A-Za-z0-9_-]{43}$/
export const RELAY_INSTALL_ID = RELAY_SECRET

export function relaySigningInput(installId: string, host: string, path: string, timestamp: number, nonce: string): string {
    return [RELAY_PROTOCOL, installId, host.toLowerCase(), path, String(timestamp), nonce].join('\n')
}

/** The header that proves this Mac holds the install's secret, for one connection to `url`. */
export function relayAuthHeader(input: { secret: string; installId: string; url: URL; nowMs: number; nonce?: string }): string {
    const timestamp = Math.floor(input.nowMs / 1000), nonce = input.nonce ?? randomBytes(16).toString('base64url')
    const key = Buffer.from(input.secret, 'base64url')
    try {
        const signature = createHmac('sha256', key).update(relaySigningInput(input.installId, input.url.host, input.url.pathname, timestamp, nonce)).digest('base64url')
        return `v1.${timestamp}.${nonce}.${signature}`
    } finally { key.fill(0) }
}

export const relayMacUrl = (origin: string, installId: string) => new URL(`/v1/${installId}/mac`, origin.replace(/^https:/, 'wss:'))
export const relaySpeechEngineUrl = (origin: string, installId: string) => new URL(`/v1/${installId}/speech-engine`, origin.replace(/^https:/, 'wss:')).toString()

const channel = z.string().uuid()
const conversationId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const transcriptEntry = z.object({ role: z.enum(['user', 'agent']), content: z.string() })
export const upstreamMessageSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('init'), conversation_id: conversationId }),
    z.object({ type: z.literal('user_transcript'), user_transcript: z.array(transcriptEntry).max(400), event_id: z.number().int().nonnegative().optional() }),
    z.object({ type: z.literal('ping') }),
    z.object({ type: z.literal('close') }),
    z.object({ type: z.literal('error'), message: z.string().optional() }),
])
export type UpstreamMessage = z.infer<typeof upstreamMessageSchema>
export type AgentResponse = { type: 'agent_response'; content: string; event_id?: number; is_final: boolean }
export type DownstreamMessage = AgentResponse | { type: 'pong' }

export const relayToMacSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('ready'), maxConversations: z.number().int().positive(), channels: z.array(channel).max(16) }),
    z.object({ type: z.literal('announced'), conversationId }),
    z.object({ type: z.literal('refused'), conversationId, reason: z.string() }),
    z.object({ type: z.literal('open'), channel, authorization: z.string().min(1).max(4096) }),
    z.object({ type: z.literal('frame'), channel, message: z.unknown() }),
    z.object({ type: z.literal('closed'), channel }),
    z.object({ type: z.literal('pong') }),
])
export type RelayToMac = z.infer<typeof relayToMacSchema>

/** The longest single agent_response the relay passes on. */
export const AGENT_CONTENT_LIMIT = 8_000
