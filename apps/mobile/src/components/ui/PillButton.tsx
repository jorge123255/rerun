import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'

import { AppText } from '@/components/ui/AppText'
import { ctaRelief } from '@/theme/relief'
import { useTheme } from '@/theme/theme'
import { radius, spacing } from '@/theme/tokens'

type PillButtonProps = {
    label: string
    onPress: () => void
    variant?: 'primary' | 'secondary'
    icon?: ReactNode
    loading?: boolean
    disabled?: boolean
}

export const PILL_BUTTON_HEIGHT = 52

export function PillButton({ label, onPress, variant = 'primary', icon, loading, disabled }: PillButtonProps) {
    const theme = useTheme()
    const primary = variant === 'primary'
    const inactive = disabled || loading
    const color = primary ? theme.primaryForeground : theme.foreground
    return (
        <Pressable
            onPress={onPress}
            disabled={inactive}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled: inactive, busy: loading }}
            style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: spacing.sm,
                height: PILL_BUTTON_HEIGHT,
                paddingHorizontal: spacing.xl,
                borderRadius: radius.pill,
                backgroundColor: primary ? theme.primary : theme.card,
                borderWidth: primary ? 0 : 1,
                borderColor: theme.border,
                boxShadow: primary ? ctaRelief[theme.scheme][pressed ? 'pressed' : 'rest'] : undefined,
                opacity: disabled ? 0.45 : 1,
                transform: [{ scale: pressed ? 0.98 : 1 }],
            })}
        >
            {loading ? <ActivityIndicator color={color} /> : icon && <View>{icon}</View>}
            <AppText variant="headline" numberOfLines={1} maxFontSizeMultiplier={1.3} style={{ color, flexShrink: 1 }}>
                {label}
            </AppText>
        </Pressable>
    )
}
