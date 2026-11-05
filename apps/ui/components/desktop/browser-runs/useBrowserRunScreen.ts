'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { createBrowserRunObserver, type BrowserRunIdentity, type BrowserRunObserver, type BrowserRunScreenState, type CurrentRunCheck, type PassiveViewerTransport } from '@/lib/desktop/browser-run'

function subscribeVisibility(onChange: () => void) {
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
}

/** A hidden window or app tab holds no viewer; coming back revalidates from the start. */
export function usePageVisible(): boolean {
    return useSyncExternalStore(subscribeVisibility, () => document.visibilityState !== 'hidden', () => false)
}

/**
 * One observer per mount. The caller keys the mount by the exact run, so an owner/session/run change
 * is always a fresh observer and a fresh current-state check, never a cached ticket.
 */
export function useBrowserRunScreen(run: BrowserRunIdentity, check: CurrentRunCheck, transport: PassiveViewerTransport) {
    const [state, setState] = useState<BrowserRunScreenState>({ status: 'loading' })
    const observerRef = useRef<BrowserRunObserver | null>(null)
    const deps = useRef({ check, transport })
    useEffect(() => {
        deps.current = { check, transport }
    }, [check, transport])

    useEffect(() => {
        const observer = createBrowserRunObserver({
            run,
            check: (identity, signal) => deps.current.check(identity, signal),
            transport: { requestWatchTicket: (identity, signal) => deps.current.transport.requestWatchTicket(identity, signal) },
            onState: setState,
        })
        observerRef.current = observer
        void observer.start()
        return () => {
            observer.dispose()
            if (observerRef.current === observer) observerRef.current = null
        }
        // Keyed by run identity in the caller.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const retry = useCallback(() => void observerRef.current?.retry(), [])
    const onConnected = useCallback((socketUrl: string) => observerRef.current?.connected(socketUrl), [])
    const onDisconnect = useCallback((socketUrl: string) => observerRef.current?.disconnected(socketUrl), [])
    return { state, retry, onConnected, onDisconnect }
}
