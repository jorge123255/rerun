import { useRef } from 'react'
import { Linking, Modal, Pressable, ScrollView, type ScrollViewInstance, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslations } from 'use-intl'

import { AppText } from '@/components/ui/AppText'
import { Icon, type IconName } from '@/components/ui/Icon'
import { PillButton } from '@/components/ui/PillButton'
import * as Haptics from '@/lib/haptics'
import { useTheme } from '@/theme/theme'
import { spacing } from '@/theme/tokens'

import { canRetry } from './problems'
import { useVoiceSession, type VoiceDeps } from './useVoiceSession'
import type { Transcript } from './transcript'
import { VoiceOrb } from './VoiceOrb'
import { VoiceChoice } from './VoiceChoice'

const ORB_SIZE = 168
const CONTROL = 64

// iPad turns with the person; a phone stays upright, as the app does.
const ORIENTATIONS = ['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right'] as const

type VoiceScreenProps = {
    // The Chief of Staff conversation to talk in; null keeps the screen shut.
    chatId: string | null
    onClose: () => void
    deps: VoiceDeps
}

// Talking with the Chief of Staff, over the whole screen. The microphone is open only while it is up.
export function VoiceScreen({ chatId, onClose, deps }: VoiceScreenProps) {
    return (
        <Modal visible={chatId !== null} animationType="fade" presentationStyle="fullScreen" supportedOrientations={[...ORIENTATIONS]} onRequestClose={onClose}>
            {chatId !== null && <VoiceConversation key={chatId} chatId={chatId} onClose={onClose} deps={deps} />}
        </Modal>
    )
}

function RoundControl({ symbol, label, onPress, tone, disabled = false, testID }: { symbol: IconName; label: string; onPress: () => void; tone: 'plain' | 'on' | 'end'; disabled?: boolean; testID?: string }) {
    const theme = useTheme()
    const background = tone === 'end' ? theme.destructive : tone === 'on' ? theme.foreground : theme.muted
    const tint = tone === 'end' ? '#ffffff' : tone === 'on' ? theme.background : theme.foreground
    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            hitSlop={8}
            style={({ pressed }) => ({ width: CONTROL, height: CONTROL, borderRadius: CONTROL / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: background, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 })}
        >
            <Icon name={symbol} size={24} bold color={tint} />
        </Pressable>
    )
}

function TranscriptLines({ transcript }: { transcript: Transcript }) {
    const t = useTranslations('mobileAuth.mac.chief.voice')
    const scroll = useRef<ScrollViewInstance>(null)
    const followLatest = useRef(true)
    return (
        <ScrollView
            testID="voice-lines"
            ref={scroll}
            style={{ flexGrow: 0, maxHeight: '48%', width: '100%', maxWidth: 420 }}
            contentContainerStyle={{ gap: spacing.md, paddingVertical: spacing.sm }}
            scrollEventThrottle={32}
            onScroll={({ nativeEvent }) => {
                followLatest.current = nativeEvent.contentOffset.y + nativeEvent.layoutMeasurement.height >= nativeEvent.contentSize.height - 32
            }}
            onContentSizeChange={() => { if (followLatest.current) scroll.current?.scrollToEnd({ animated: false }) }}
        >
            {transcript.lines.map(line => (
                <View key={line.from + ':' + (line.responseId ?? line.eventId)}>
                    <AppText variant="footnote" tone="muted" medium>{t(line.from === 'you' ? 'you' : 'chief')}</AppText>
                    <AppText variant="callout">{line.text}</AppText>
                </View>
            ))}
            {transcript.partial && (
                <View testID="voice-live-transcript">
                    <AppText variant="footnote" tone="muted" medium>{t('liveCaption')}</AppText>
                    <AppText variant="callout">{transcript.partial.text}</AppText>
                </View>
            )}
        </ScrollView>
    )
}

function VoiceConversation({ chatId, onClose, deps }: { chatId: string; onClose: () => void; deps: VoiceDeps }) {
    const theme = useTheme()
    const insets = useSafeAreaInsets()
    const t = useTranslations('mobileAuth.mac.chief.voice')
    const voice = useVoiceSession(chatId, deps)
    const hasTranscript = voice.transcript.lines.length > 0 || voice.transcript.partial !== null
    const live = voice.phase === 'live'
    const over = voice.phase === 'ended' || voice.phase === 'failed'

    const close = async () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
        await voice.close()
        onClose()
    }

    const toggleMute = () => {
        Haptics.selectionAsync()
        voice.setMuted(!voice.muted)
    }

    const caption = (() => {
        if (voice.phase === 'starting') return t('connecting')
        if (voice.phase === 'failed' && voice.problem) return t(`problems.${voice.problem}`)
        if (voice.phase === 'ended' && voice.ending) return t(`ended.${voice.ending}`)
        if (voice.orb === 'speaking') return t('speaking')
        if (voice.orb === 'thinking') return t('thinking')
        return voice.muted ? t('muted') : t('listening')
    })()

    // The microphone is open: said in words and with a dot, whatever the orb is doing.
    const micOpen = live && !voice.muted

    return (
        <View testID="voice-screen" style={{ flex: 1, backgroundColor: theme.background, paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg, paddingHorizontal: spacing.xl }}>
            <View style={{ alignItems: 'center', gap: spacing.xs }}>
                <AppText variant="headline">{t('chief')}</AppText>
                {deps.voiceChoice && <VoiceChoice controls={deps.voiceChoice} />}
                <View testID="voice-mic-on" style={{ flexDirection: 'row', alignItems: 'center', gap: 6, opacity: micOpen ? 1 : 0 }} accessibilityElementsHidden={!micOpen} importantForAccessibility={micOpen ? 'yes' : 'no-hide-descendants'}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.destructive }} />
                    <AppText variant="footnote" tone="muted">
                        {t('micOn')}
                    </AppText>
                </View>
            </View>

            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.xl }}>
                <VoiceOrb size={hasTranscript ? ORB_SIZE / 2 : ORB_SIZE} state={voice.orb} level={voice.level} />
                <AppText testID="voice-caption" variant={over ? 'callout' : 'title'} tone={voice.phase === 'failed' ? 'destructive' : 'default'} accessibilityLiveRegion="polite" style={{ textAlign: 'center', maxWidth: 420 }}>
                    {caption}
                </AppText>
                {hasTranscript && <TranscriptLines transcript={voice.transcript} />}
                {over && (
                    <View style={{ flexDirection: 'row', gap: spacing.md }}>
                        {voice.problem === 'microphone' && <PillButton label={t('openSettings')} variant="secondary" onPress={() => void Linking.openSettings()} />}
                        {voice.problem && canRetry(voice.problem) && <PillButton label={t('tryAgain')} variant="secondary" onPress={() => void voice.retry()} />}
                    </View>
                )}
            </View>

            <View style={{ gap: spacing.lg, alignItems: 'center' }}>
                <View style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.xxl }}>
                    {!over && <RoundControl testID="voice-mute" symbol="mic" label={voice.muted ? t('unmute') : t('mute')} tone={voice.muted ? 'on' : 'plain'} disabled={!live} onPress={toggleMute} />}
                    <RoundControl testID="voice-close" symbol="x" label={over ? t('done') : t('close')} tone={over ? 'plain' : 'end'} onPress={() => void close()} />
                </View>
                <AppText variant="caption" tone="muted" style={{ textAlign: 'center' }}>
                    {t('keptAsText')}
                </AppText>
            </View>
        </View>
    )
}
