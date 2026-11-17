import { Pressable } from 'react-native'

import { AppText } from '@/components/ui/AppText'
import { useTheme } from '@/theme/theme'

export function TextLink({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
    const theme = useTheme()
    return (
        <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled }} hitSlop={8}>
            {({ pressed }) => (
                <AppText variant="callout" medium style={{ color: disabled ? theme.mutedForeground : theme.foreground, opacity: pressed ? 0.6 : 1 }}>
                    {label}
                </AppText>
            )}
        </Pressable>
    )
}
