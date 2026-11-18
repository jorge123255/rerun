import { requireOptionalNativeModule } from 'expo'
import { useLocalSearchParams } from 'expo-router'
import { useMemo, useState } from 'react'
import { NativeModules, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslations } from 'use-intl'

import { Composer } from '@/components/chat/Composer'
import { AppText } from '@/components/ui/AppText'
import { PillButton } from '@/components/ui/PillButton'
import { yieldAudio } from '@/lib/audio-yield'
import { spacing } from '@/theme/tokens'
import type { VoiceEngine, VoiceEngineEvents } from '@/voice/engine'
import { watchInterruptions } from '@/voice/interruptions'
import type { VoiceDeps } from '@/voice/useVoiceSession'
import { VoiceScreen } from '@/voice/VoiceScreen'

// Dev only: the Chief of Staff's voice screen with the Mac and the voice service stood in for. Nothing
// here talks to a Mac or to ElevenLabs: the token is made up, and the "conversation" is a script.
//   /lab-voice                  the composer's button, then the screen on a scripted conversation
//   /lab-voice?refuse=not_found the Mac's refusal: not_found | unavailable | send_not_allowed | rate_limited
//   /lab-voice?open=1           opens the screen right away
// The screen's real pieces still run: the microphone permission, pausing the app's audio, the AppState
// and audio interruption watchers. "Load the SDK" reads the ElevenLabs and LiveKit modules (WebRTC's
// globals, the native modules) without starting a session.

const CHAT = 'fmc_00000000-0000-4000-8000-000000000000'

const SCRIPT: { after: number; run: (events: VoiceEngineEvents) => void }[] = [
    { after: 2500, run: events => events.onLine({ from: 'you', text: 'What is on my plate this afternoon?' }) },
    { after: 2000, run: events => events.onMode('speaking') },
    { after: 100, run: events => events.onLine({ from: 'chief', text: 'Two reviews before four, then the launch checklist with Ada.' }) },
    { after: 3500, run: events => events.onMode('listening') },
]

function scriptedEngine(): VoiceEngine {
    return {
        async start(_token, events) {
            const timers: ReturnType<typeof setTimeout>[] = []
            let at = 0
            for (const step of SCRIPT) {
                at += step.after
                timers.push(setTimeout(() => step.run(events), at))
            }
            const started = Date.now()
            const wave = () => 0.35 + 0.3 * Math.sin((Date.now() - started) / 140) * Math.sin((Date.now() - started) / 530)
            return {
                end: async () => timers.forEach(clearTimeout),
                setMuted: () => {},
                inputLevel: wave,
                outputLevel: wave,
            }
        },
    }
}

class LabRefusal extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
    }
}

const STATUS: Record<string, number> = { not_found: 404, unavailable: 503, send_not_allowed: 403, rate_limited: 429 }

function labDeps(refuse: string | undefined): VoiceDeps {
    return {
        requestSession: async () => {
            await new Promise(resolve => setTimeout(resolve, 900))
            if (refuse) throw new LabRefusal(STATUS[refuse] ?? 500, refuse)
            return { conversationToken: 'lab-token-not-real' }
        },
        loadEngine: async () => scriptedEngine(),
        requestMicrophone: async () => (await (await import('expo-audio')).requestRecordingPermissionsAsync()).granted,
        yieldAudio,
        checkPairing: async () => {},
        watchInterruptions,
        onLeavingMac: () => () => {},
    }
}

function nativeReport(): string {
    const bridge = (name: string) => `${name}: ${NativeModules[name] ? 'linked' : 'missing'}`
    const expoModule = (name: string) => `${name}: ${requireOptionalNativeModule(name) ? 'linked' : 'missing'}`
    return [bridge('WebRTCModule'), bridge('LivekitReactNativeModule'), expoModule('AudioInterruption')].join('\n')
}

export default function LabVoice() {
    const insets = useSafeAreaInsets()
    const t = useTranslations('mobileAuth.mac.chief.voice')
    const { refuse, open } = useLocalSearchParams<{ refuse?: string; open?: string }>()
    const deps = useMemo(() => labDeps(refuse), [refuse])
    const [talkingIn, setTalkingIn] = useState<string | null>(open ? CHAT : null)
    const [draft, setDraft] = useState('')
    const [sdk, setSdk] = useState('not loaded')
    const [report, setReport] = useState(nativeReport)

    const loadSdk = async () => {
        setSdk('loading…')
        try {
            await import('@elevenlabs/react-native')
            const client = await import('@elevenlabs/client')
            setSdk(`loaded, VoiceConversation ${typeof client.VoiceConversation.startSession === 'function' ? 'ready' : 'missing'}, RTCPeerConnection ${typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection}`)
        } catch (error) {
            setSdk(`failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        setReport(nativeReport())
    }

    return (
        <View style={{ flex: 1 }}>
            <ScrollView contentContainerStyle={{ paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xl, paddingHorizontal: spacing.lg, gap: spacing.lg }}>
                <AppText variant="title">Voice, Chief of Staff on a Mac</AppText>
                <AppText variant="footnote" tone="muted">
                    {refuse ? `The Mac stand-in refuses with ${refuse}.` : 'The Mac stand-in hands over a made-up token; the conversation is scripted.'}
                </AppText>
                <Composer value={draft} onChangeText={setDraft} onSend={() => setDraft('')} onStop={() => {}} running={false} placeholder="Message the Chief of Staff" canAttach={false} talk={{ label: t('talk'), onPress: () => setTalkingIn(CHAT) }} />
                <AppText variant="footnote" testID="lab-voice-native" style={{ fontFamily: 'GeistMono-Regular' }}>
                    {report}
                </AppText>
                <PillButton label="Load the SDK (no session)" variant="secondary" onPress={() => void loadSdk()} />
                <AppText variant="footnote" testID="lab-voice-sdk">
                    SDK: {sdk}
                </AppText>
            </ScrollView>
            <VoiceScreen chatId={talkingIn} onClose={() => setTalkingIn(null)} deps={deps} />
        </View>
    )
}
