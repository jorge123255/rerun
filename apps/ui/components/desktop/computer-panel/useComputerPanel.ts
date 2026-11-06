'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComputerPanelPorts, ComputerPanelProjection } from '@/lib/desktop/computer-panel/contract'
import { dismissKey, launchAvailability, ownerKey, ownerOf, presentComputerPanel, type ComputerPanelView } from '@/lib/desktop/computer-panel/controller'
import { createComputerLauncher, type LaunchAttempt } from '@/lib/desktop/computer-panel/launch'
export type ReadComputerPanelProjection = (agentId: string, sessionId: string, signal: AbortSignal) => Promise<ComputerPanelProjection | null>
export const COMPUTER_PANEL_POLL_MS = 2000
export function useComputerPanel(view: ComputerPanelView, read: ReadComputerPanelProjection, ports: Pick<ComputerPanelPorts, 'launchApp' | 'revalidateOwner'>, humanLaunchMounted: boolean, pollMs = COMPUTER_PANEL_POLL_MS) {
    const [projection, setProjection] = useState<ComputerPanelProjection | null>(null)
    const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
    const [attempt, setAttempt] = useState<LaunchAttempt | null>(null)
    const live = useRef({ view, read, ports }); live.current = { view, read, ports }
    const enabled = view.active && view.selected && view.visible
    useEffect(() => {
        setProjection(null)
        if (!enabled) return
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        async function refresh() {
            if (controller.signal.aborted) return
            try {
                const next = await live.current.read(view.agentId, view.sessionId, AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]))
                if (!controller.signal.aborted) setProjection(next?.current && (next.current.agentId !== view.agentId || next.current.sessionId !== view.sessionId) ? null : next)
            } catch { if (!controller.signal.aborted) setProjection(null) }
            if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), pollMs)
        }
        void refresh()
        return () => { controller.abort(); if (timer) clearTimeout(timer) }
    }, [view.agentId, view.sessionId, enabled, pollMs])
    const owner = projection?.current?.agentId === view.agentId && projection.current.sessionId === view.sessionId ? ownerOf(projection) : null
    const key = owner ? ownerKey(owner) : null
    const launcher = useRef<ReturnType<typeof createComputerLauncher> | null>(null)
    const retained = useRef(new Map<string, LaunchAttempt>())
    useEffect(() => {
        setAttempt(null)
        if (!owner || !enabled) return
        const captured = owner, capturedKey = ownerKey(captured)
        const instance = createComputerLauncher(captured, {
            revalidateOwner: (target, signal) => live.current.ports.revalidateOwner(target, signal),
            launchApp: (target, app, requestId, signal) => live.current.ports.launchApp(target, app, requestId, signal),
        }, next => {
            if (next) retained.current.set(capturedKey, next); else retained.current.delete(capturedKey)
            if (launcher.current === instance) setAttempt(next)
        })
        launcher.current = instance
        const saved = retained.current.get(capturedKey)
        if (saved?.phase === 'pending' || saved?.phase === 'uncertain') instance.restore(saved)
        else if (projection?.pending) instance.restore(projection.pending)
        return () => { instance.dispose(); if (launcher.current === instance) launcher.current = null }
        // Owner is a value identity. Hiding the screen itself must not destroy its launcher receipt.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, enabled])
    useEffect(() => { if (projection?.pending) launcher.current?.restore(projection.pending) }, [projection?.pending])
    const presentation = presentComputerPanel(projection, view, dismissed)
    const dismiss = useCallback(() => { if (owner) setDismissed(previous => new Set(previous).add(dismissKey(owner, null))) }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
    const reopen = useCallback(() => setDismissed(new Set()), [])
    return { projection, presentation, availability: launchAvailability(projection, humanLaunchMounted), attempt,
        launch: (app: 'terminal' | 'files') => { if (enabled) void launcher.current?.launch(app) }, clearAttempt: () => launcher.current?.dismiss(), dismiss, reopen,
        wasDismissed: !presentation.show && presentation.reason === 'dismissed' }
}
