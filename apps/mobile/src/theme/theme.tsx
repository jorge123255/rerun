import { createContext, use, type ReactNode } from 'react'
import { useColorScheme } from 'react-native'

import { palette, type ColorScheme, type Palette } from '@/theme/tokens'

// Set only by a ThemeScope: the lab draws the same component in both themes side by side.
const ForcedScheme = createContext<ColorScheme | null>(null)

export function ThemeScope({ scheme, children }: { scheme: ColorScheme; children: ReactNode }) {
    return <ForcedScheme value={scheme}>{children}</ForcedScheme>
}

export function useColorSchemeName(): ColorScheme {
    const forced = use(ForcedScheme)
    const system = useColorScheme() === 'dark' ? 'dark' : 'light'
    return forced ?? system
}

export function useTheme(): Palette & { scheme: ColorScheme } {
    const scheme = useColorSchemeName()
    return { ...palette[scheme], scheme }
}
