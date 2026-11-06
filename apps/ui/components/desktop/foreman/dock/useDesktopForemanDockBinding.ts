'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopForemanChatRef } from '@/lib/desktop/foreman-client/identity'
import type { DesktopForemanPlacement } from '@/lib/desktop/foreman-client/persistence'
import { bindForemanPlacement, createDockPersistence, registerDockQuitFlush } from '@/lib/desktop/foreman-dock/persistence'
import { boundedPlacement, savedPlacement, type DockExtras } from '@/lib/desktop/foreman-dock/layout'

/** Root calls once beside its existing useDesktopForemanUi, never another conversation hook. */
export function useDesktopForemanDockBinding(input: {
    chat: DesktopForemanChatRef; placement: DesktopForemanPlacement; dock: DockExtras
    setPlacement: (placement: DesktopForemanPlacement) => void; setDock: (dock: DockExtras) => void
    registerQuitFlush?: (flush: () => Promise<boolean>) => () => void
}) {
    const latest = useRef(input); latest.current = input
    const scope = `${input.chat.workspaceId}\u0000${input.chat.chatId}`
    const [optimistic, setOptimistic] = useState<{ scope: string; placement?: DesktopForemanPlacement; dock?: DockExtras } | null>(null)
    const persistence = useMemo(() => createDockPersistence(bindForemanPlacement({
        chat: { workspaceId: input.chat.workspaceId, chatId: input.chat.chatId }, current: () => latest.current.chat,
        setPlacement: p => latest.current.setPlacement(p), setDock: d => latest.current.setDock(d),
    })), [scope])
    useEffect(() => {
        persistence.activate()
        const unregister = (input.registerQuitFlush ?? registerDockQuitFlush)(() => persistence.flush())
        return () => { persistence.dispose(); unregister() }
    }, [persistence, input.registerQuitFlush])
    useEffect(() => {
        setOptimistic(value => value?.scope === scope && value.placement && JSON.stringify(value.placement) !== JSON.stringify(input.placement) ? value : value?.dock && JSON.stringify(value.dock) !== JSON.stringify(input.dock) ? value : null)
    }, [scope, input.placement, input.dock])
    return {
        scope,
        placement: optimistic?.scope === scope ? optimistic.placement ?? input.placement : input.placement,
        dock: optimistic?.scope === scope ? optimistic.dock ?? input.dock : input.dock,
        onPlacement(p: DesktopForemanPlacement) {
            const value = savedPlacement(boundedPlacement(p, { width: window.innerWidth, height: window.innerHeight }))
            setOptimistic(old => ({ ...(old?.scope === scope ? old : {}), scope, placement: value }))
            persistence.change({ placement: value })
        },
        onDock(dock: DockExtras) {
            setOptimistic(old => ({ ...(old?.scope === scope ? old : {}), scope, dock }))
            persistence.change({ dock })
        },
        flush: () => persistence.flush(),
    }
}
