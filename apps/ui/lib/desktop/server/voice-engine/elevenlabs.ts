import 'server-only'
import { z } from 'zod'
import { DesktopHttpError } from '../auth'
import { boundedText } from '../mcp/remote'
import { desktopSpeechRefusal } from '../speech'

const API = 'https://api.elevenlabs.io'

// How the engine is made. Recording off, and the shortest retention ElevenLabs accepts: 0 schedules
// deletion, and 1 day is tried if that is refused. ElevenLabs waits up to 15 seconds for the first
// words of a reply, the longest it allows; the Mac says "One moment." after two.
export const VOICE_ENGINE_SETTINGS = {
    name: 'Rerun Chief of Staff',
    maxDurationSeconds: 600,
    cascadeTimeoutSeconds: 15,
    retentionDays: [0, 1],
} as const

const engineReply = z.object({
    speech_engine_id: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/),
    auth: z.object({ enable_auth: z.boolean() }).passthrough(),
    privacy: z.object({ record_voice: z.boolean() }).passthrough(),
}).passthrough()
const tokenReply = z.object({
    token: z.string().min(1).max(8192),
    conversation_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
}).passthrough()

const requiredEvents = ['audio', 'interruption', 'user_transcript', 'tentative_user_transcript', 'agent_response', 'agent_response_correction']
function audioSettings(voiceId: string) {
    return {
        tts: { voice_id: voiceId },
        vad: { background_voice_detection: true },
        conversation: { max_duration_seconds: VOICE_ENGINE_SETTINGS.maxDurationSeconds, client_events: requiredEvents },
    }
}

const audioReply = engineReply.extend({
    tts: z.object({ voice_id: z.string() }),
    conversation: z.object({ client_events: z.array(z.string()) }),
    vad: z.object({ background_voice_detection: z.boolean().optional() }).optional(),
})

export function engineRequestBody(input: { wsUrl: string; voiceId: string; retentionDays: number }) {
    return {
        name: VOICE_ENGINE_SETTINGS.name,
        speech_engine: { ws_url: input.wsUrl },
        ...audioSettings(input.voiceId),
        privacy: { record_voice: false, retention_days: input.retentionDays },
        auth: { enable_auth: true },
        cascade_timeout_seconds: VOICE_ENGINE_SETTINGS.cascadeTimeoutSeconds,
    }
}

const unreachable = () => new DesktopHttpError(502, 'ElevenLabs could not be reached. Check your connection and try again.', 'speech_unreachable')
const unexpected = () => new DesktopHttpError(502, 'ElevenLabs answered in a way this app does not understand.', 'speech_failed')

/** Talks to ElevenLabs only when the owner sets up or uses the feature, with the key the Mac already holds. */
export function voiceEngineApi(fetcher: typeof fetch = fetch) {
    async function call(path: string, init: RequestInit, apiKey: string, signal: AbortSignal) {
        let response: Response
        try {
            response = await fetcher(`${API}${path}`, { ...init, headers: { ...init.headers, Accept: 'application/json', 'xi-api-key': apiKey }, signal, redirect: 'error' })
        } catch {
            signal.throwIfAborted()
            throw unreachable()
        }
        return response
    }
    async function json(response: Response, signal: AbortSignal) {
        try { return JSON.parse(await boundedText(response, signal, 1_000_000)) } catch { signal.throwIfAborted(); throw unexpected() }
    }
    return {
        async createEngine(input: { apiKey: string; wsUrl: string; voiceId: string }, signal: AbortSignal): Promise<{ engineId: string }> {
            for (const [index, retentionDays] of VOICE_ENGINE_SETTINGS.retentionDays.entries()) {
                const response = await call('/v1/speech-engine', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(engineRequestBody({ wsUrl: input.wsUrl, voiceId: input.voiceId, retentionDays })),
                }, input.apiKey, signal)
                if (response.status === 422 && index < VOICE_ENGINE_SETTINGS.retentionDays.length - 1) {
                    void response.body?.cancel().catch(() => {})
                    continue
                }
                if (!response.ok) throw await desktopSpeechRefusal(response, signal)
                const parsed = engineReply.safeParse(await json(response, signal))
                if (!parsed.success) throw unexpected()
                // An engine anyone could start, or one that records, is not the one asked for.
                if (!parsed.data.auth.enable_auth || parsed.data.privacy.record_voice) {
                    throw new DesktopHttpError(502, 'ElevenLabs made the voice engine without the private settings this app asks for. Delete it in your ElevenLabs account and try again.', 'speech_failed')
                }
                return { engineId: parsed.data.speech_engine_id }
            }
            throw unexpected()
        },
        async updateAudio(input: { apiKey: string; engineId: string; voiceId: string }, signal: AbortSignal): Promise<void> {
            const path = `/v1/speech-engine/${encodeURIComponent(input.engineId)}`
            async function readPrivateEngine(response: Response) {
                if (!response.ok) throw await desktopSpeechRefusal(response, signal)
                const result = audioReply.safeParse(await json(response, signal))
                if (!result.success || result.data.speech_engine_id !== input.engineId ||
                    !result.data.auth.enable_auth || result.data.privacy.record_voice) throw unexpected()
                return result.data
            }
            const current = await readPrivateEngine(await call(path, { method: 'GET' }, input.apiKey, signal))
            // Preserve the owner's additional events and duration, and only request the VAD filter on
            // engines that expose it. Some API versions return an empty VAD configuration.
            const events = [...new Set([...current.conversation.client_events, ...requiredEvents])]
            const needsFilter = current.vad?.background_voice_detection === false
            if (current.tts.voice_id === input.voiceId && !needsFilter && requiredEvents.every(event => current.conversation.client_events.includes(event))) return
            const updated = await readPrivateEngine(await call(path, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tts: { voice_id: input.voiceId }, conversation: { client_events: events },
                    ...(needsFilter && { vad: { background_voice_detection: true } }),
                }),
            }, input.apiKey, signal))
            if (updated.tts.voice_id !== input.voiceId || !events.every(event => updated.conversation.client_events.includes(event))) throw unexpected()
        },
        /** A short-lived token for the phone and the id of the conversation it opens. */
        async conversationToken(input: { apiKey: string; engineId: string }, signal: AbortSignal): Promise<{ token: string; conversationId: string }> {
            const response = await call(`/v1/convai/conversation/token?agent_id=${encodeURIComponent(input.engineId)}`, { method: 'GET' }, input.apiKey, signal)
            if (!response.ok) throw await desktopSpeechRefusal(response, signal)
            const parsed = tokenReply.safeParse(await json(response, signal))
            if (!parsed.success) throw unexpected()
            return { token: parsed.data.token, conversationId: parsed.data.conversation_id }
        },
    }
}
export type VoiceEngineApi = ReturnType<typeof voiceEngineApi>
