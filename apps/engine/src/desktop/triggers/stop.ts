import { createHash } from 'node:crypto'
import { desktopTriggerStopSchema } from '@rerun/contracts'
import { withKeyedLock } from '../../lib/lock.js'
import { withAgentLock } from '../../agents/lock.js'
import type { DesktopTriggerAuthority, DesktopTriggerStore } from './types.js'
export class DesktopTriggerStopError extends Error { constructor(readonly status: number, message: string) { super(message); this.name = 'DesktopTriggerStopError' } }
export async function stopDesktopTriggerRun(input: { authority: DesktopTriggerAuthority; store: DesktopTriggerStore; engineAgentId: string; localAgentId: string; body: unknown }): Promise<{ canceled: boolean; alreadyFinished: boolean; eventId: string | null }> {
    const body = desktopTriggerStopSchema.parse(input.body), id = input.engineAgentId
    return withKeyedLock(`desktop-trigger-stop:${id}`, async () => {
        const prepared = await withAgentLock(id, async () => {
        input.authority.assertActive()
        const owner = await input.authority.resolveOwnerByEngineId(id)
        if (owner.localAgentId !== input.localAgentId || owner.engineAgentId !== id || owner.deleting) throw new DesktopTriggerStopError(409, 'Coworker identity changed')
        const match = body.expectedEventId ? await input.store.getEvent(id, body.expectedEventId) : (await input.store.listEvents(id, undefined, 300)).find(row => row.runId === body.runId && row.localSessionId === body.localSessionId)
        if (!match || match.localAgentId !== owner.localAgentId || match.runId !== body.runId || match.localSessionId !== body.localSessionId || !match.engineSessionId) throw new DesktopTriggerStopError(404, 'Trigger run not found for this conversation')
        const fingerprint = createHash('sha256').update(JSON.stringify({ id, eventId: match.eventId, runId: body.runId, session: body.localSessionId })).digest('hex')
        let receipt = await input.store.findIntent(id, body.requestId)
        if (receipt && (receipt.kind !== 'stop' || receipt.fingerprint !== fingerprint)) throw new DesktopTriggerStopError(409, 'This Stop request belongs to another run')
        if (receipt?.resultJson) return { kind: 'replay' as const, result: JSON.parse(receipt.resultJson) as { canceled: boolean; alreadyFinished: boolean; eventId: string | null } }
        if (!receipt) {
            receipt = { requestId: body.requestId, fingerprint, kind: 'stop', slug: `stop:${match.eventId}`, before: null, after: null, revision: match.revision, resultJson: null }
            const pending = await input.store.findPendingIntent(id, receipt.slug)
            if (pending) {
                if (pending.kind !== 'stop' || pending.fingerprint !== fingerprint) throw new DesktopTriggerStopError(409, 'Another Stop belongs to a different run')
                receipt = pending
            } else {
                try { await input.store.reserveIntent(id, receipt) } catch { throw new DesktopTriggerStopError(409, 'Another Stop is awaiting acknowledgement. Retry that request.') }
            }
        }
        const run = await input.authority.readRun(id, body.runId)
        if (!run || run.id !== body.runId || run.agentId !== id || run.sessionId !== match.engineSessionId || run.triggerSource !== 'trigger' || run.triggerSlug !== match.slug) throw new DesktopTriggerStopError(409, 'Run belongs to another conversation')
        if (match.stopRequestId && match.stopRequestId !== receipt.requestId) throw new DesktopTriggerStopError(409, 'Another Stop owns this delivery')
        if (run.status === 'running') {
            await input.store.updateEvent(id, match.eventId, { stopRequestId: receipt.requestId })
        }
        return { kind: 'stop' as const, run, match, receipt }
        })
        if (prepared.kind === 'replay') return prepared.result
        const { run, match, receipt } = prepared
        // Drain outside the agent lock: a cancelling tool may need that same lock
        // to settle. Its durable Stop marker already blocks new continuation work.
        if (run.status === 'running') await input.authority.cancelExactRun(id, run.id)
        return withAgentLock(id, async () => {
        const owner = await input.authority.resolveOwnerByEngineId(id)
        const current = await input.store.getEvent(id, match.eventId)
        if (owner.engineAgentId !== id || owner.localAgentId !== input.localAgentId || owner.deleting || !current || current.localAgentId !== owner.localAgentId || current.runId !== run.id || current.engineSessionId !== match.engineSessionId || current.localSessionId !== match.localSessionId || current.slug !== match.slug || (current.stopRequestId && current.stopRequestId !== receipt.requestId)) throw new DesktopTriggerStopError(409, 'Trigger ownership changed while stopping')
        const final = await input.authority.readRun(id, run.id)
        if (!final || final.id !== run.id || final.agentId !== id || final.sessionId !== match.engineSessionId || final.triggerSource !== 'trigger' || final.triggerSlug !== match.slug || !['done', 'cancelled', 'error'].includes(final.status)) throw new DesktopTriggerStopError(503, 'Trigger run has not finished stopping. Retry Stop.')
        const status = final.status === 'cancelled' ? 'cancelled' : final.status === 'error' ? 'error' : !current.stopRequestId && current.status === 'needs-input' ? 'needs-input' : 'finished'
        const continued = (await input.store.listHumanAdmissions?.(id, match.eventId, match.engineSessionId!) ?? []).length > 0
        // A Stop for the original already-finished run must not replace its newer
        // human continuation's projection.
        if (!continued) await input.store.updateEvent(id, match.eventId, { status, ...(current.stopRequestId ? { pendingToolCallId: null } : {}) })
        const result = { canceled: status === 'cancelled', alreadyFinished: run.status !== 'running', eventId: match.eventId }
        await input.store.completeIntent(id, receipt.requestId, JSON.stringify(result))
        return result
        })
    })
}
