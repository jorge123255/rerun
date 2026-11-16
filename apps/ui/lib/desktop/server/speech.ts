import 'server-only'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { transformEngineMessages } from '@/lib/chat/engine-history'
import { getSessionMessages } from '@/lib/engine/client'
import {
    DESKTOP_SPEECH_DEFAULT_VOICE, DESKTOP_SPEECH_KEY_PURPOSE, desktopSpeechBound, desktopSpeechSettingsChangeSchema, desktopSpeechText, desktopSpeechVoiceId,
    type DesktopSpeechSettings, type DesktopSpeechVoice,
} from '../speech'
import { DesktopHttpError } from './auth'
import type { desktopAuxiliaryStore } from './auxiliary/store'
import { boundedText } from './mcp/remote'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { findDesktopAgent, findDesktopSession } from './store'

const API = 'https://api.elevenlabs.io'
/** The endpoint's documented default model: 29 languages, 10,000 characters a request. */
export const DESKTOP_SPEECH_MODEL = 'eleven_multilingual_v2'
export const DESKTOP_SPEECH_OUTPUT = 'mp3_44100_128'
/** Four thousand characters come to a few megabytes of MP3; anything far beyond that is not a reply. */
const MAX_AUDIO_BYTES = 32 * 1024 * 1024

type Store = Pick<ReturnType<typeof desktopAuxiliaryStore>, 'read'>

export const DESKTOP_SPEECH_ERRORS = {
    speech_no_key: 'Add an ElevenLabs key in Settings, under Tool services, to hear replies.',
    speech_key_refused: 'ElevenLabs refused the saved key. Check it in Settings, under Tool services.',
    speech_quota: 'Your ElevenLabs account has no credits left for this.',
    speech_voice_missing: 'ElevenLabs no longer has the chosen voice. Pick another in Settings, under Tool services.',
    speech_busy: 'ElevenLabs is busy right now. Try again in a moment.',
    speech_unreachable: 'ElevenLabs could not be reached. Check your connection and try again.',
    speech_failed: 'ElevenLabs could not read this aloud.',
    speech_nothing: 'This reply has nothing to read aloud.',
} as const
export type DesktopSpeechErrorCode = keyof typeof DESKTOP_SPEECH_ERRORS

function speechError(code: DesktopSpeechErrorCode, message: string = DESKTOP_SPEECH_ERRORS[code]) {
    return new DesktopHttpError(code === 'speech_no_key' ? 409 : code === 'speech_nothing' ? 422 : 502, message, code)
}

const errorReply = z.object({ detail: z.object({ code: z.string().optional(), status: z.string().optional(), type: z.string().optional(), message: z.string().optional() }).passthrough() }).passthrough()

/** What ElevenLabs said, as one plain line. It is their text, shown as text and never acted on. */
function plain(message: string | undefined): string {
    return (message ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
}

/** Turns a refusal from ElevenLabs into one of this app's plain messages. The body is read with a bound. */
export async function desktopSpeechRefusal(response: Response, signal: AbortSignal): Promise<DesktopHttpError> {
    let detail: z.infer<typeof errorReply>['detail'] | undefined
    try { detail = errorReply.parse(JSON.parse(await boundedText(response, signal, 16_000))).detail } catch { void response.body?.cancel().catch(() => {}) }
    const code = detail?.code ?? detail?.status ?? ''
    // Older accounts answer 401 with the status "quota_exceeded"; newer ones answer 402 "insufficient_credits".
    if (response.status === 402 || code === 'insufficient_credits' || code === 'quota_exceeded' || detail?.type === 'payment_required') {
        const said = plain(detail?.message)
        return speechError('speech_quota', said ? `${DESKTOP_SPEECH_ERRORS.speech_quota} ElevenLabs says: ${said}` : undefined)
    }
    if (code === 'voice_not_found' || code === 'invalid_voice_id' || response.status === 404) return speechError('speech_voice_missing')
    if (response.status === 401 || response.status === 403) return speechError('speech_key_refused')
    if (response.status === 429 || response.status === 503) return speechError('speech_busy')
    return speechError('speech_failed')
}

const voicesReply = z.object({
    voices: z.array(z.object({
        voice_id: z.string(), name: z.string().nullish(), category: z.string().nullish(),
        labels: z.record(z.string(), z.unknown()).nullish(),
    }).passthrough()).max(500),
}).passthrough()

/** ElevenLabs' voice list as the picker's rows: valid ids only, named, sorted, at most a hundred. */
export function desktopSpeechVoicesOf(reply: unknown): DesktopSpeechVoice[] {
    const seen = new Set<string>()
    return voicesReply.parse(reply).voices.flatMap(voice => {
        const name = voice.name?.replace(/\s+/g, ' ').trim().slice(0, 120)
        if (!name || !desktopSpeechVoiceId.safeParse(voice.voice_id).success || seen.has(voice.voice_id)) return []
        seen.add(voice.voice_id)
        const labels = voice.labels ?? {}
        const detail = [labels.accent, labels.gender, labels.age, labels.descriptive ?? labels.description, voice.category]
            .flatMap(value => typeof value === 'string' && value.trim() ? [value.replace(/[_\s]+/g, ' ').trim()] : []).join(', ').slice(0, 160)
        return [{ id: voice.voice_id, name, detail }]
    }).sort((left, right) => left.name.localeCompare(right.name)).slice(0, 100)
}

// The voice list is asked for once per saved key while the app runs.
const voiceCache = new Map<string, DesktopSpeechVoice[]>()
export function clearDesktopSpeechVoiceCache() { voiceCache.clear() }

export function desktopSpeechService(store: Store, fetcher: typeof fetch = fetch) {
    async function key() {
        const saved = await store.read(DESKTOP_SPEECH_KEY_PURPOSE)
        if (!saved.key) throw speechError('speech_no_key')
        return saved as { revision: string; key: string }
    }
    async function ask(url: string, init: RequestInit, signal: AbortSignal) {
        let response: Response
        try { response = await fetcher(url, { ...init, signal, redirect: 'error' }) }
        catch {
            signal.throwIfAborted()
            throw speechError('speech_unreachable')
        }
        if (!response.ok) throw await desktopSpeechRefusal(response, signal)
        return response
    }
    return {
        async voices(signal: AbortSignal): Promise<DesktopSpeechVoice[]> {
            const saved = await key()
            const cached = voiceCache.get(saved.revision)
            if (cached) return cached
            const response = await ask(`${API}/v2/voices?page_size=100&include_total_count=false`, { headers: { Accept: 'application/json', 'xi-api-key': saved.key } }, signal)
            let voices: DesktopSpeechVoice[]
            try { voices = desktopSpeechVoicesOf(JSON.parse(await boundedText(response, signal, 4_000_000))) }
            catch { signal.throwIfAborted(); throw speechError('speech_failed') }
            if (voiceCache.size >= 4) voiceCache.clear()
            voiceCache.set(saved.revision, voices)
            return voices
        },
        /** The audio of `text` in the given voice, as ElevenLabs streams it. */
        async speak(text: string, voiceId: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
            if (!text.trim()) throw speechError('speech_nothing')
            const voice = desktopSpeechVoiceId.parse(voiceId)
            const saved = await key()
            const response = await ask(`${API}/v1/text-to-speech/${voice}/stream?output_format=${DESKTOP_SPEECH_OUTPUT}`, {
                method: 'POST',
                headers: { Accept: 'audio/mpeg', 'Content-Type': 'application/json', 'xi-api-key': saved.key },
                body: JSON.stringify({ text, model_id: DESKTOP_SPEECH_MODEL }),
            }, signal)
            // Only audio is passed on, and this app names its type itself. A page or JSON is not a reading of the reply.
            if (!response.body || !/^(?:audio\/|application\/octet-stream)/i.test(response.headers.get('content-type') ?? '')) {
                void response.body?.cancel().catch(() => {})
                throw speechError('speech_failed')
            }
            let bytes = 0
            return response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                    bytes += chunk.byteLength
                    if (bytes > MAX_AUDIO_BYTES) controller.error(new Error('Audio exceeds its limit'))
                    else controller.enqueue(chunk)
                },
            }))
        },
    }
}

export async function readDesktopSpeechSettings(db: Client, store: Store): Promise<DesktopSpeechSettings> {
    const row = (await db.execute('SELECT voice_id, auto_read FROM desktop_speech_settings WHERE id = 1')).rows[0]
    const voice = desktopSpeechVoiceId.safeParse(row?.voice_id)
    // Only whether a key exists is reported. A key that cannot be decrypted counts as none.
    const configured = await store.read(DESKTOP_SPEECH_KEY_PURPOSE).then(saved => !!saved.key, () => false)
    return { configured, voiceId: voice.success ? voice.data : DESKTOP_SPEECH_DEFAULT_VOICE.id, autoRead: Number(row?.auto_read ?? 0) === 1 }
}

export async function changeDesktopSpeechSettings(db: Client, input: unknown): Promise<void> {
    const change = desktopSpeechSettingsChangeSchema.safeParse(input)
    if (!change.success) throw new DesktopHttpError(400, 'Choose a voice or turn automatic reading on or off.')
    const { voiceId, autoRead } = change.data
    await db.execute({
        sql: `INSERT INTO desktop_speech_settings(id, voice_id, auto_read) VALUES(1, :voice, COALESCE(:auto, 0))
              ON CONFLICT(id) DO UPDATE SET
                voice_id = CASE WHEN :setVoice = 1 THEN :voice ELSE voice_id END,
                auto_read = COALESCE(:auto, auto_read)`,
        args: { voice: voiceId ?? null, setVoice: voiceId !== undefined ? 1 : 0, auto: autoRead === undefined ? null : autoRead ? 1 : 0 },
    })
}

/**
 * The words of one saved reply, for speaking. The renderer names the reply; the text comes from the
 * saved conversation, which has to belong to the named coworker.
 */
export async function desktopSpeechReplyText(db: Client, runtime: DesktopRuntime, input: { agentId: string; sessionId: string; messageId: string }, signal?: AbortSignal) {
    const session = await findDesktopSession(db, input.sessionId)
    if (!session || session.agentId !== input.agentId) throw new DesktopHttpError(404, 'Conversation not found')
    const agent = await findDesktopAgent(db, input.agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    let history
    try {
        history = transformEngineMessages(await getSessionMessages(engineOf(runtime), agent.engineAgentId, session.engineSessionId, { requireSuccess: true, signal }), { desktopSummaries: true })
    } catch {
        throw new DesktopHttpError(502, 'This reply could not be loaded. Try again.')
    }
    return desktopSpeechOfSaved(history, input.messageId)
}

/** The spoken form of one saved assistant message among `history`, shortened to the bound. */
export function desktopSpeechOfSaved(history: readonly { id: string; role: string; parts: readonly unknown[] }[], messageId: string) {
    const message = history.find(item => item.id === messageId && item.role === 'assistant')
    if (!message) throw new DesktopHttpError(404, 'Message not found')
    // As on screen: text parts that follow one another are one passage; a step between them starts a new one.
    let markdown = '', afterText = false
    for (const part of message.parts) {
        const text = part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : null
        if (text !== null) markdown += text
        else if (afterText) markdown += '\n\n'
        afterText = text !== null
    }
    const spoken = desktopSpeechText(markdown)
    if (!spoken) throw speechError('speech_nothing')
    return desktopSpeechBound(spoken)
}
