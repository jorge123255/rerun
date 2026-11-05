'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { DesktopNotch } from '@/components/desktop/DesktopNotch'
import { DESKTOP_CONNECTING_LABEL, DesktopScreenLoader } from '@/components/desktop/DesktopScreenLoader'
import { DesktopViewer, type DesktopViewerHandle } from '@/components/desktop/DesktopViewer'
import { TakeControlOverlay } from '@/components/desktop/TakeControlOverlay'
import { DesktopDialog } from '@/components/dialogs/DesktopDialog'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { MonitorIcon } from '@/lib/icons'
import { createDesktopScreenSession, defaultScreenApi } from '@/lib/desktop/screen-session'

export type IsolatedTakeover = { callId: string; url?: string; reason: string }
type Screen = { status: 'loading' } | { status: 'live'; socketUrl: string } | { status: 'error'; error: string; handoff?: boolean } | { status: 'unavailable'; reason: string } | { status: 'disconnected' }
type Props = {
    open: boolean; onOpenChange: (open: boolean) => void; agentId: string; title: string
    takeover?: IsolatedTakeover | null
    screenApi?: typeof defaultScreenApi
    // B's durable receipt must succeed before the dialog reports hand-back completion.
    onHandBack?: (callId: string, url: string | null) => Promise<void>
}

export function IsolatedScreenDialog({ open, onOpenChange, agentId, title, takeover = null, onHandBack, screenApi }: Props) {
    return (
        <DesktopDialog open={open} onOpenChange={onOpenChange} title={takeover ? takeover.reason : title}
            description={takeover ? 'You are in your coworker’s isolated browser. Press Done when it can carry on.' : 'The isolated screen this coworker works on. What you do here, it finds afterwards.'}>
            {open && <IsolatedScreenSession key={`${agentId}:${takeover?.callId ?? 'screen'}`} agentId={agentId} takeover={takeover} onHandBack={onHandBack} screenApi={screenApi} onClose={() => onOpenChange(false)} />}
        </DesktopDialog>
    )
}

function IsolatedScreenSession({ agentId, takeover, onHandBack, onClose, screenApi }: { agentId: string; takeover: IsolatedTakeover | null; onHandBack: Props['onHandBack']; screenApi?: typeof defaultScreenApi; onClose: () => void }) {
    const [screen, setScreen] = useState<Screen>({ status: 'loading' })
    const [mode, setMode] = useState<'watch' | 'drive'>(takeover ? 'drive' : 'watch')
    const [busy, setBusy] = useState(false)
    const viewerRef = useRef<DesktopViewerHandle>(null)
    const sessionRef = useRef<ReturnType<typeof createDesktopScreenSession> | null>(null)
    const alive = useRef(false), busyRef = useRef(false), epoch = useRef(0)
    const returned = useRef<{ url: string | null; expired?: boolean } | null>(null)

    async function connect(next: 'watch' | 'drive') {
        if (busyRef.current || !sessionRef.current) return
        busyRef.current = true; setBusy(true); setScreen({ status: 'loading' })
        const version = ++epoch.current
        try {
            const result = await sessionRef.current.connect(next, takeover?.url)
            if (!alive.current || version !== epoch.current) return
            returned.current = null
            setMode(next)
            setScreen('socketUrl' in result ? { status: 'live', socketUrl: result.socketUrl! } : { status: 'unavailable', reason: result.unavailable })
        } catch (error) {
            if (alive.current && version === epoch.current) setScreen({ status: 'error', error: error instanceof Error ? error.message : 'The screen could not be reached.' })
        } finally {
            if (alive.current && version === epoch.current) { busyRef.current = false; setBusy(false) }
        }
    }
    const invalidate = () => { alive.current = false; ++epoch.current; sessionRef.current = null }
    useEffect(() => {
        alive.current = true; busyRef.current = false
        const session = createDesktopScreenSession(agentId, screenApi); sessionRef.current = session
        queueMicrotask(() => { if (sessionRef.current === session) void connect(takeover ? 'drive' : 'watch') })
        return () => {
            invalidate()
            void session.close().catch(() => {})
        }
        // Dialog is keyed by exact coworker and request; every mount gets a fresh controller.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    async function done() {
        if (busyRef.current || !sessionRef.current) return
        busyRef.current = true; setBusy(true)
        // Unmount the drive viewer before releasing input ownership.
        setScreen({ status: 'loading' }); ++epoch.current
        try {
            sessionRef.current.cancelConnection()
            returned.current ??= await sessionRef.current.finish()
            if (takeover && returned.current.expired) {
                returned.current = null
                if (alive.current) setScreen({ status: 'disconnected' })
                return
            }
            if (takeover) {
                if (!onHandBack) throw new Error('The hand-back request is unavailable.')
                await onHandBack(takeover.callId, returned.current.url)
            }
            if (alive.current) onClose()
        } catch (error) {
            if (alive.current) {
                setScreen({ status: 'error', error: 'Could not finish handing back the screen. Try Done again.', handoff: true })
                toast.error(error instanceof Error ? error.message : 'Could not hand back the screen.')
            }
        } finally { if (alive.current) { busyRef.current = false; setBusy(false) } }
    }
    const live = screen.status === 'live', driving = live && mode === 'drive'
    return (
        <div className="relative flex min-h-0 flex-1 flex-col bg-muted/40">
            {screen.status === 'loading' && <DesktopScreenLoader label={DESKTOP_CONNECTING_LABEL} />}
            {live && <div className="group relative flex min-h-0 flex-1 flex-col">
                <DesktopViewer ref={viewerRef} socketUrl={screen.socketUrl} viewOnly={!driving} onDisconnect={() => setScreen({ status: 'disconnected' })} />
                {!driving && <TakeControlOverlay label="Take control" onClick={() => void connect('drive')} />}
            </div>}
            {screen.status === 'error' && <EmptyState icon={MonitorIcon} title="The screen is not available" description={screen.error}
                action={<Button size="sm" variant="outline" disabled={busy} onClick={() => void (screen.handoff ? done() : connect(mode))}>{screen.handoff ? 'Done' : 'Try again'}</Button>} />}
            {screen.status === 'unavailable' && <EmptyState icon={MonitorIcon} title="The screen is not available" description={screen.reason} />}
            {screen.status === 'disconnected' && <EmptyState icon={MonitorIcon} title="The screen went away" description="The connection to the isolated screen closed. Reconnect to check its current state."
                action={<Button size="sm" variant="outline" disabled={busy} onClick={() => void connect(mode)}>Reconnect</Button>} />}
            <DesktopNotch launchers={false} browsing={driving} disabled={!driving || busy}
                takeoverReason={takeover?.reason ?? (driving ? 'You are driving' : undefined)} onOpenApp={() => undefined}
                onToggleBrowser={() => void connect(driving ? 'watch' : 'drive')}
                onPaste={() => { if (driving) void navigator.clipboard.readText().then(text => viewerRef.current?.paste(text)).catch(() => toast.error('The clipboard could not be read.')) }}
                onDone={driving ? () => void done() : undefined} />
        </div>
    )
}
