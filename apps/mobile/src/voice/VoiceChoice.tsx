import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native'
import { useTranslations } from 'use-intl'

import { AppText } from '@/components/ui/AppText'
import { spacing } from '@/theme/tokens'
import type { VoiceChoiceControls } from './useVoiceSession'

type List = Awaited<ReturnType<VoiceChoiceControls['read']>>

export function VoiceChoice({ controls }: { controls: VoiceChoiceControls }) {
    const t = useTranslations('mobileAuth.mac.chief.voice')
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [list, setList] = useState<List | null>(null)
    const [message, setMessage] = useState('')
    const active = useRef<AbortController | null>(null)
    useEffect(() => () => active.current?.abort(), [controls])

    function dismiss() {
        active.current?.abort()
        active.current = null
        setOpen(false)
        setBusy(false)
        setMessage('')
        setList(null)
    }

    async function choose(picked?: List['voices'][number]) {
        if (active.current) return
        const controller = new AbortController()
        active.current = controller
        setOpen(true)
        setBusy(true)
        setMessage('')
        try {
            if (picked) {
                const saved = await controls.save(picked.id, controller.signal)
                if (saved.voiceId !== picked.id) throw new Error('Voice was not saved.')
                if (!controller.signal.aborted) {
                    setList(null)
                    setOpen(false)
                    setMessage(t('chooseSaved', { voice: picked.name }))
                }
            } else {
                const result = await controls.read(controller.signal)
                if (!controller.signal.aborted) setList(result)
            }
        } catch (error) {
            if (!controller.signal.aborted) {
                setList(null)
                setMessage(t((error as { status?: number })?.status === 403 ? 'chooseDenied' : 'chooseFailed'))
            }
        } finally {
            if (active.current === controller) {
                active.current = null
                setBusy(false)
            }
        }
    }

    return <View style={{ alignSelf: 'stretch', alignItems: 'center', gap: spacing.xs }}>
        <Pressable accessibilityRole="button" hitSlop={8} onPress={open ? dismiss : () => void choose()}>
            <AppText variant="footnote" medium>{t(open ? 'chooseClose' : 'chooseVoice')}</AppText>
        </Pressable>
        {open && <AppText variant="caption" tone="muted">{t('chooseHint')}</AppText>}
        {busy && <ActivityIndicator />}
        {open && list && (list.voices.length === 0 ? <AppText variant="footnote">{t('chooseEmpty')}</AppText> :
            <ScrollView style={{ maxHeight: 144, alignSelf: 'stretch' }} keyboardShouldPersistTaps="handled">
                {list.voices.map(voice => <Pressable key={voice.id} accessibilityRole="radio" accessibilityState={{ checked: voice.id === list.voiceId, disabled: busy }}
                    disabled={busy} onPress={() => void choose(voice)} style={{ padding: spacing.sm }}>
                    <AppText variant="callout" medium={voice.id === list.voiceId}>{voice.id === list.voiceId ? '✓ ' : ''}{voice.name}</AppText>
                </Pressable>)}
            </ScrollView>)}
        {!!message && <AppText variant="footnote" accessibilityLiveRegion="polite">{message}</AppText>}
    </View>
}
