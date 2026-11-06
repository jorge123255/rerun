'use client'

import { Button } from '@/components/ui/button'
import { FolderIcon, GlobeIcon, TerminalIcon } from '@/lib/icons'
import type { ComputerLaunchAvailability, ComputerPanelApp } from '@/lib/desktop/computer-panel/contract'
import type { LaunchAttempt } from '@/lib/desktop/computer-panel/launch'

const ICONS = { browser: GlobeIcon, files: FolderIcon, terminal: TerminalIcon } as const

type Props = {
    availability: ComputerLaunchAvailability[]
    attempt: LaunchAttempt | null
    /** Browser opens root's existing full viewer (accepted takeover/drive path). */
    onBrowser: () => void
    onLaunch: (app: 'terminal' | 'files') => void
    onClearAttempt: () => void
}

/** Original DesktopNotch launcher row (Browser, Files, Terminal; icon-sm ghost buttons, labels as tooltips/aria). */
export function ComputerLaunchControls({ availability, attempt, onBrowser, onLaunch, onClearAttempt }: Props) {
    const pending = attempt?.phase === 'pending'
    const uncertain = attempt?.phase === 'uncertain' ? attempt.app : null
    const status = attempt && statusText(attempt, availability)
    return (
        <div className="flex max-w-[95%] flex-wrap items-center gap-1" role="toolbar" aria-label="Open on this coworker’s screen">
            {availability.map(item => {
                const Icon = ICONS[item.app as ComputerPanelApp]
                const blocked = item.state !== 'ready' || pending || (uncertain !== null && uncertain !== item.app)
                const reason = item.state !== 'ready' ? item.reason : undefined
                return (
                    <Button key={item.app} type="button" size="icon-sm" variant="ghost" aria-label={item.label} title={reason ?? item.label}
                        aria-disabled={blocked || undefined} disabled={blocked} data-state={item.state}
                        onClick={() => (item.app === 'browser' ? onBrowser() : onLaunch(item.app))}>
                        <Icon className="size-4" />
                    </Button>
                )
            })}
            {status && (
                <p role={attempt?.phase === 'failed' ? 'alert' : 'status'} className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                    <span>{status}</span>
                    {attempt?.phase === 'uncertain' && <Button type="button" size="sm" variant="ghost" onClick={() => onLaunch(attempt.app)}>Try again</Button>}
                    {(attempt?.phase === 'failed' || attempt?.phase === 'acknowledged') && <Button type="button" size="sm" variant="ghost" aria-label="Dismiss" onClick={onClearAttempt}>OK</Button>}
                </p>
            )}
        </div>
    )
}

function statusText(attempt: LaunchAttempt, availability: ComputerLaunchAvailability[]): string {
    const label = availability.find(item => item.app === attempt.app)?.label ?? attempt.app
    switch (attempt.phase) {
        case 'pending': return `Opening ${label}…`
        case 'acknowledged': return attempt.outcome.status === 'focused' ? `${label} is in front.` : `${label} opened.`
        case 'failed': case 'uncertain': return attempt.reason
    }
}
