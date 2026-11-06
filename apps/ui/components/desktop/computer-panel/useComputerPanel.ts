'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ComputerPanelPorts, ComputerPanelProjection } from '@/lib/desktop/computer-panel/contract'
import { dismissKey, launchAvailability, ownerKey, presentComputerPanel, type ComputerPanelView } from '@/lib/desktop/computer-panel/controller'
import { createComputerLauncher, type LaunchAttempt } from '@/lib/desktop/computer-panel/launch'

export type ReadComputerPanelProjection = (agentId: string, sessionId: string, signal: AbortSignal) => Promise<ComputerPanelProjection | null>
export const COMPUTER_PANEL_POLL_MS = 2000

/**
 * Follows one conversation's trusted projection. Polls only while visible (a hidden app holds no
 * request), drops late replies after a session change or unmount, and keeps manual dismissal per exact
 * owner in memory: duplicate projection events never reopen it. Never acquires a lease.
 */
export function useComputerPanel(view: ComputerPanelView, read: ReadComputerPanelProjection, ports: Pick<ComputerPanelPorts, 'launchApp' | 'revalidateOwner'>, humanLaunchMounted: boolean, pollMs = COMPUTER_PANEL_POLL_MS) {
    const [projection, setProjection] = useState<ComputerPanelProjection | null>(null)
    const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
    const [attempt, setAttempt] = useState<LaunchAttempt | null>(null)
    const readRef = useRef(read)
    useEffect(() => { readRef.current = read }, [read])

    useEffect(() => {
        let disposed = false, pending = false
        const controller = new AbortController()
        setProjection(null)
        const refresh = async () => {
            if (disposed || pending || document.visibilityState !== 'visible') return
            pending = true
            try {
                const next = await readRef.current(view.agentId, view.sessionId, AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]))
                if (!disposed) setProjection(next && next.current && (next.current.agentId !== view.agentId || next.current.sessionId !== view.sessionId) ? null : next)
            } catch { if (!disposed) setProjection(null) }
            finally { pending = false }
        }
        void refresh()
        const timer = setInterval(() => void refresh(), pollMs)
        document.addEventListener('visibilitychange', refresh)
        return () => { disposed = true; controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
    }, [view.agentId, view.sessionId, pollMs])

    const presentation = presentComputerPanel(projection, view, dismissed)
    const owner = presentation.show ? presentation.owner : null
    const key = owner ? ownerKey(owner) : null

    const portsRef = useRef(ports)
    useEffect(() => { portsRef.current = ports }, [ports])
    const launcher = useMemo(() => owner ? createComputerLauncher(owner, { launchApp: (...a) => portsRef.current.launchApp(...a), revalidateOwner: (...a) => portsRef.current.revalidateOwner(...a) }, setAttempt) : null,
        // A new owner (run/generation/workspace) is a fresh launcher; late replies of the old one are dropped.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [key])
    useEffect(() => { setAttempt(null); return () => launcher?.dispose() }, [launcher])

    const dismiss = useCallback(() => {
        if (!owner) return
        setDismissed(prev => new Set(prev).add(dismissKey(owner, presentation.show ? presentation.takeover?.takeoverId ?? null : null)))
    }, [owner, presentation])
    const reopen = useCallback(() => setDismissed(new Set()), [])

    return { projection, presentation, availability: launchAvailability(projection, humanLaunchMounted), attempt, launch: (app: 'terminal' | 'files') => void launcher?.launch(app), clearAttempt: () => launcher?.dismiss(), dismiss, reopen, wasDismissed: presentation.show === false && presentation.reason === 'dismissed' }
}
