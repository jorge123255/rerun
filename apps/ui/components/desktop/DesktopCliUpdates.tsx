'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { desktopCliUpdatesSchema, type DesktopCliToolStatus, type DesktopCliUpdateAction } from '@rerun/contracts'
import { Button } from '@/components/ui/button'

const BUSY: readonly DesktopCliToolStatus['state'][] = ['downloading', 'waiting']

/**
 * The versions of the plan tools this app runs, and what their vendors have published since. Read
 * when the header appears and every half hour; every few seconds while an update is under way.
 * Nothing is read while no connected provider runs on one of these tools.
 */
export function useDesktopCliUpdates(enabled: boolean) {
    const [tools, setTools] = useState<readonly DesktopCliToolStatus[]>([])
    const [acting, setActing] = useState(false)
    const alive = useRef(true)
    const read = useCallback(async (action?: DesktopCliUpdateAction) => {
        try {
            const response = await fetch('/api/desktop/cli-updates', action
                ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) }
                : { cache: 'no-store' })
            if (!response.ok) return
            const parsed = desktopCliUpdatesSchema.safeParse(await response.json())
            if (parsed.success && alive.current) setTools(parsed.data.tools)
        } catch {
            // The list keeps what it last showed; the next read tries again.
        }
    }, [])
    const busy = tools.some(tool => BUSY.includes(tool.state))
    useEffect(() => {
        if (!enabled) return
        alive.current = true
        void read()
        const timer = setInterval(() => { void read() }, busy ? 3000 : 30 * 60_000)
        return () => { alive.current = false; clearInterval(timer) }
    }, [read, busy, enabled])
    const act = useCallback(async (action: DesktopCliUpdateAction) => {
        setActing(true)
        try { await read(action) } finally { if (alive.current) setActing(false) }
    }, [read])
    return { tools, act, acting }
}

const FAILURES: Record<NonNullable<DesktopCliToolStatus['error']>, string> = {
    offline: 'The update could not be reached. Check the connection and try again.',
    download: 'The download did not finish.',
    verification: 'The download did not pass its checks, so it was not installed.',
    start: 'The new version did not start, so the current one was kept.',
}

/** One provider's tool version in the connected providers list, with its update when there is one. */
export function DesktopCliToolVersion({ name, status, acting, onAct }: {
    name: string
    status: DesktopCliToolStatus
    acting: boolean
    onAct(action: DesktopCliUpdateAction): void
}) {
    const { tool, current, latest, pending, state, source, error, step, progress } = status
    const percent = progress === null ? null : Math.round(progress * 100)
    const working = state === 'downloading'
        ? step === 'verify' ? 'Checking the download…' : step === 'install' ? `Installing version ${pending ?? ''}…`.replace(' …', '…')
            : `Downloading${pending ? ` version ${pending}` : ''}…${percent === null ? '' : ` ${percent}%`}`
        : null
    const version = current ? `Version ${current}` : 'Version unknown'
    const button = (label: string, action: DesktopCliUpdateAction, primary = false) =>
        <Button type="button" size="sm" variant={primary ? 'default' : 'outline'} disabled={acting} className="h-6 shrink-0 px-2 text-[11px]"
            aria-label={`${label}: ${name}`} onClick={() => onAct(action)}>{label}</Button>
    return <div data-testid="desktop-cli-tool" data-tool={tool} data-state={state} className="mt-1.5 flex items-start justify-between gap-2 text-[11px]">
        <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-muted-foreground">{version}{source === 'updated' ? ' · updated in this app' : ''}</p>
            {state === 'available' && <p className="font-medium text-amber-600 dark:text-amber-400">Version {latest} is available.</p>}
            {state === 'untested' && <p className="text-muted-foreground">Version {latest} is out but not yet tested with this app.</p>}
            {working && <p role="status" className="text-muted-foreground">{working}</p>}
            {state === 'waiting' && <p role="status" className="text-muted-foreground">Version {pending} is ready. It takes over when the running coworkers finish.</p>}
            {(working || state === 'waiting') && <div role="progressbar" aria-label={`Updating ${name}`} aria-valuemin={0} aria-valuemax={100}
                {...(state === 'waiting' ? { 'aria-valuenow': 100 } : step === 'download' && percent !== null ? { 'aria-valuenow': percent } : {})}
                className="mt-1 h-1.5 w-full min-w-40 overflow-hidden rounded-full bg-muted">
                {/* Download fills the first four fifths; checking and installing the rest. A step with no measure pulses. */}
                <div className={`h-full rounded-full bg-primary transition-[width] duration-300 ${state === 'downloading' && (step !== 'download' || percent === null) ? 'animate-pulse' : ''}`}
                    style={{ width: `${state === 'waiting' ? 100 : step === 'install' ? 95 : step === 'verify' ? 85 : percent === null ? 30 : Math.max(3, percent * 0.8)}%` }} />
            </div>}
            {state === 'failed' && error && <p role="alert" className="text-destructive">{FAILURES[error]}</p>}
        </div>
        {state === 'available' && button('Update', { action: 'update', tool }, true)}
        {state === 'failed' && button('Try again', { action: 'update', tool })}
        {state === 'current' && source === 'updated' && button('Use built-in', { action: 'revert', tool })}
    </div>
}
