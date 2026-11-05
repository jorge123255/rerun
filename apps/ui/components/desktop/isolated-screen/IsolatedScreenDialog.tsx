'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { DesktopNotch } from '@/components/desktop/DesktopNotch'
import { DESKTOP_CONNECTING_LABEL, DesktopScreenLoader } from '@/components/desktop/DesktopScreenLoader'
import { DesktopViewer, type DesktopViewerHandle } from '@/components/desktop/DesktopViewer'
import { TakeControlOverlay } from '@/components/desktop/TakeControlOverlay'
import { DesktopDialog } from '@/components/dialogs/DesktopDialog'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { MonitorIcon } from '@/lib/icons'
import { finishDesktopScreenTakeover, fetchDesktopScreenStatus, requestDesktopScreenTicket, startDesktopScreenTakeover } from '@/lib/desktop/screen-client'

export type IsolatedTakeover = { callId: string; url?: string; reason: string }

type Screen =
    | { status: 'loading' }
    | { status: 'live'; socketUrl: string }
    | { status: 'error'; error: string }
    | { status: 'unavailable'; reason: string }
    | { status: 'disconnected' }

const DESKTOP_DESCRIPTION = 'The isolated screen this coworker works on. What you do here, it finds afterwards.'
const TAKEOVER_DESCRIPTION = 'You are in your coworker’s isolated browser. Press Done when it can carry on.'

async function connect(agentId: string, mode: 'watch' | 'drive', takeover: IsolatedTakeover | null, leaseRef: { current: string | null }): Promise<Screen> {
    try {
        if (mode === 'drive' && !leaseRef.current) {
            const started = await startDesktopScreenTakeover(agentId, takeover?.url)
            leaseRef.current = started.lease
        }
        const ticket = await requestDesktopScreenTicket(agentId, mode)
        return { status: 'live', socketUrl: ticket.socketUrl }
    } catch (err) {
        return { status: 'error', error: err instanceof Error ? err.message : 'The screen could not be reached.' }
    }
}

export function IsolatedScreenDialog({ open, onOpenChange, agentId, title, takeover = null, onHandBack }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    agentId: string
    title: string
    takeover?: IsolatedTakeover | null
    onHandBack?: (callId: string, url: string | null) => void
}) {
    return (
        <DesktopDialog
            open={open}
            onOpenChange={onOpenChange}
            title={takeover ? takeover.reason : title}
            description={takeover ? TAKEOVER_DESCRIPTION : DESKTOP_DESCRIPTION}
        >
            {open && <IsolatedScreenSession key={`${agentId}:${takeover?.callId ?? 'screen'}`} agentId={agentId} takeover={takeover} onHandBack={onHandBack} />}
        </DesktopDialog>
    )
}

function IsolatedScreenSession({ agentId, takeover, onHandBack }: { agentId: string; takeover: IsolatedTakeover | null; onHandBack?: (callId: string, url: string | null) => void }) {
    const [screen, setScreen] = useState<Screen>({ status: 'loading' })
    const [mode, setMode] = useState<'watch' | 'drive'>(takeover ? 'drive' : 'watch')
    const [busy, setBusy] = useState(false)
    const viewerRef = useRef<DesktopViewerHandle>(null)
    const leaseRef = useRef<string | null>(null)
    const finishingRef = useRef(false)

    const release = useCallback(async () => {
        if (leaseRef.current === null && !takeover) return
        const lease = leaseRef.current
        leaseRef.current = null
        try {
            await finishDesktopScreenTakeover(agentId, lease ?? undefined)
        } catch {
        }
    }, [agentId, takeover])

    useEffect(() => {
        let alive = true
        void (async () => {
            try {
                const current = await fetchDesktopScreenStatus(agentId)
                if (!alive) return
                if (current.state === 'unavailable' || current.state === 'disconnected') {
                    setScreen({ status: 'unavailable', reason: current.reason ?? (current.state === 'disconnected' ? 'The isolated screen is not running.' : 'The isolated screen is not available on this machine.') })
                    return
                }
                setScreen(await connect(agentId, takeover ? 'drive' : 'watch', takeover, leaseRef))
            } catch (err) {
                if (alive) setScreen({ status: 'error', error: err instanceof Error ? err.message : 'The screen could not be reached.' })
            }
        })()
        return () => {
            alive = false
            void release()
        }
        // Mounted once per agent/takeover: reconnects mint fresh tickets instead of remounting.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const reconnect = async () => {
        setScreen({ status: 'loading' })
        setScreen(await connect(agentId, mode, takeover, leaseRef))
    }

    const switchMode = async (next: 'watch' | 'drive') => {
        if (next === mode || busy) return
        setBusy(true)
        if (next === 'watch') {
            await release()
            setMode('watch')
            setScreen(await connect(agentId, 'watch', null, leaseRef))
        } else {
            setMode('drive')
            setScreen(await connect(agentId, 'drive', takeover, leaseRef))
        }
        setBusy(false)
    }

    const done = async () => {
        if (finishingRef.current) return
        finishingRef.current = true
        setBusy(true)
        try {
            const result = await finishDesktopScreenTakeover(agentId, leaseRef.current ?? undefined)
            leaseRef.current = null
            if (takeover?.callId) onHandBack?.(takeover.callId, result.url)
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'The screen could not be handed back.')
        } finally {
            finishingRef.current = false
            setBusy(false)
        }
    }

    const onDisconnect = useCallback(() => setScreen({ status: 'disconnected' }), [])
    const live = screen.status === 'live'
    const driving = live && mode === 'drive'

    return (
        <div className="relative flex min-h-0 flex-1 flex-col bg-muted/40">
            {screen.status === 'loading' && <DesktopScreenLoader label={DESKTOP_CONNECTING_LABEL} />}
            {live && (
                <div className="relative flex min-h-0 flex-1 flex-col">
                    <DesktopViewer ref={viewerRef} socketUrl={screen.socketUrl} viewOnly={!driving} onDisconnect={onDisconnect} />
                    {!driving && <TakeControlOverlay label="Take control" onClick={() => void switchMode('drive')} />}
                </div>
            )}
            {screen.status === 'error' && <EmptyState icon={MonitorIcon} title="The screen is not available" description={screen.error} action={<RetryButton onClick={() => void reconnect()} />} />}
            {screen.status === 'unavailable' && <EmptyState icon={MonitorIcon} title="The screen is not available" description={screen.reason} />}
            {screen.status === 'disconnected' && <EmptyState icon={MonitorIcon} title="The screen went away" description="The connection to the isolated screen closed. Nothing on it was lost." action={<RetryButton onClick={() => void reconnect()} label="Reconnect" />} />}
            <DesktopNotch
                launchers={false}
                browsing={driving}
                disabled={!live || busy}
                takeoverReason={takeover?.reason ?? (driving ? 'You are driving' : undefined)}
                onOpenApp={() => undefined}
                onToggleBrowser={() => void switchMode(driving ? 'watch' : 'drive')}
                onPaste={() => {
                    void navigator.clipboard.readText().then(text => viewerRef.current?.paste(text)).catch(() => toast.error('The clipboard could not be read.'))
                }}
                onDone={driving ? () => void done() : undefined}
            />
        </div>
    )
}

function RetryButton({ onClick, label = 'Try again' }: { onClick: () => void; label?: string }) {
    return (
        <Button size="sm" variant="outline" onClick={onClick}>
            {label}
        </Button>
    )
}
