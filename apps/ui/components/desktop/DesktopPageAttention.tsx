'use client'

import { PAGE_UNATTENDED_ATTRIBUTE } from '@rerun/ui/primitives'
import { useEffect } from 'react'

import { usePageAttention } from '@/hooks/usePageAttention'

// Freezes the page's decoration while the window cannot be seen (see `html[data-unattended]` in
// @rerun/ui/styles.css). Upstream also freezes a window that is on screen without the focus; the Mac
// does not, because the board is watched from beside other apps.
export function DesktopPageAttention() {
    const attention = usePageAttention()

    useEffect(() => {
        document.documentElement.toggleAttribute(PAGE_UNATTENDED_ATTRIBUTE, attention === 'hidden')
    }, [attention])

    useEffect(() => () => document.documentElement.removeAttribute(PAGE_UNATTENDED_ATTRIBUTE), [])

    return null
}
