import { findDesktopQuestion, findDesktopApproval, findDesktopTakeover, findDesktopServiceRequest, findDesktopSecretRequest, hitlKindOf } from '@rerun/contracts'
import { listMessages } from '../../db/repos/messages.js'
import { getSystemDb } from '../../db/systemDb.js'
import { withAgentLock } from '../../agents/lock.js'
import { findDesktopMcpSignInCall } from '../mcp-sign-in/source.js'
import type { DesktopTriggerEngineBinding } from './binding.js'

/** A done run can still be waiting for a human; its settlement callback is not durable. */
export async function readDesktopTriggerPendingTool(agentId: string, sessionId: string, runId: string): Promise<string | null> {
    const rows = await listMessages(agentId, sessionId)
    if (rows.some(row => row.sessionId !== sessionId)) throw new Error('Webhook transcript ownership changed')
    const forms = [
        { kind: 'question', request: findDesktopQuestion(rows) },
        { kind: 'approval', request: findDesktopApproval(rows) },
        { kind: 'takeover', request: findDesktopTakeover(rows) },
        { kind: 'service', request: findDesktopServiceRequest(rows) },
        { kind: 'secret', request: findDesktopSecretRequest(rows) },
        { kind: 'mcp', request: findDesktopMcpSignInCall(rows) },
    ].filter(form => form.request)
    if (!forms.length) return null
    if (forms.length !== 1) throw new Error('Webhook human request is ambiguous')
    const { kind, request } = forms[0]!
    const { client } = await getSystemDb(agentId)
    const calls = (await client.execute({
        sql: 'SELECT run_id,tool_name,is_error FROM tool_calls WHERE agent_id=? AND session_id=? AND tool_call_id=? LIMIT 2',
        args: [agentId, sessionId, request!.toolCallId],
    })).rows
    if (calls.length !== 1 || calls[0]!.run_id !== runId || Number(calls[0]!.is_error) !== 0 || hitlKindOf(String(calls[0]!.tool_name)) !== kind) throw new Error('Webhook human request source changed')
    return request!.toolCallId
}
/** Reconcile known identities only. A history read never launches provider work. */
export async function desktopTriggerHistory(binding: DesktopTriggerEngineBinding, id: string, slug?: string) {
    // Human admission and Stop share this lock. A verified terminal projection must
    // not overwrite a Stop or a newly admitted continuation while it is being saved.
    return withAgentLock(id, () => reconcileDesktopTriggerHistory(binding, id, slug))
}
async function reconcileDesktopTriggerHistory(binding: DesktopTriggerEngineBinding, id: string, slug?: string) {
    const owner = await binding.authority.resolveOwnerByEngineId(id)
    const events = await binding.store.listEvents(id, slug, 200)
    for (const event of events) {
        if (event.localAgentId !== owner.localAgentId || event.stopRequestId) continue
        if (!event.localSessionId && event.engineSessionId) {
            try {
                const chat = await binding.authority.adoptTriggerSession({ localAgentId: owner.localAgentId, engineAgentId: id, engineSessionId: event.engineSessionId, runId: event.runId, title: event.triggerName })
                await binding.store.updateEvent(id, event.eventId, { localSessionId: chat.sessionId })
            } catch { /* The event remains visible without an unverified chat link. */ }
        }
        if (event.runId && event.engineSessionId && ['accepted', 'running', 'uncertain'].includes(event.status)) {
            const run = await binding.authority.readRun(id, event.runId)
            if (!run || run.id !== event.runId || run.agentId !== id || run.sessionId !== event.engineSessionId || run.triggerSource !== 'trigger' || run.triggerSlug !== event.slug || run.status === 'running') continue
            if (run.status === 'done') {
                try {
                    const pendingToolCallId = await readDesktopTriggerPendingTool(id, event.engineSessionId, event.runId)
                    await binding.store.updateEvent(id, event.eventId, { status: pendingToolCallId ? 'needs-input' : 'finished', pendingToolCallId, error: null })
                } catch {
                    await binding.store.updateEvent(id, event.eventId, { status: 'uncertain', error: 'The saved webhook request could not be confirmed. Open its chat.' })
                }
            } else await binding.store.updateEvent(id, event.eventId, { status: run.status === 'cancelled' ? 'cancelled' : run.status === 'error' ? 'error' : 'uncertain' })
        }
    }
    const current = await binding.store.listEvents(id, slug, 200)
    const items = await binding.lifecycle.history(id, slug)
    const pending = current.filter(row => row.pendingToolCallId && row.localSessionId && !row.stopRequestId && row.status !== 'cancelled').map(row => ({ eventId: row.eventId, localSessionId: row.localSessionId, engineSessionId: row.engineSessionId, toolCallId: row.pendingToolCallId }))
    for (const event of current) {
        if (event.localAgentId !== owner.localAgentId || !event.runId || !event.engineSessionId || !event.localSessionId || event.stopRequestId || event.status === 'cancelled') continue
        const admissions = await binding.store.listHumanAdmissions?.(id,event.eventId,event.engineSessionId) ?? []
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
        if (!run || run.id!==latest || run.agentId!==id || run.sessionId!==event.engineSessionId || !admissions.length && (run.triggerSource !== 'trigger' || run.triggerSlug !== event.slug)) { item.status='uncertain'; continue }
        if (run.status !== 'done') { item.status=run.status==='running'?'running':run.status==='cancelled'?'cancelled':'error'; continue }
        const index=pending.findIndex(row=>row.eventId===event.eventId)
        if(index>=0) pending.splice(index,1)
        try {
            const toolCallId = await readDesktopTriggerPendingTool(id, event.engineSessionId, latest)
            item.status=toolCallId?'needs-input':'finished'
            if(toolCallId)pending.push({eventId:event.eventId,localSessionId:event.localSessionId,engineSessionId:event.engineSessionId,toolCallId})
            if (event.status !== item.status || event.pendingToolCallId !== toolCallId || event.error) {
                await binding.store.updateEvent(id, event.eventId, { status: item.status, pendingToolCallId: toolCallId, error: null })
                item.finishedAt = (await binding.store.getEvent(id, event.eventId))?.finishedAt ?? item.finishedAt
            }
            item.error = null
        } catch { item.status='uncertain' }
    }
    return {items,pending}
}
