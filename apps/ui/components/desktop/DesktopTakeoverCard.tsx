'use client'

import { useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ScreenCard } from './ScreenCard'
import { TakeoverAsk } from '@/components/chat/TakeoverAsk'
import { siteOf } from '@rerun/contracts'
import type { DesktopPendingTakeover, DesktopTakeoverAction } from '@/lib/desktop/takeover'

export type DesktopTakeoverCardProps = {
    takeover: DesktopPendingTakeover
    disabled?: boolean
    screen?: ReactNode
    live?: boolean
    onAction: (payload: DesktopTakeoverAction) => Promise<void>
}

export function DesktopTakeoverCard({ takeover, disabled, onAction, screen, live }: DesktopTakeoverCardProps) {
    const requestIds = useRef<{ open: string; done: string; skip: string } | null>(null)
    requestIds.current ??= { open: crypto.randomUUID(), done: crypto.randomUUID(), skip: crypto.randomUUID() }
    const inFlight = useRef(false)
    const [opened, setOpened] = useState(takeover.opened)
    const [finishing, setFinishing] = useState<'done' | 'skip' | null>(null)
    const [sent, setSent] = useState(false)
    const [error, setError] = useState('')

    const locked = !!disabled || finishing !== null || sent
    const attempt = takeover.attempt

    async function act(action: 'open' | 'done' | 'skip') {
        if (locked || inFlight.current) return
        inFlight.current = true
        setError('')
        if (action === 'done' || action === 'skip') setFinishing(action)
        try {
            await onAction({ action, takeoverId: takeover.id, requestId: attempt?.action === action ? attempt.requestId : requestIds.current![action] })
            if (action === 'open') setOpened(true)
            else setSent(true)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not reach the coworker’s screen. Try again.')
        } finally {
            inFlight.current = false
            setFinishing(null)
        }
    }

    const state = {
            reason: takeover.reason,
            site: siteOf(takeover.url),
            opened: opened || takeover.opened,
            locked: locked || sent,
            finishing: finishing !== null,
            onOpen: () => { void act('open') },
            onSkip: () => { void act('skip') },
            onDone: () => { void act('done') },
    }

    return <div className="space-y-2">
        {attempt && !sent && <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">{attempt.action === 'done' ? 'Finishing the takeover was interrupted.' : 'Skipping the takeover was interrupted.'}</p>
            <Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => { void act(attempt.action).catch(() => {}) }}>
                Retry {attempt.action === 'done' ? 'finish' : 'skip'}
            </Button>
        </div>}
        {screen ? <ScreenCard live={!!live} site={siteOf(takeover.url)} screen={screen} takeover={state} onTakeControl={() => void act('open')} /> : <TakeoverAsk takeover={state} />}
        {error && <p role="alert" className="px-3 text-sm text-destructive">{error}</p>}
    </div>
}
