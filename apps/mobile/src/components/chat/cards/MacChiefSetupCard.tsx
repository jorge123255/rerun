import type { MacPhoneChiefSetupTarget } from '@rerun/mac-contracts/mac-phone-pairing'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { View } from 'react-native'
import { useTranslations } from 'use-intl'

import { macHub } from '@/api/client'
import { AppText } from '@/components/ui/AppText'
import { Button } from '@/components/ui/Button'
import { spacing } from '@/theme/tokens'

// Opening a proposed step reads its current owner and setup chat. The phone can review or copy
// the suggested words, then answer the actual question using its existing chat permissions.
export function MacChiefSetupCard({ target }: { target: MacPhoneChiefSetupTarget }) {
    const t = useTranslations('mobileCards.macSetup')
    const setup = useTranslations('mobileCoworker.mac')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<'changed' | 'unavailable' | null>(null)
    const active = useRef<AbortController | null>(null)
    useFocusEffect(useCallback(() => {
        setError(null)
        setBusy(false)
        return () => { active.current?.abort(); active.current = null }
    }, [target.agentId, target.sessionId]))
    const open = async () => {
        if (!macHub || active.current) return
        const controller = new AbortController()
        active.current = controller
        setError(null)
        setBusy(true)
        try {
            const view = await macHub.readCoworkerSetup(target.agentId, controller.signal)
            if (controller.signal.aborted) return
            if (view.agentId !== target.agentId || !view.required || view.completedAt || (target.sessionId && (view.sessionId !== target.sessionId || view.skipped))) {
                setError('changed')
                return
            }
            if (view.sessionId) macHub.rememberChat(view.sessionId, view.agentId)
            router.push({ pathname: '/chat/[id]', params: { id: view.sessionId ?? 'general', to: view.agentId } })
        } catch {
            if (!controller.signal.aborted) setError('unavailable')
        } finally {
            if (active.current === controller) { active.current = null; setBusy(false) }
        }
    }
    return <View style={{ gap: spacing.xs }}>
        {target.sessionId !== null && target.reply !== undefined && <>
            {target.question && <>
                <AppText variant="footnote" medium>{t('question')}</AppText>
                <AppText selectable>{target.question}</AppText>
            </>}
            <AppText variant="footnote" medium>{t('reply')}</AppText>
            <AppText selectable>{target.reply}</AppText>
        </>}
        <Button size="sm" variant="outline" label={t('open', { name: target.coworker })} disabled={busy} onPress={() => void open()} />
        {error && <AppText variant="footnote" tone="destructive" accessibilityRole="alert">{error === 'changed' ? t('changed') : setup('setupReadFailed')}</AppText>}
    </View>
}
