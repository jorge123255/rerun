'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'

export type FileDraftHost = {
    isClosing: () => boolean
    registerUnsaved: (unsaved: () => boolean) => () => void
}

/** Native Quit owns its own confirmation. Browser reloads still use beforeunload. */
export function useFileUnloadGuard(unsaved: boolean, host?: FileDraftHost) {
    const current = useRef(unsaved)
    useLayoutEffect(() => { current.current = unsaved }, [unsaved])
    useLayoutEffect(() => host?.registerUnsaved(() => current.current), [host])
    useEffect(() => {
        if (!unsaved) return
        const warn = (event: BeforeUnloadEvent) => {
            if (!host?.isClosing()) event.preventDefault()
        }
        window.addEventListener('beforeunload', warn)
        return () => window.removeEventListener('beforeunload', warn)
    }, [unsaved, host])
}
