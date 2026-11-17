import { Text, type TextProps } from 'react-native'

import { useTheme } from '@/theme/theme'
import { fonts } from '@/theme/tokens'

const VARIANTS = {
    largeTitle: { fontSize: 30, lineHeight: 36, letterSpacing: -0.6, fontFamily: fonts.medium },
    title: { fontSize: 20, lineHeight: 26, letterSpacing: -0.3, fontFamily: fonts.medium },
    headline: { fontSize: 16, lineHeight: 22, letterSpacing: -0.2, fontFamily: fonts.medium },
    body: { fontSize: 16, lineHeight: 24, letterSpacing: -0.1, fontFamily: fonts.regular },
    callout: { fontSize: 15, lineHeight: 20, letterSpacing: -0.1, fontFamily: fonts.regular },
    footnote: { fontSize: 13, lineHeight: 18, fontFamily: fonts.regular },
    caption: { fontSize: 12, lineHeight: 16, fontFamily: fonts.regular },
} as const

export type TextVariant = keyof typeof VARIANTS

type AppTextProps = TextProps & {
    variant?: TextVariant
    tone?: 'default' | 'muted' | 'waiting' | 'destructive'
    medium?: boolean
}

export function AppText({ variant = 'body', tone = 'default', medium, style, ...props }: AppTextProps) {
    const theme = useTheme()
    const color = tone === 'muted' ? theme.mutedForeground : tone === 'waiting' ? theme.waiting : tone === 'destructive' ? theme.destructive : theme.foreground
    return <Text {...props} style={[VARIANTS[variant], { color }, medium && { fontFamily: fonts.medium }, style]} />
}
