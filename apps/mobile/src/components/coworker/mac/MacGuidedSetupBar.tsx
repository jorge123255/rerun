import { View } from 'react-native'
import { useTranslations } from 'use-intl'

import { AppText } from '@/components/ui/AppText'
import { Button } from '@/components/ui/Button'
import { spacing } from '@/theme/tokens'

import type { MacGuidedSetup } from './useMacCoworkerSetup'

export function setupBlocksChat(setup: MacGuidedSetup['view'], sessionId: string | null): boolean {
    return Boolean(setup?.required && setup.pending && !setup.skipped && !setup.completedAt && (!sessionId || sessionId !== setup.sessionId))
}

export function MacGuidedSetupBar({ setup, sessionId }: { setup: MacGuidedSetup; sessionId: string | null }) {
    const t = useTranslations('mobileCoworker.mac')
    const home = useTranslations('mobileHome')
    const { view, saving, uncertain, error, act, refresh } = setup
    const needed = !!view?.required && !view.completedAt && (view.pending || view.skipped)
    const inSetup = !!sessionId && view?.sessionId === sessionId
    const ongoing = !!view?.sessionId || !!view?.canContinue
    const action = ongoing ? 'continue' : 'start'
    const opensExisting = !!view?.sessionId && !view.skipped
    const canAct = opensExisting || (!!view?.permissions.changeSettings && (ongoing ? view.canContinue : view.canStart))
    const showAction = needed && (!inSetup || view.skipped)
    const allowSkip = needed && view.canSkip && !view.skipped && !inSetup
    const title = view?.completedAt ? 'setupComplete' : view?.skipped ? 'setupSkipped' : ongoing ? 'setupInProgress' : 'setupNeeded'
    if (!needed && !(view?.completedAt && (!view.sessionId || inSetup)) && !error && !uncertain) return null
    return <View style={{ gap: spacing.xs, paddingHorizontal: spacing.md }}>
        {view && <AppText testID="mac-setup-status" variant="footnote" medium>{t(title)}</AppText>}
        {(error || uncertain) && <View style={{ gap: spacing.xs }}>
            <AppText accessibilityRole="alert" accessibilityLiveRegion="polite" variant="footnote" tone="destructive">{uncertain ? t('unconfirmed') : error === 'settings_not_allowed' ? t('readOnly') : t('setupReadFailed')}</AppText>
            <Button label={home('retry')} size="sm" variant="outline" disabled={saving || (!!uncertain && !view?.permissions.changeSettings)} onPress={() => { if (uncertain) void act(uncertain.body.action); else void refresh() }} />
        </View>}
        {showAction && !canAct && <AppText variant="footnote" tone="muted">{t(view.permissions.changeSettings ? 'setupUnavailable' : 'readOnly')}</AppText>}
        {(showAction || allowSkip) && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {showAction && <Button testID={'mac-setup-' + action} label={t(action)} size="sm" loading={saving} disabled={!canAct || !!uncertain} onPress={() => void act(action)} />}
            {allowSkip && <Button testID="mac-setup-skip" label={t('skip')} size="sm" variant="ghost" disabled={saving || !view.permissions.changeSettings || !!uncertain} onPress={() => void act('skip')} />}
        </View>}
    </View>
}
