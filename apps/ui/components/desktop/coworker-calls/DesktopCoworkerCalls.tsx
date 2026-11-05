'use client'

import { Button } from '@/components/ui/button'
import type { DesktopCoworkerCallOpenTarget } from '@/lib/desktop/coworker-calls-client'
import { DesktopCoworkerCallBlock } from './DesktopCoworkerCallBlock'
import { useDesktopCoworkerCalls } from './useDesktopCoworkerCalls'

export function DesktopCoworkerCalls({ agentId, sessionId, active = true, onOpenTarget }: {
    agentId: string
    sessionId: string
    active?: boolean
    onOpenTarget?: (target: DesktopCoworkerCallOpenTarget) => Promise<void>
}) {
    const controller = useDesktopCoworkerCalls(agentId, sessionId, active)
    if (!controller.calls.length && !controller.error) return null
    return <section aria-label="Coworker calls" className="flex min-w-0 flex-col gap-3">
        {controller.error && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
            <span className="min-w-0 break-words">{controller.error}</span>
            <Button type="button" variant="outline" size="sm" disabled={!active} onClick={controller.retry}>Retry coworker calls</Button>
        </div>}
        {controller.calls.map(call => <DesktopCoworkerCallBlock
            key={call.callId}
            client={controller.client}
            call={call}
            active={active}
            onOpenTarget={onOpenTarget}
            onChange={controller.replace}
        />)}
    </section>
}
