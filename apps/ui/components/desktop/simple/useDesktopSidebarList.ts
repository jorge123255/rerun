'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { applyDesktopSidebarListChange, desktopSidebarStale, emptyDesktopSidebarList, loadDesktopSidebarList, saveDesktopSidebarList, type DesktopSidebarList, type DesktopSidebarListChange, type DesktopSidebarOrderWrite } from '@/lib/desktop/workspace-view'

const ARRIVAL_MS = 15_000

/**
 * The Simple view's list as the workspace keeps it on this Mac. A change shows at once and is then
 * saved; one that could not be saved is undone by reading the list again.
 */
export function useDesktopSidebarList({ enabled, boxIds, homes }: {
    enabled: boolean
    // The board's Boxes and the Box each coworker is in; null while the board cannot be read, when
    // nothing is known to be gone.
    boxIds: readonly string[] | null
    homes: Readonly<Record<string, string | null>>
}) {
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

    const orderBoxes = useCallback((writes: DesktopSidebarOrderWrite[]) => { if (writes.length) change({ kind: 'boxes', writes }) }, [change])
    const orderAgents = useCallback((boxId: string, writes: DesktopSidebarOrderWrite[]) => { if (writes.length) change({ kind: 'agents', boxId, writes }) }, [change])

    // A coworker dragged to another Box is given its rank there before the board has moved it.
    const arriving = useRef(new Map<string, string>())
    const [settled, setSettled] = useState(0)
    const arriveIn = useCallback((agentId: string, boxId: string, writes: DesktopSidebarOrderWrite[]) => {
        arriving.current.set(agentId, boxId)
        // A move the board refused leaves a rank that means nothing: it is forgotten once this has passed.
        setTimeout(() => { if (arriving.current.get(agentId) === boxId) { arriving.current.delete(agentId); if (alive.current) setSettled(tick => tick + 1) } }, ARRIVAL_MS)
        orderAgents(boxId, writes)
    }, [orderAgents])

    // What the list still says about things that are gone is forgotten, once per finding.
    const forgotten = useRef('')
    const boxKey = boxIds ? JSON.stringify(boxIds) : null
    const homeKey = JSON.stringify(homes)
    useEffect(() => {
        if (!loaded || !boxIds) return
        for (const [agentId, boxId] of arriving.current) if (homes[agentId] === boxId) arriving.current.delete(agentId)
        const stale = desktopSidebarStale(list, boxIds, homes, arriving.current)
        const key = JSON.stringify(stale)
        if (!stale.boxes.length && !stale.agents.length || forgotten.current === key) return
        forgotten.current = key
        change({ kind: 'forget', ...stale })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the keys stand for the Boxes and the homes
    }, [loaded, list, boxKey, homeKey, settled, change])

    return { list, loaded, change, toggleBox, orderBoxes, orderAgents, arriveIn }
}
