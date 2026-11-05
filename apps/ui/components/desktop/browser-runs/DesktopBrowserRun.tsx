'use client'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { parseTrustedCurrentRun, sameRun, type BrowserRunIdentity, type CurrentRunCheck, type PassiveViewerTransport, type TrustedCurrentRun } from '@/lib/desktop/browser-run'
import { BrowserRunScreen } from './BrowserRunScreen'

const endpoint = ({ agentId, sessionId }: Pick<BrowserRunIdentity, 'agentId' | 'sessionId'>) => `/api/desktop/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/browser-run`
async function readCurrent(run: Pick<BrowserRunIdentity, 'agentId' | 'sessionId'>, signal: AbortSignal) {
    const response = await fetch(endpoint(run), { cache: 'no-store', signal })
    if (!response.ok) throw new Error('Could not check this browser run')
    return parseTrustedCurrentRun((await response.json()).trusted)
}
const check: CurrentRunCheck = async (run, signal) => {
    const current = await readCurrent(run, signal)
    return sameRun(current, run) && current?.liveScreen ? { current: true, screen: 'running', site: current.liveScreen.site } : { current: false }
}
const transport: PassiveViewerTransport = { requestWatchTicket: async (run, signal) => {
    const response = await fetch(endpoint(run), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: run.runId }), signal })
    if (!response.ok) throw new Error('Could not view this browser run')
    return response.json()
} }

/** Uses the same screen components as original ChatScreen, with desktop run authority. */
type DesktopBrowserRunProps = {
    agentId: string; sessionId: string; active: boolean; takeoverPending: boolean; fullViewerOpen: boolean; onOpen: () => void; fallback: ReactNode
}
export function DesktopBrowserRun(props: DesktopBrowserRunProps) {
    if (!props.active || props.takeoverPending) return props.fallback
    return <ActiveDesktopBrowserRun key={`${props.agentId}:${props.sessionId}`} {...props} />
}
function ActiveDesktopBrowserRun({ agentId, sessionId, fullViewerOpen, onOpen, fallback }: DesktopBrowserRunProps) {
    const [trusted, setTrusted] = useState<TrustedCurrentRun | null>(null)
    const { scrollRef } = useStickToBottomContext()
    const [scroller, setScroller] = useState<HTMLElement | null>(null)
    const scope = useRef<AbortController | null>(null)
    useEffect(() => {
        let disposed = false, pending = false
        const controller = new AbortController()
        scope.current = controller
        const refresh = async () => {
            if (pending || document.visibilityState !== 'visible') return
            pending = true
            try {
                const value = await readCurrent({ agentId, sessionId }, AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]))
                if (!disposed) { setScroller(scrollRef.current); setTrusted(value) }
            } catch { if (!disposed) setTrusted(null) }
            finally { pending = false }
        }
        void refresh()
        const timer = setInterval(() => void refresh(), 2000)
        document.addEventListener('visibilitychange', refresh)
        return () => { disposed = true; controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
    }, [agentId, sessionId, scrollRef])
    const open = useCallback(async (run: BrowserRunIdentity) => {
        const controller = scope.current
        if (!controller || run.agentId !== agentId || run.sessionId !== sessionId) throw new Error('This browser run ended')
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)])
        const current = await check(run, signal)
        signal.throwIfAborted()
        if (!current.current || current.screen !== 'running' || document.visibilityState === 'hidden') throw new Error('This browser run ended')
        onOpen()
    }, [agentId, sessionId, onOpen])
    return <BrowserRunScreen trusted={trusted} agentId={agentId} sessionId={sessionId} active selected takeoverPending={false}
        fullViewerOpen={fullViewerOpen} checkCurrentRun={check} transport={transport} onOpenFullViewer={open}
        scroller={scroller} floatingHost={scroller?.parentElement ?? null} fallback={fallback} />
}
