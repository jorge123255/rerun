import { Linking, Modal, Pressable, View } from 'react-native'
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
import { VoiceOrb } from './VoiceOrb'

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
            {chatId !== null && <VoiceConversation chatId={chatId} onClose={onClose} deps={deps} />}
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

function Line({ who, text }: { who: string; text: string }) {
    return (
        <AppText variant="footnote" tone="muted" numberOfLines={2} style={{ textAlign: 'center' }}>
            <AppText variant="footnote" tone="muted" medium>
                {who}
            </AppText>
            {`  ${text}`}
        </AppText>
    )
}

function VoiceConversation({ chatId, onClose, deps }: { chatId: string; onClose: () => void; deps: VoiceDeps }) {
    const theme = useTheme()
    const insets = useSafeAreaInsets()
    const t = useTranslations('mobileAuth.mac.chief.voice')
    const voice = useVoiceSession(chatId, deps)
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
                <View testID="voice-mic-on" style={{ flexDirection: 'row', alignItems: 'center', gap: 6, opacity: micOpen ? 1 : 0 }} accessibilityElementsHidden={!micOpen} importantForAccessibility={micOpen ? 'yes' : 'no-hide-descendants'}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.destructive }} />
                    <AppText variant="footnote" tone="muted">
                        {t('micOn')}
                    </AppText>
                </View>
            </View>

            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.xl }}>
                <VoiceOrb size={ORB_SIZE} state={voice.orb} level={voice.level} />
                <AppText testID="voice-caption" variant={over ? 'callout' : 'title'} tone={voice.phase === 'failed' ? 'destructive' : 'default'} accessibilityLiveRegion="polite" style={{ textAlign: 'center', maxWidth: 420 }}>
                    {caption}
                </AppText>
                {!over && (voice.heard || voice.said) ? (
                    <View testID="voice-lines" style={{ gap: spacing.xs, maxWidth: 420 }}>
                        {voice.heard ? <Line who={t('you')} text={voice.heard} /> : null}
                        {voice.said ? <Line who={t('chief')} text={voice.said} /> : null}
                    </View>
                ) : null}
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
