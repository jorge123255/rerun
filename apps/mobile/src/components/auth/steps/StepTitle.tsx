import { View } from 'react-native'

import { AppText } from '@/components/ui/AppText'
import { spacing } from '@/theme/tokens'

export function StepTitle({ title, subtitle }: { title: string; subtitle?: string }) {
    return (
        <View style={{ alignItems: 'center', gap: spacing.xs }}>
            <AppText variant="largeTitle" style={{ textAlign: 'center' }}>
                {title}
            </AppText>
            {subtitle && (
                <AppText variant="callout" tone="muted" style={{ textAlign: 'center' }}>
                    {subtitle}
                </AppText>
            )}
        </View>
    )
}
