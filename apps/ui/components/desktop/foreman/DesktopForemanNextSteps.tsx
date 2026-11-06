'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { DesktopForemanNextStep, DesktopLeadSetupState } from '@/lib/desktop/foreman-client'

export function DesktopForemanNextSteps({
    steps,
    leadState,
    live,
    onStartLead,
    onOpenCreated,
}: {
    steps: DesktopForemanNextStep[]
    leadState: DesktopLeadSetupState
    live: boolean
    onStartLead: (step: Extract<DesktopForemanNextStep, { kind: 'start_lead' }>) => void | Promise<void>
    onOpenCreated: (step: Extract<DesktopForemanNextStep, { kind: 'open_created' }>) => void
}) {
    const [step] = steps
    const [starting, setStarting] = useState(false)
    if (!step) return null

    if (step.kind === 'unavailable') {
        return (
            <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground" role="status">
                {step.label}: {step.reason}
            </div>
        )
    }

    if (!live) {
        return (
            <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground" role="status">
                This step is only available in the live Foreman chat.
            </div>
        )
    }

    if (step.kind === 'open_created') {
        return (
            <Button size="lg" className="w-full" onClick={() => onOpenCreated(step)}>
                {step.label}
            </Button>
        )
    }

    if (leadState.status === 'started' && leadState.agentId === step.agentId) {
        return (
            <Button
                size="lg"
                className="w-full"
                variant="secondary"
                onClick={() => onOpenCreated({ kind: 'open_created', label: 'Open chat', agentId: leadState.agentId, boxId: null, sessionId: leadState.sessionId })}
            >
                {step.startedLabel}
            </Button>
        )
    }

    if (leadState.status === 'starting' && leadState.agentId === step.agentId) {
        return <Skeleton className="h-10 w-full rounded-md" />
    }

    return (
        <Button
            size="lg"
            className="w-full"
            disabled={starting || leadState.status === 'starting'}
            onClick={() => {
                setStarting(true)
                void Promise.resolve(onStartLead(step)).finally(() => setStarting(false))
            }}
        >
            {starting ? 'Starting…' : step.label}
        </Button>
    )
}
