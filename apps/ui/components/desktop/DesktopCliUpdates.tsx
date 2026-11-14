'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { desktopCliUpdatesSchema, type DesktopCliToolStatus, type DesktopCliUpdateAction } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { useDesktopLocale } from './DesktopLocale'

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

const FAILURES = { offline: 'boardUI.toolOffline', download: 'boardUI.toolDownloadFailed', verification: 'boardUI.toolVerificationFailed', start: 'boardUI.toolStartFailed' } as const

/** One provider's tool version in the connected providers list, with its update when there is one. */
export function DesktopCliToolVersion({ name, status, acting, onAct }: {
    name: string
    status: DesktopCliToolStatus
    acting: boolean
    onAct(action: DesktopCliUpdateAction): void
}) {
    const { t } = useDesktopLocale()
    const { tool, current, latest, pending, state, source, error, step, progress } = status
    const percent = progress === null ? null : Math.round(progress * 100)
    const incoming = pending ?? latest ?? ''
    const working = state !== 'downloading' ? null
        : step === 'verify' ? t('boardUI.toolChecking')
        : step === 'install' ? t('boardUI.toolInstalling', { version: incoming })
        : percent === null ? t('boardUI.toolDownloading', { version: incoming })
        : t('boardUI.toolDownloadingPercent', { version: incoming, percent })
    const version = current ? t('boardUI.toolVersion', { version: current }) : t('boardUI.toolVersionUnknown')
    const button = (label: string, action: DesktopCliUpdateAction, primary = false) =>
        <Button type="button" size="sm" variant={primary ? 'default' : 'outline'} disabled={acting} className="h-6 shrink-0 px-2 text-[11px]"
            aria-label={t('boardUI.toolAction', { action: label, name })} onClick={() => onAct(action)}>{label}</Button>
    return <div data-testid="desktop-cli-tool" data-tool={tool} data-state={state} className="mt-1.5 flex items-start justify-between gap-2 text-[11px]">
        <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-muted-foreground">{state === 'current' && latest && current === latest ? t('boardUI.toolUpToDate', { version }) : version}</p>
            {/* The way back is there for a version that misbehaves; it is not a step anyone has to take. */}
            {state === 'current' && source === 'updated' && <button type="button" disabled={acting} aria-label={t('boardUI.toolAction', { action: t('boardUI.toolUndo'), name })}
                className="text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground disabled:opacity-50"
                title={t('boardUI.toolUndoHint')} onClick={() => onAct({ action: 'revert', tool })}>{t('boardUI.toolUndo')}</button>}
            {state === 'available' && <p className="font-medium text-amber-600 dark:text-amber-400">{t('boardUI.toolAvailable', { version: latest ?? '' })}</p>}
            {state === 'untested' && <p className="text-muted-foreground">{t('boardUI.toolUntested', { version: latest ?? '' })}</p>}
            {working && <p role="status" className="text-muted-foreground">{working}</p>}
            {state === 'waiting' && <p role="status" className="text-muted-foreground">{t('boardUI.toolWaiting', { version: incoming })}</p>}
            {(working || state === 'waiting') && <div role="progressbar" aria-label={t('boardUI.toolUpdating', { name })} aria-valuemin={0} aria-valuemax={100}
                {...(state === 'waiting' ? { 'aria-valuenow': 100 } : step === 'download' && percent !== null ? { 'aria-valuenow': percent } : {})}
                className="mt-1 h-1.5 w-full min-w-40 overflow-hidden rounded-full bg-muted">
                {/* Download fills the first four fifths; checking and installing the rest. A step with no measure pulses. */}
                <div className={`h-full rounded-full bg-primary transition-[width] duration-300 ${state === 'downloading' && (step !== 'download' || percent === null) ? 'animate-pulse' : ''}`}
                    style={{ width: `${state === 'waiting' ? 100 : step === 'install' ? 95 : step === 'verify' ? 85 : percent === null ? 30 : Math.max(3, percent * 0.8)}%` }} />
            </div>}
            {state === 'failed' && error && <p role="alert" className="text-destructive">{t(FAILURES[error])}</p>}
        </div>
        {state === 'available' && button(t('boardUI.toolUpdate'), { action: 'update', tool }, true)}
        {state === 'failed' && button(t('boardUI.toolRetry'), { action: 'update', tool })}
    </div>
}
