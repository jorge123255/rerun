'use client'

import { Button } from '@/components/ui/button'
import type { DesktopCoworkerCallOpenTarget } from '@/lib/desktop/coworker-calls-client'
import { DesktopCoworkerCallBlock } from './DesktopCoworkerCallBlock'
import { useDesktopCoworkerCalls } from './useDesktopCoworkerCalls'
import type { ReactNode } from 'react'

export function DesktopCoworkerCalls({ agentId, sessionId, toolCallId, fallback, active = true, currentRunId = null, currentRunActive = false, onOpenTarget }: {
    agentId: string
    sessionId: string
    toolCallId?: string
    fallback?: ReactNode
    active?: boolean
    currentRunId?: string | null
    currentRunActive?: boolean
    onOpenTarget?: (target: DesktopCoworkerCallOpenTarget) => Promise<void>
}) {
    const controller = useDesktopCoworkerCalls(agentId, sessionId, active, currentRunActive)
    const calls = toolCallId ? controller.calls.filter(call => call.toolCallId === toolCallId) : controller.calls
    if (!active && controller.calls.length === 0 && !controller.error) return null
    if (controller.status === 'loading' && calls.length === 0) return fallback ?? <p role="status" className="text-xs text-muted-foreground">Loading coworker calls…</p>
    if (!calls.length && !controller.error) return fallback ?? null
    return <section aria-label="Coworker calls" className="flex min-w-0 flex-col gap-3">
        {controller.error && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
            <span className="min-w-0 break-words">{controller.error}</span>
            <Button type="button" variant="outline" size="sm" disabled={!active} onClick={controller.retry}>Retry coworker calls</Button>
        </div>}
        {calls.map(call => <DesktopCoworkerCallBlock
            key={call.callId}
            client={controller.client}
            call={call}
            active={active}
            live={currentRunActive && (currentRunId === null || call.parentRunId === currentRunId)}
            onOpenTarget={onOpenTarget}
            onChange={controller.replace}
        />)}
    </section>
}
