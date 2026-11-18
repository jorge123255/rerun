// The voice session itself: the phone's microphone and speaker talk to the voice service (ElevenLabs)
// over WebRTC with the token the Mac handed over. The service sends what was heard to the Mac, which
// answers as the Chief of Staff, and speaks the answer. The screen only sees this small interface, so
// the tests and the lab run it without any network.

import type { Callbacks } from '@elevenlabs/client'

import type { PartialCaption, VoiceLine } from './transcript'

export type VoiceMode = 'listening' | 'speaking'

export type VoiceEngineEvents = {
    onMode: (mode: VoiceMode) => void
    onLine: (line: VoiceLine) => void
    onPartial: (caption: PartialCaption) => void
    onCorrection: (line: VoiceLine) => void
    // The other side ended the conversation, or the connection broke. Never called for `end()`.
    onEnd: (why: 'agent' | 'error') => void
}

export type VoiceEngineSession = {
    end: () => Promise<void>
    // Muted, the microphone track is muted at the source: no audio leaves the phone.
    setMuted: (muted: boolean) => void
    inputLevel: () => number
    outputLevel: () => number
}

export type VoiceEngine = {
    start: (conversationToken: string, events: VoiceEngineEvents) => Promise<VoiceEngineSession>
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

// The pinned SDK sends committed words to onMessage. Partial user transcripts are a separate
// Speech Engine protocol event, delivered through the SDK's incoming-event callback.
export function voiceCallbacks(events: VoiceEngineEvents): Partial<Callbacks> {
    return {
        onModeChange: ({ mode }) => events.onMode(mode),
        onIncomingEvent: (raw: unknown) => {
            if (!isRecord(raw) || raw.type !== 'tentative_user_transcript') return
            const caption = raw.tentative_user_transcription_event
            if (!isRecord(caption) || typeof caption.user_transcript !== 'string') return
            if (typeof caption.event_id !== 'number' || !Number.isSafeInteger(caption.event_id) || caption.event_id < 0) return
            events.onPartial({ eventId: caption.event_id, text: caption.user_transcript.trim() })
        },
        onMessage: ({ role, message, event_id, response_id }) => {
            // The Mac treats punctuation-only user transcripts as silence. Clear the preview
            // without displaying those as words or making the orb wait for a nonexistent reply.
            const text = role === 'user' && !/[\p{L}\p{N}]/u.test(message) ? '' : message.trim()
            events.onLine({ from: role === 'user' ? 'you' : 'chief', text, eventId: event_id, responseId: response_id })
        },
        onAgentResponseCorrection: ({ corrected_agent_response, event_id, response_id }) => {
            events.onCorrection({ from: 'chief', text: corrected_agent_response.trim(), eventId: event_id, responseId: response_id })
        },
        onError: message => {
            // setMicMuted reports asynchronous failures here. End the call if source mute failed.
            if (message === 'Failed to set input muted state') events.onEnd('error')
        },
        onDisconnect: details => {
            if (details.reason !== 'user') events.onEnd(details.reason)
        },
    }
}

// Loaded on the first conversation, not at launch: the React Native SDK installs WebRTC's globals and
// polyfills, and its own audio session setup, when it is first read, and nothing else in the app should
// run with them before someone talks. The session itself is the client's, driven without React.
export async function loadElevenLabsEngine(): Promise<VoiceEngine> {
    await import('@elevenlabs/react-native')
    const [sdk, livekit] = await Promise.all([import('@elevenlabs/client'), import('livekit-client')])
    // Quiet: the connection's debug lines are nobody's business in the device log.
    livekit.setLogLevel('error')
    return {
        async start(conversationToken, events) {
            const conversation = await sdk.VoiceConversation.startSession({
                conversationToken,
                connectionType: 'webrtc',
                ...voiceCallbacks(events),
            })
            return {
                end: () => conversation.endSession(),
                setMuted: muted => conversation.setMicMuted(muted),
                inputLevel: () => conversation.getInputVolume(),
                outputLevel: () => conversation.getOutputVolume(),
            }
        },
    }
}
