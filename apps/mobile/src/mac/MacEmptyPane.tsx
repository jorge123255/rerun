import { View } from 'react-native'
import { useTranslations } from 'use-intl'

import { AppText } from '@/components/ui/AppText'
import { useTheme } from '@/theme/theme'
import { spacing } from '@/theme/tokens'

// Beside the list of a wide window, before a coworker is picked.
export function MacEmptyPane() {
    const theme = useTheme()
    const t = useTranslations('mobileAuth.mac')
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: theme.background }}>
            <AppText variant="callout" tone="muted" style={{ textAlign: 'center' }}>
                {t('pickCoworker')}
            </AppText>
        </View>
    )
}
