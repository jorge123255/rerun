import { findDesktopQuestion, findDesktopApproval, findDesktopTakeover, findDesktopServiceRequest, findDesktopSecretRequest } from '@rerun/contracts'
import { listMessages } from '../../db/repos/messages.js'
import { findDesktopMcpSignInCall } from '../mcp-sign-in/source.js'
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
    const items = await binding.lifecycle.history(id, slug)
    const pending = current.filter(row => row.pendingToolCallId && row.localSessionId).map(row => ({ eventId: row.eventId, localSessionId: row.localSessionId, engineSessionId: row.engineSessionId, toolCallId: row.pendingToolCallId }))
    for (const event of current) {
        if (!event.runId || !event.engineSessionId || !event.localSessionId || event.stopRequestId || event.status === 'cancelled') continue
        const admissions = await binding.store.listHumanAdmissions?.(id,event.eventId,event.engineSessionId) ?? []
        if (!admissions.length) continue
        const item = items.find(row=>row.eventId===event.eventId)
        if (!item) continue
        let latest = event.runId, count = 0
        for (;;) {
            const next = admissions.filter(row=>row.sourceRunId===latest)
            if (!next.length) break
            if (next.length !== 1 || ++count > 64) { count = -1; break }
            latest = String(next[0].runId)
        }
        if (count < 0 || count !== admissions.length) { item.status='uncertain'; continue }
        const run = await binding.authority.readRun(id,latest)
        if (!run || run.agentId!==id || run.sessionId!==event.engineSessionId) { item.status='uncertain'; continue }
        if (run.status !== 'done') { item.status=run.status==='running'?'running':run.status==='cancelled'?'cancelled':'error'; continue }
        const rows=await listMessages(id,event.engineSessionId)
        const request=findDesktopQuestion(rows)??findDesktopApproval(rows)??findDesktopTakeover(rows)??findDesktopServiceRequest(rows)??findDesktopSecretRequest(rows)??findDesktopMcpSignInCall(rows)
        item.status=request?'needs-input':'finished'
        const index=pending.findIndex(row=>row.eventId===event.eventId)
        if(index>=0) pending.splice(index,1)
        if(request)pending.push({eventId:event.eventId,localSessionId:event.localSessionId,engineSessionId:event.engineSessionId,toolCallId:request.toolCallId})
    }
    return {items,pending}
}
