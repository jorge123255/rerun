'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { applyDesktopSidebarListChange, emptyDesktopSidebarList, loadDesktopSidebarList, saveDesktopSidebarList, type DesktopSidebarList, type DesktopSidebarListChange } from '@/lib/desktop/workspace-view'

/**
 * The Simple view's list as the workspace keeps it on this Mac. A change shows at once and is then
 * saved; one that could not be saved is undone by reading the list again.
 */
export function useDesktopSidebarList(enabled: boolean) {
    const [list, setList] = useState<DesktopSidebarList>(emptyDesktopSidebarList)
    const [loaded, setLoaded] = useState(false)
    const started = useRef(false)
    // Only the answer to the latest change is taken: an older one would bring back what was just undone.
    const sequence = useRef(0)
    const alive = useRef(true)
    useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

    const read = useCallback(async () => {
        const own = ++sequence.current
        const saved = await loadDesktopSidebarList()
        if (!alive.current || own !== sequence.current) return
        if (saved) setList(saved)
        setLoaded(true)
    }, [])
    useEffect(() => {
        if (!enabled || started.current) return
        started.current = true
        void read()
    }, [enabled, read])

    const change = useCallback((next: DesktopSidebarListChange) => {
        const own = ++sequence.current
        setList(current => applyDesktopSidebarListChange(current, next))
        void saveDesktopSidebarList(next).then(saved => {
            if (!alive.current || own !== sequence.current) return
            if (saved) { setList(saved); return }
            toast.error('The list could not be saved.')
            void read()
        })
    }, [read])

    const collapsed = list.collapsed
    const toggleBox = useCallback((boxId: string) => {
        change({ kind: 'collapsed', ids: collapsed.includes(boxId) ? collapsed.filter(id => id !== boxId) : [...collapsed, boxId] })
    }, [change, collapsed])

    return { list, loaded, change, toggleBox }
}
