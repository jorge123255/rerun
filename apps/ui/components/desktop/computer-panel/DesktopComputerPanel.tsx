'use client'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { createHttpHumanLauncher, httpCurrentRunCheck, readDesktopComputerPanelProjection, revalidateDesktopComputerPanelOwner, screenClientWatchTransport } from '@/lib/desktop/computer-panel/adapters'
import type { ComputerPanelPorts } from '@/lib/desktop/computer-panel/contract'
import { ComputerPanel } from './ComputerPanel'
export function DesktopComputerPanel(props: { agentId: string; sessionId: string; active: boolean; takeoverPending: boolean; fullViewerOpen: boolean; onOpen: () => void; fallback: ReactNode }) {
    if (!props.active || props.takeoverPending) return props.fallback
    return <Connected key={`${props.agentId}:${props.sessionId}`} {...props} />
}
function Connected({ agentId, sessionId, fullViewerOpen, onOpen, fallback }: Parameters<typeof DesktopComputerPanel>[0]) {
    const { scrollRef } = useStickToBottomContext()
    const [scroller, setScroller] = useState<HTMLElement | null>(null)
    useEffect(() => setScroller(scrollRef.current), [scrollRef])
    const open = useCallback<ComputerPanelPorts['openFullViewer']>(async owner => { if (owner.agentId !== agentId || owner.sessionId !== sessionId) throw new Error('Computer owner changed'); onOpen() }, [agentId, sessionId, onOpen])
    const ports = useMemo<ComputerPanelPorts>(() => ({ checkCurrentRun: httpCurrentRunCheck, transport: screenClientWatchTransport, revalidateOwner: revalidateDesktopComputerPanelOwner, launchApp: createHttpHumanLauncher(), openFullViewer: open }), [open])
    return <ComputerPanel agentId={agentId} sessionId={sessionId} active selected fullViewerOpen={fullViewerOpen} readProjection={readDesktopComputerPanelProjection} ports={ports} humanLaunchMounted scroller={scroller} floatingHost={scroller?.parentElement ?? null} fallback={fallback} />
}
