'use client'

import { useEffect, useState } from 'react'

type MacWindow = Window & {
    desktopApp?: { onMacFullscreen?: (listener: (fullscreen: boolean) => void) => () => void }
}

export function DesktopMacTitleBar() {
    const [fullscreen, setFullscreen] = useState(false)
    useEffect(() => (window as MacWindow).desktopApp?.onMacFullscreen?.(setFullscreen), [])
    return <div data-desktop-titlebar aria-hidden hidden={fullscreen} />
}
