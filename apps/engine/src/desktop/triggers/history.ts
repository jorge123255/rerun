import type { DesktopTriggerEngineBinding } from './binding.js'
/** Reconcile known identities only. A history read never launches provider work. */
export async function desktopTriggerHistory(binding: DesktopTriggerEngineBinding, id: string, slug?: string) {
    const owner = await binding.authority.resolveOwnerByEngineId(id)
    const events = await binding.store.listEvents(id, slug, 200)
    for (const event of events) {
        if (event.localAgentId !== owner.localAgentId) continue
        if (!event.localSessionId && event.engineSessionId) {
            try {
                const chat = await binding.authority.adoptTriggerSession({ localAgentId: owner.localAgentId, engineAgentId: id, engineSessionId: event.engineSessionId, runId: event.runId, title: event.triggerName })
                await binding.store.updateEvent(id, event.eventId, { localSessionId: chat.sessionId })
            } catch { /* The event remains visible without an unverified chat link. */ }
        }
        if (event.runId && event.engineSessionId && ['accepted', 'running', 'uncertain'].includes(event.status)) {
            const run = await binding.authority.readRun(id, event.runId)
            if (!run || run.agentId !== id || run.sessionId !== event.engineSessionId || run.triggerSource !== 'trigger' || run.triggerSlug !== event.slug || run.status === 'running') continue
            await binding.store.updateEvent(id, event.eventId, { status: run.status === 'cancelled' ? 'cancelled' : run.status === 'error' ? 'error' : 'finished' })
        }
    }
    const current = await binding.store.listEvents(id, slug, 200)
    return { items: await binding.lifecycle.history(id, slug), pending: current.filter(row => row.pendingToolCallId && row.localSessionId).map(row => ({ eventId: row.eventId, localSessionId: row.localSessionId, engineSessionId: row.engineSessionId, toolCallId: row.pendingToolCallId })) }
}
