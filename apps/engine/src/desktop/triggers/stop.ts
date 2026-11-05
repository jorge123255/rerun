import { createHash } from 'node:crypto'
import { desktopTriggerStopSchema } from '@rerun/contracts'
import { withKeyedLock } from '../../lib/lock.js'
import type { DesktopTriggerAuthority, DesktopTriggerStore } from './types.js'
export class DesktopTriggerStopError extends Error { constructor(readonly status: number, message: string) { super(message); this.name = 'DesktopTriggerStopError' } }
export async function stopDesktopTriggerRun(input: { authority: DesktopTriggerAuthority; store: DesktopTriggerStore; engineAgentId: string; localAgentId: string; body: unknown }): Promise<{ canceled: boolean; alreadyFinished: boolean; eventId: string | null }> {
    const body = desktopTriggerStopSchema.parse(input.body), id = input.engineAgentId
    return withKeyedLock(`desktop-trigger-stop:${id}`, async () => {
        input.authority.assertActive()
        const owner = await input.authority.resolveOwnerByEngineId(id)
        if (owner.localAgentId !== input.localAgentId || owner.engineAgentId !== id || owner.deleting) throw new DesktopTriggerStopError(409, 'Coworker identity changed')
        const match = body.expectedEventId ? await input.store.getEvent(id, body.expectedEventId) : (await input.store.listEvents(id, undefined, 300)).find(row => row.runId === body.runId && row.localSessionId === body.localSessionId)
        if (!match || match.localAgentId !== owner.localAgentId || match.runId !== body.runId || match.localSessionId !== body.localSessionId || !match.engineSessionId) throw new DesktopTriggerStopError(404, 'Trigger run not found for this conversation')
        const fingerprint = createHash('sha256').update(JSON.stringify({ id, eventId: match.eventId, runId: body.runId, session: body.localSessionId })).digest('hex')
        let receipt = await input.store.findIntent(id, body.requestId)
        if (receipt && (receipt.kind !== 'stop' || receipt.fingerprint !== fingerprint)) throw new DesktopTriggerStopError(409, 'This Stop request belongs to another run')
        if (receipt?.resultJson) return JSON.parse(receipt.resultJson)
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
        if (!run || run.agentId !== id || run.sessionId !== match.engineSessionId || run.triggerSource !== 'trigger' || run.triggerSlug !== match.slug) throw new DesktopTriggerStopError(409, 'Run belongs to another conversation')
        if (run.status === 'running') {
            await input.store.updateEvent(id, match.eventId, { stopRequestId: receipt.requestId })
            await input.authority.cancelExactRun(id, run.id)
        }
        const final = await input.authority.readRun(id, run.id)
        if (!final || final.status === 'running') throw new DesktopTriggerStopError(503, 'Trigger run has not finished stopping. Retry Stop.')
        const status = final.status === 'cancelled' ? 'cancelled' : final.status === 'error' ? 'error' : match.status === 'needs-input' ? 'needs-input' : 'finished'
        await input.store.updateEvent(id, match.eventId, { status })
        const result = { canceled: status === 'cancelled', alreadyFinished: run.status !== 'running', eventId: match.eventId }
        await input.store.completeIntent(id, receipt.requestId, JSON.stringify(result))
        return result
    })
}
