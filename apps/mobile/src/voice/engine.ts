// The voice session itself: the phone's microphone and speaker talk to the voice service (ElevenLabs)
// over WebRTC with the token the Mac handed over. The service sends what was heard to the Mac, which
// answers as the Chief of Staff, and speaks the answer. The screen only sees this small interface, so
// the tests and the lab run it without any network.

export type VoiceMode = 'listening' | 'speaking'

export type VoiceLine = { from: 'you' | 'chief'; text: string }

export type VoiceEngineEvents = {
    onMode: (mode: VoiceMode) => void
    onLine: (line: VoiceLine) => void
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
                onModeChange: ({ mode }) => events.onMode(mode),
                onMessage: ({ role, message }) => {
                    if (message.trim()) events.onLine({ from: role === 'user' ? 'you' : 'chief', text: message.trim() })
                },
                onDisconnect: details => {
                    if (details.reason !== 'user') events.onEnd(details.reason)
                },
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
