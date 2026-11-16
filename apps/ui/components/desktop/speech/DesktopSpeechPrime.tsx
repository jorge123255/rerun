'use client'

import { useEffect } from 'react'
import type { DesktopSpeechSettings } from '@/lib/desktop/speech'
import { primeDesktopSpeechSettings } from '@/lib/desktop/speech-player'

/** Hands the page's own read of the speech settings to every conversation, so none has to ask. Never holds a key. */
export function DesktopSpeechPrime({ settings }: { settings: DesktopSpeechSettings | null }) {
    useEffect(() => { primeDesktopSpeechSettings(settings) }, [settings])
    return null
}
