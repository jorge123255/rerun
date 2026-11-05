'use client'
import { useEffect, useState } from 'react'
import { DesktopTakeoverCard, type DesktopTakeoverCardProps } from '../DesktopTakeoverCard'
import { DesktopViewer } from '../DesktopViewer'
import { DesktopScreenLoader } from '../DesktopScreenLoader'
import { createDesktopScreenSession } from '@/lib/desktop/screen-session'
import { Button } from '@/components/ui/button'

export function DesktopBrowserCard({ agentId, ...props }: DesktopTakeoverCardProps & { agentId: string }) {
    const [socketUrl, setSocketUrl] = useState<string | null>(null)
    const [error, setError] = useState('')
    const [attempt, setAttempt] = useState(0)
    useEffect(() => {
        let active = true
        const session = createDesktopScreenSession(agentId)
        void session.connect('watch').then(result => {
            if (active) { setSocketUrl(result.socketUrl ?? null); setError(result.unavailable ?? '') }
        }).catch(error => { if (active) setError(error instanceof Error ? error.message : 'Could not connect to the screen.') })
        return () => { active = false; void session.close().catch(() => {}) }
    }, [agentId, attempt])
    const screen = socketUrl ? <DesktopViewer socketUrl={socketUrl} viewOnly onDisconnect={() => { setSocketUrl(null); setError('The screen disconnected.') }} /> : error ? <div className="m-auto p-3 text-xs text-muted-foreground">{error}<Button size="sm" variant="ghost" onClick={() => { setError(''); setAttempt(n => n + 1) }}>Reconnect</Button></div> : <DesktopScreenLoader />
    return <DesktopTakeoverCard {...props} screen={screen} live={!!socketUrl} />
}
