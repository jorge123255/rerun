import type { ColorScheme } from '@/theme/tokens'

// Bare glass over a flat background reads as nothing: the card tint and a hairline give it a body.
export const GLASS_TINT_ALPHA = 0.72
export const GLASS_SHADOW: Record<ColorScheme, string> = { light: '0 6px 20px -8px rgba(0,0,0,0.16)', dark: '0 6px 20px -8px rgba(0,0,0,0.6)' }
