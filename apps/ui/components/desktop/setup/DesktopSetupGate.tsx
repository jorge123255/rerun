'use client'

import type { DesktopSetupMutationResult, DesktopSetupView } from '@rerun/contracts'
import type { CatalogEntry } from '@rerun/ui/new-agent'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ArrowRightIcon, WrenchIcon } from '@/lib/icons'
import { DesktopInstallGate } from './DesktopInstallGate'
import { useDesktopSetup } from './useDesktopSetup'

// Submission is owned by the server's durable setup receipt. This callback only opens its chat.
export type DesktopOpenSetupChatInput = { agentId: string; sessionId: string; action: 'start' | 'continue' }
export type DesktopOpenSetupChat = (input: DesktopOpenSetupChatInput) => void

export function desktopSetupNeedsSetup(view: DesktopSetupView): boolean {
    return view.required === true && view.completedAt === null && view.prompt.trim().length > 0
}

function claimedSession(result: DesktopSetupMutationResult | null): string | null {
    return result?.sessionId ?? result?.view.sessionId ?? null
}

export function DesktopSetupGate({ agentId, agentName, apps, disabled = false, canStart = true, onStartBlocked, modelSlot, hint, onOpenSetupChat }: {
    agentId: string
    agentName: string
    apps: CatalogEntry[]
    disabled?: boolean
    canStart?: boolean
    onStartBlocked?: () => void
    modelSlot?: ReactNode
    hint?: ReactNode
    onOpenSetupChat: DesktopOpenSetupChat
}) {
    const setup = useDesktopSetup(agentId)

    if (setup.loading && !setup.view) return <p role="status" className="text-xs text-muted-foreground">Loading setup…</p>
    if (!setup.view) {
        return setup.error ? (
            <div className="space-y-2">
                <p role="alert" className="text-xs text-destructive">{setup.error}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => void setup.refresh()}>Retry</Button>
            </div>
        ) : null
    }
    if (!desktopSetupNeedsSetup(setup.view) || setup.view.skipped) return null

    const start = async (): Promise<boolean> => {
        if (!canStart) {
            onStartBlocked?.()
            return false
        }
        const result = await setup.start()
        const sessionId = claimedSession(result)
        if (!result || !sessionId) return false
        onOpenSetupChat({ agentId, sessionId, action: 'start' })
        return true
    }
    const continueSetup = async () => {
        const sessionId = claimedSession(await setup.continueSetup())
        if (sessionId) onOpenSetupChat({ agentId, sessionId, action: 'continue' })
    }
    const gateHint = setup.error ? <>{hint}<p role="alert" className="text-xs text-destructive">{setup.error}</p></> : hint

    return (
        <DesktopInstallGate
            agentId={agentId}
            agentName={agentName}
            apps={apps}
            inProgress={!!setup.view.sessionId}
            disabled={disabled}
            busy={setup.mutating !== null}
            hint={gateHint}
            modelSlot={modelSlot}
            onStart={start}
            onContinue={() => void continueSetup()}
            onSkip={async () => { await setup.skip() }}
        />
    )
}

export function DesktopSetupSkippedBanner({ agentId, canStart = true, disabled = false, onStartBlocked, onOpenSetupChat }: {
    agentId: string
    disabled?: boolean
    canStart?: boolean
    onStartBlocked?: () => void
    onOpenSetupChat: DesktopOpenSetupChat
}) {
    const setup = useDesktopSetup(agentId)
    if (!setup.view || !desktopSetupNeedsSetup(setup.view) || !setup.view.skipped) return null

    const resume = async () => {
        const action = setup.view?.sessionId ? 'continue' : 'start'
        if (action === 'start' && !canStart) {
            onStartBlocked?.()
            return
        }
        const result = action === 'continue' ? await setup.continueSetup() : await setup.start()
        const sessionId = claimedSession(result)
        if (!result || !sessionId) return
        onOpenSetupChat({ agentId, sessionId, action })
    }

    return (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/40 py-1 pr-1.5 pl-3 text-xs text-muted-foreground">
            <WrenchIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">This coworker has not been set up yet</span>
            {setup.error && <span role="alert" className="w-full text-destructive">{setup.error}</span>}
            <Button size="xs" variant="outline" disabled={disabled || setup.mutating !== null} onClick={() => void resume()}>
                Set it up
                <ArrowRightIcon className="size-3" />
            </Button>
        </div>
    )
}
