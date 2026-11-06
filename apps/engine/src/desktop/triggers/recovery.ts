import type { DesktopTriggerAuthority, DesktopTriggerStore } from './types.js'
import { readDesktopTriggerPendingTool } from './history.js'

/**
 * Restart reconciliation for accepted/running/finished/cancelled/uncertain events.
 * Never replays an already admitted provider call merely because the Mac restarted.
 */
export async function recoverDesktopTriggerOwner(input: {
    authority: DesktopTriggerAuthority
    store: DesktopTriggerStore
    engineAgentId: string
}): Promise<{ uncertain: number; finished: number; cancelled: number }> {
    const { authority, store, engineAgentId } = input
    await store.initialize(engineAgentId)
    await store.recoverUncertain(engineAgentId)

    const events = await store.listEvents(engineAgentId, undefined, 500)
    let uncertain = 0
    let finished = 0
    let cancelled = 0

    for (const event of events) {
        if (event.status !== 'uncertain' && event.status !== 'running' && event.status !== 'accepted') continue
        if (!event.runId) {
            if (event.status !== 'uncertain') await store.updateEvent(engineAgentId, event.eventId, { status: 'uncertain', error: 'Interrupted before run id was recorded' })
            uncertain++
            continue
        }
        const run = await authority.readRun(engineAgentId, event.runId)
        if (!run || run.id !== event.runId || run.agentId !== engineAgentId || run.triggerSource !== 'trigger' || run.triggerSlug !== event.slug || run.sessionId !== event.engineSessionId) {
            await store.updateEvent(engineAgentId, event.eventId, { status: 'uncertain', error: 'Run ownership could not be confirmed after restart' })
            uncertain++
            continue
        }
        if (run.status === 'running') {
            // Leave as uncertain for UI honesty — do not resume the provider call.
            await store.updateEvent(engineAgentId, event.eventId, { status: 'uncertain', runId: run.id, engineSessionId: run.sessionId, error: 'App restarted while the trigger run was active' })
            uncertain++
            continue
        }
        if (run.status === 'cancelled') {
            await store.updateEvent(engineAgentId, event.eventId, { status: 'cancelled', runId: run.id, engineSessionId: run.sessionId })
            cancelled++
            continue
        }
        if (run.status === 'error') {
            await store.updateEvent(engineAgentId, event.eventId, { status: 'error', runId: run.id, engineSessionId: run.sessionId })
            finished++
            continue
        }
        try {
            if (run.status !== 'done') throw new Error('Webhook run has an unknown status')
            const pendingToolCallId = await readDesktopTriggerPendingTool(engineAgentId, run.sessionId, run.id)
            await store.updateEvent(engineAgentId, event.eventId, { status: pendingToolCallId ? 'needs-input' : 'finished', pendingToolCallId, runId: run.id, engineSessionId: run.sessionId, error: null })
            finished++
        } catch {
            await store.updateEvent(engineAgentId, event.eventId, { status: 'uncertain', error: 'The saved webhook request could not be confirmed after restart. Open its chat.' })
            uncertain++
        }
    }

    return { uncertain, finished, cancelled }
}
