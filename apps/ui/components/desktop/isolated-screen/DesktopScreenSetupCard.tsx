'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { desktopScreenSetupSchema, type DesktopScreenSetup } from '@rerun/contracts'
import { MonitorIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { desktopMacSettings } from '../DesktopMacSettings'

const DOCKER_DOWNLOAD = 'https://www.docker.com/products/docker-desktop/'
const FAILURES: Record<NonNullable<DesktopScreenSetup['install']['error']>, string> = {
    offline: 'The download did not finish. Check your connection and try again.',
    docker: 'Docker stopped answering. Check that Docker is open, then try again.',
    build: 'The screen could not be installed. Try again.',
}

async function read(init?: RequestInit): Promise<DesktopScreenSetup> {
    const response = await fetch('/api/desktop/isolated-screen/setup', { cache: 'no-store', ...init })
    if (!response.ok) throw new Error('Screen setup is unavailable')
    return desktopScreenSetupSchema.parse(await response.json())
}

/**
 * A coworker's own screen and browser run in an isolated Linux container, which needs three things
 * on this Mac: Docker, Docker running, and the screen itself installed once. This card says which
 * one is missing and offers the one button that gets past it. It shows nothing when all three are
 * there, and it never installs or starts anything without a click.
 */
export function DesktopScreenSetupCard({ onReady, className }: { onReady?: () => void; className?: string }) {
    const [setup, setSetup] = useState<DesktopScreenSetup | null>(null)
    const [busy, setBusy] = useState(false)
    const ready = useRef(onReady)
    useEffect(() => { ready.current = onReady }, [onReady])
    const wasMissing = useRef(false)

    const refresh = useCallback(async () => {
        try {
            const next = await read()
            setSetup(next)
            if (next.need !== 'nothing') wasMissing.current = true
            else if (wasMissing.current) { wasMissing.current = false; ready.current?.() }
        } catch { /* The card stays as it was; the next check may answer. */ }
    }, [])
    const need = setup?.need, installing = setup?.install.state === 'installing'
    useEffect(() => {
        void refresh()
        // While something is missing the person is acting on it (opening Docker, installing), so check often.
        const timer = setInterval(() => void refresh(), need === undefined || need === 'nothing' ? 60_000 : 3_000)
        return () => clearInterval(timer)
    }, [refresh, need])

    if (!setup || setup.need === 'nothing') return null
    const act = async (action: 'install' | 'cancel') => {
        setBusy(true)
        try { setSetup(await read({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })) } catch { /* shown by the next check */ } finally { setBusy(false) }
    }
    const openDocker = desktopMacSettings()?.openDocker
    const { step, steps, error } = setup.install
    const percent = installing && step !== null && steps ? Math.round(step / steps * 100) : null
    const copy = setup.need === 'docker' ? { title: 'Coworker screens need Docker', text: 'A coworker’s own browser and screen run in an isolated Linux container, kept apart from your Mac. Install Docker Desktop, open it once, and come back here.' }
        : setup.need === 'docker-running' ? { title: 'Docker is not running', text: 'Open Docker and wait for it to finish starting. This card goes away on its own.' }
        : setup.need === 'image' ? { title: 'Install the coworker screen', text: installing ? 'Downloading a small Linux system with a browser and setting it up. This takes a few minutes the first time.' : 'One more step: a small Linux system with a browser, downloaded once (about 400 MB) and used by every coworker.' }
        : { title: 'Coworker screens are not available on this Mac', text: 'Docker on this Mac does not run Linux for Apple silicon, which the coworker screen needs.' }

    return <div role="group" aria-label={copy.title} className={`flex flex-col gap-2 rounded-xl border p-3 text-sm ${className ?? ''}`}>
        <div className="flex items-start gap-2">
            <MonitorIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
                <p className="font-medium">{copy.title}</p>
                <p className="text-xs text-muted-foreground">{copy.text}</p>
            </div>
        </div>
        {installing && <div role="progressbar" aria-label="Installing the coworker screen" aria-valuemin={0} aria-valuemax={100} {...(percent !== null ? { 'aria-valuenow': percent } : {})}
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className={`h-full rounded-full bg-primary transition-[width] duration-300 ${percent === null ? 'animate-pulse' : ''}`} style={{ width: `${percent === null ? 15 : Math.max(5, percent)}%` }} />
        </div>}
        {!installing && error && setup.need === 'image' && <p role="alert" className="text-xs text-destructive">{FAILURES[error]}</p>}
        <div className="flex flex-wrap gap-2">
            {setup.need === 'docker' && <Button size="sm" onClick={() => window.open(DOCKER_DOWNLOAD, '_blank', 'noopener')}>Get Docker Desktop</Button>}
            {setup.need === 'docker-running' && openDocker && <Button size="sm" onClick={() => void openDocker().catch(() => {})}>Open Docker</Button>}
            {setup.need === 'image' && !installing && <Button size="sm" disabled={busy} onClick={() => void act('install')}>{error ? 'Try again' : 'Install'}</Button>}
            {setup.need === 'image' && installing && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('cancel')}>Cancel</Button>}
        </div>
    </div>
}
