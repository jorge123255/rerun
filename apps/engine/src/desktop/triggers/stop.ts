import { desktopTriggerStopSchema } from '@rerun/contracts'
import type { DesktopTriggerAuthority, DesktopTriggerStore } from './types.js'

export class DesktopTriggerStopError extends Error {
    constructor(readonly status: number, message: string) {
        super(message)
        this.name = 'DesktopTriggerStopError'
    }
}

/** Exact owner/session/run Stop — never cancels sibling trigger runs. */
export async function stopDesktopTriggerRun(input: {
    authority: DesktopTriggerAuthority
    store: DesktopTriggerStore
    engineAgentId: string
    localAgentId: string
    body: unknown
}): Promise<{ canceled: boolean; alreadyFinished: boolean; eventId: string | null }> {
    const body = desktopTriggerStopSchema.parse(input.body)
    input.authority.assertActive()
    const owner = await input.authority.resolveOwnerByEngineId(input.engineAgentId)
    if (owner.localAgentId !== input.localAgentId || owner.deleting) throw new DesktopTriggerStopError(409, 'Coworker identity changed')
    await input.authority.assertTriggerGrant(input.engineAgentId)

    const events = await input.store.listEvents(input.engineAgentId, undefined, 300)
    const match = events.find(event => {
        if (body.expectedEventId && event.eventId !== body.expectedEventId) return false
        return event.runId === body.runId && event.localSessionId === body.localSessionId
    })
    if (!match) throw new DesktopTriggerStopError(404, 'Trigger run not found for this conversation')

    const run = await input.authority.readRun(input.engineAgentId, body.runId)
    if (!run || run.agentId !== input.engineAgentId || run.triggerSource !== 'trigger' || run.triggerSlug !== match.slug) {
        throw new DesktopTriggerStopError(409, 'Run belongs to another conversation')
    }
    if (run.status !== 'running') {
        await input.store.updateEvent(input.engineAgentId, match.eventId, {
            status: run.status === 'cancelled' ? 'cancelled' : run.status === 'error' ? 'error' : 'finished',
        })
        return { canceled: false, alreadyFinished: true, eventId: match.eventId }
    }

    await input.authority.cancelExactRun(input.engineAgentId, body.runId)
    await input.store.updateEvent(input.engineAgentId, match.eventId, { status: 'cancelled' })
    return { canceled: true, alreadyFinished: false, eventId: match.eventId }
}
