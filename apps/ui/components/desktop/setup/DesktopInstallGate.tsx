'use client'

import { Button } from '@/components/ui/button'
import { ArrowRightIcon } from '@/lib/icons'
import { AgentBuddy } from '@rerun/ui/iso-grid'
import { CoinStack, type CatalogEntry } from '@rerun/ui/new-agent'
import { Spinner } from '@rerun/ui/primitives'
import { type ReactNode, useState } from 'react'

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? '' : 's'}`
}

function setupFacts(apps: CatalogEntry[]): string {
    const minutes = `~${Math.max(2, 1 + apps.length)} min`
    return apps.length > 0 ? `${plural(apps.length, 'app')} · ${minutes}` : minutes
}

export function DesktopInstallGate({
    agentId,
    agentName,
    apps,
    onStart,
    onSkip,
    onContinue,
    inProgress = false,
    disabled = false,
    busy = false,
    modelSlot,
    hint,
}: {
    agentId: string
    agentName: string
    apps: CatalogEntry[]
    onStart: () => Promise<boolean>
    onSkip: () => Promise<void>
    onContinue?: () => void
    inProgress?: boolean
    disabled?: boolean
    busy?: boolean
    modelSlot?: ReactNode
    hint?: ReactNode
}) {
    const [launched, setLaunched] = useState(false)
    const [skipping, setSkipping] = useState(false)
    // A disabled coworker cannot start, but it is not running an installation. Only an
    // actual setup mutation (including one submitted by another surface) owns the spinner.
    const starting = (!inProgress && launched) || skipping || busy
    const blocked = disabled || starting

    const start = async () => {
        setLaunched(true)
        try {
            if (!await onStart()) setLaunched(false)
        } catch {
            setLaunched(false)
        }
    }

    const skip = async () => {
        setSkipping(true)
        try { await onSkip() } finally { setSkipping(false) }
    }

    return (
        <div className="space-y-3 [--cut:var(--color-background)]">
            <div className="flex items-center gap-3">
                <AgentBuddy agentId={agentId} mood={inProgress ? 'idle' : starting ? 'working' : 'waiting'} size={40} facing="right" alive />
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{inProgress ? `${agentName} is being set up` : `Set up ${agentName}`}</p>
                    <p className="text-xs text-pretty text-muted-foreground">{inProgress ? 'In another conversation' : setupFacts(apps)}</p>
                </div>
                {apps.length > 0 && <CoinStack apps={apps} size={24} overlap={7} className="shrink-0" />}
            </div>
            {hint}
            {inProgress ? (
                <Button size="lg" disabled={disabled || busy || skipping} onClick={onContinue} className="w-full">
                    Continue setup
                    <ArrowRightIcon data-icon="inline-end" />
                </Button>
            ) : (
                <Button size="lg" disabled={blocked} aria-busy={starting || undefined} onClick={() => void start()} className="w-full">
                    {starting && <Spinner data-icon="inline-start" />}
                    <span className="truncate">{starting ? 'Installing' : `Install ${agentName}`}</span>
                    {!starting && <ArrowRightIcon data-icon="inline-end" />}
                </Button>
            )}
            <div className="flex flex-wrap items-center justify-between gap-1">
                {modelSlot}
                <Button size="sm" variant="ghost" disabled={blocked} onClick={() => void skip()} className="ml-auto text-muted-foreground">
                    Skip for now
                </Button>
            </div>
        </div>
    )
}
