'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type UseFileNavigationOptions<T> = {
    list: (path: string, showHidden: boolean) => Promise<T[]>
    initialPath?: string
    initialShowHidden?: boolean
    onDirectoryLoaded?: (path: string, entries: T[]) => void
}

export type FileNavigation<T> = {
    currentPath: string
    entries: T[]
    depth: number
    loading: boolean
    busy: boolean
    error: string | null
    showHidden: boolean
    navigate: (path: string) => void
    enter: (name: string) => void
    goUp: () => void
    goHome: () => void
    setShowHidden: (update: (previous: boolean) => boolean) => void
    reload: () => void
}

export function useFileNavigation<T>({ list, initialPath = '', initialShowHidden = false, onDirectoryLoaded }: UseFileNavigationOptions<T>): FileNavigation<T> {
    const [requestedPath, setRequestedPath] = useState(initialPath)
    const [directory, setDirectory] = useState<{ path: string; entries: T[] } | null>(null)
    const [pending, setPending] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [showHidden, setShowHidden] = useState(initialShowHidden)
    const requestRef = useRef(0)
    const loadedRef = useRef(onDirectoryLoaded)

    useEffect(() => {
        loadedRef.current = onDirectoryLoaded
    })

    const load = useCallback(async (path: string) => {
        const request = ++requestRef.current
        setPending(true)
        let entries: T[] = []
        let failure: string | null = null
        try {
            entries = await list(path, showHidden)
        } catch (cause) {
            failure = cause instanceof Error ? cause.message : 'Could not open this folder.'
        }
        if (request !== requestRef.current) return
        setDirectory({ path, entries })
        setError(failure)
        setPending(false)
        loadedRef.current?.(path, entries)
    }, [list, showHidden])

    useEffect(() => {
        // Directory selection is synchronized with the engine filesystem here.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load(requestedPath)
    }, [requestedPath, load])

    // The displayed directory is the last one that finished listing, not the one that was just
    // clicked: the step animation then carries the real grid instead of sliding in a skeleton.
    const currentPath = directory?.path ?? requestedPath

    const enter = useCallback((name: string) => setRequestedPath(currentPath ? `${currentPath}/${name}` : name), [currentPath])

    const goUp = useCallback(() => {
        const parts = currentPath.split('/').filter(Boolean)
        parts.pop()
        setRequestedPath(parts.join('/'))
    }, [currentPath])

    const goHome = useCallback(() => setRequestedPath(''), [])

    // Refreshing while a navigation is still in flight abandons it, so the requested path is pulled
    // back in line: otherwise the effect would never re-fire and that navigation would be lost.
    const reload = useCallback(() => {
        setRequestedPath(currentPath)
        void load(currentPath)
    }, [load, currentPath])

    return {
        currentPath,
        entries: directory?.entries ?? [],
        depth: currentPath.split('/').filter(Boolean).length,
        loading: directory === null,
        busy: pending && directory !== null,
        error,
        showHidden,
        navigate: setRequestedPath,
        enter,
        goUp,
        goHome,
        setShowHidden,
        reload,
    }
}
