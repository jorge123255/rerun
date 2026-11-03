'use client'

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'

import { cn } from '../cn'
import { Monitor, Moon, Sun, type LucideIcon } from '../icons'
import { SegmentedControl, SegmentedControlItem } from '../primitives/segmented-control'
import { parseThemePreference, type ThemePreference } from './theme-cookie'

const OPTIONS: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
    { value: 'system', label: 'System', icon: Monitor },
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
]

export function ThemeToggle({ className, onPreferenceChange }: { className?: string; onPreferenceChange?: (theme: ThemePreference) => void }) {
    const { theme, setTheme } = useTheme()
    const [mounted, setMounted] = useState(false)

    // Le thème résolu n'existe pas au SSR : aucun segment n'est actif tant que le client n'a pas
    // hydraté, sinon le premier rendu en désigne un au hasard.
    useEffect(() => setMounted(true), [])

    return (
        <SegmentedControl
            value={mounted ? (theme ?? 'system') : ''}
            onValueChange={value => onPreferenceChange ? onPreferenceChange(parseThemePreference(value)) : setTheme(value)}
            className={cn('gap-0.5 p-0.5', className)}
            role="radiogroup"
            aria-label="Theme"
        >
            {OPTIONS.map(({ value, label, icon: Glyph }) => (
                <SegmentedControlItem key={value} value={value} className="inline-flex size-7 items-center justify-center p-0" aria-label={label} title={label}>
                    <Glyph className="size-4" />
                </SegmentedControlItem>
            ))}
        </SegmentedControl>
    )
}
