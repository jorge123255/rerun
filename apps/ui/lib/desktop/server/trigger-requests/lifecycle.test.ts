import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTriggerRequestLifecycle } from './lifecycle'
import { triggerRequestKey, continuationId } from './identity'
import type { TriggerRequestLink, TriggerRequestObservation, TriggerRequestDecision, TriggerRequestReceipt } from '../../trigger-requests/types'
import type { TriggerRequestJournal, TriggerRequestRecord } from './journal'

const link: TriggerRequestLink = {
    workspaceId: 'local-workspace-1', agentId: 'local-agent', engineAgentId: 'engine-agent',
    eventId: 'delivery-1', slug: 'arithmetic', sessionId: 'local-chat', engineSessionId: 'engine-chat',
    triggerRunId: 'trigger-run', sourceRunId: 'trigger-run', kind: 'question',
    requestId: 'a'.repeat(64), sourceMessageId: 'message-1', toolCallId: 'call-1', fingerprint: 'sealed-content',
}
const pending = (): TriggerRequestObservation => ({ link, runStatus: 'done', availability: 'ready',
    request: { kind: 'question', value: { id: link.requestId, messageId: link.sourceMessageId, toolCallId: link.toolCallId,
        questions: [{ question: 'What is 6 × 7?', options: ['42'] }] } } })
function fixture() {
    const rows = new Map<string, { link: TriggerRequestLink; continuationId: string; decisionDigest: string | null; phase: 'pending' | 'uncertain' | 'accepted' | 'stopped' | 'superseded' | 'stop-uncertain'; version: number }>()
    const journal: TriggerRequestJournal = {
        async publish(source) { const id = triggerRequestKey(source); const old = rows.get(id); if (!old) rows.set(id, { link: source, continuationId: continuationId(source), decisionDigest: null, phase: 'pending', version: 0 }); return rows.get(id)! },
        async get(id) { return rows.get(id) ?? null },
        async list() { return [...rows.values()] },
        async releaseUnadmitted(id, digest) { const row = rows.get(id)!; if (row.decisionDigest !== digest || row.phase !== 'uncertain') throw new Error('Changed'); row.phase = 'pending'; row.decisionDigest = null; return row },
        async reserve(id, digest) { const row = rows.get(id)!; if (row.decisionDigest && row.decisionDigest !== digest) throw new Error('Decision already reserved'); if (row.phase === 'stopped' || row.phase === 'superseded') throw new Error('Request no longer current'); const fresh = !row.decisionDigest; row.decisionDigest = digest; row.phase = row.phase === 'accepted' ? 'accepted' : 'uncertain'; return { row, fresh } },
        async transition(id, phase, acceptedRunId) { const row = rows.get(id)!; if (row.phase !== 'accepted') row.phase = phase; if (acceptedRunId) Object.assign(row, { acceptedRunId }); return row },
    }
    let observation = pending()
    let admitted = false
    const decide = vi.fn(async (_row: TriggerRequestRecord, _decision: TriggerRequestDecision) => { admitted = true; return new Response('data: [DONE]\n\n', { headers: { 'x-session-id': link.sessionId, 'x-run-id': continuationId(link), 'x-question-id': link.requestId } }) })
    let claim = Promise.resolve()
    const ports = { observe: vi.fn(async () => observation), authorize: vi.fn(async () => {}),
        withDecisionClaim: <T,>(_link: TriggerRequestLink, work: () => Promise<T>) => { const result = claim.then(work); claim = result.then(() => {}, () => {}); return result },
        decide, receipt: vi.fn(async (_row: TriggerRequestRecord): Promise<TriggerRequestReceipt> => admitted ? { status: 'accepted' as const, continuationId: continuationId(link) } : { status: 'absent' as const }),
        stop: vi.fn(async () => {}),
    }
    return { journal, ports, lifecycle: createTriggerRequestLifecycle(journal, ports), setObservation: (next: TriggerRequestObservation) => { observation = next } }
}
const decision = { kind: 'question' as const, input: { action: 'answer' as const, questionId: link.requestId, requestId: '00000000-0000-4000-8000-000000000001', answers: [['42']] } }

describe('webhook human request linkage', () => {
    it('simultaneous clicks are serialized under the root decision claim', async () => {
        const f = fixture(); await f.lifecycle.capture(link)
        await Promise.all([f.lifecycle.decide(triggerRequestKey(link), decision), f.lifecycle.decide(triggerRequestKey(link), decision)])
        expect(f.ports.decide).toHaveBeenCalledTimes(1)
    })
    it('proven canonical non-admission releases only the unaccepted local reservation', async () => {
        const f = fixture(); await f.lifecycle.capture(link)
        f.ports.decide.mockRejectedValueOnce(new Error('failed before canonical reservation'))
        await expect(f.lifecycle.decide(triggerRequestKey(link), decision)).rejects.toThrow()
        await f.lifecycle.reconcile(triggerRequestKey(link))
        expect((await f.journal.get(triggerRequestKey(link)))?.phase).toBe('pending')
        expect(f.ports.decide).toHaveBeenCalledTimes(1)
    })
    it('question cancellation is a canonical decision, never a second webhook dispatch', async () => {
        const f = fixture(); await f.lifecycle.capture(link)
        await f.lifecycle.decide(triggerRequestKey(link), { kind: 'question', input: { action: 'cancel', questionId: link.requestId, requestId: crypto.randomUUID() } })
        expect(f.ports.decide.mock.calls[0][1]).toMatchObject({ kind: 'question', input: { action: 'cancel', requestId: continuationId(link) } })
    })
    it('an approval decline preserves the exact source and note in the canonical handler', async () => {
        const f = fixture(), approvalLink = { ...link, kind: 'approval' as const }
        f.setObservation({ link: approvalLink, runStatus: 'done', availability: 'ready', request: { kind: 'approval', value: { id: link.requestId, messageId: link.sourceMessageId, toolCallId: link.toolCallId, approvals: [{ action: 'Arithmetic only' }] } } })
        await f.lifecycle.capture(approvalLink)
        const id = continuationId(approvalLink)
        f.ports.decide.mockResolvedValue(new Response('data: [DONE]\n\n', { headers: { 'x-session-id': link.sessionId, 'x-run-id': id } }))
        f.ports.receipt.mockImplementation(async row => row.decisionDigest ? { status: 'accepted', continuationId: id } : { status: 'absent' })
        await f.lifecycle.decide(triggerRequestKey(approvalLink), { kind: 'approval', input: { approvalId: link.requestId, requestId: crypto.randomUUID(), decisions: [{ decision: 'declined', note: 'Not now' }] } })
        expect(f.ports.decide.mock.calls[0][1]).toMatchObject({ kind: 'approval', input: { decisions: [{ decision: 'declined', note: 'Not now' }] } })
    })
    it('a lost Stop acknowledgement remains blocked after restart and never replays Stop', async () => {
        const f = fixture(); await f.lifecycle.capture(link); f.ports.stop.mockRejectedValue(new Error('lost Stop acknowledgement'))
        await expect(f.lifecycle.stop(triggerRequestKey(link))).rejects.toThrow()
        const restarted = createTriggerRequestLifecycle(f.journal, f.ports)
        await restarted.reconcile(triggerRequestKey(link))
        await expect(restarted.decide(triggerRequestKey(link), decision)).rejects.toThrow()
        expect(f.ports.stop).toHaveBeenCalledTimes(1); expect(f.ports.decide).not.toHaveBeenCalled()
    })

    it('keys every source identity, not origin, title, or coworker name', () => {
        for (const key of Object.keys(link).filter(key => key !== 'kind') as (keyof TriggerRequestLink)[]) expect(triggerRequestKey({ ...link, [key]: `${link[key]}-other` })).not.toBe(triggerRequestKey(link))
        expect(triggerRequestKey({ ...link, kind: 'approval' })).not.toBe(triggerRequestKey(link))
        expect(continuationId(link)).toMatch(/^[a-f0-9-]{36}$/)
    })
    it('reads do not publish, reserve, or admit', async () => {
        const f = fixture(); await f.lifecycle.read(link)
        expect(await f.journal.list(link)).toHaveLength(0); expect(f.ports.decide).not.toHaveBeenCalled()
    })
    it('duplicate decisions retain a single canonical continuation identity', async () => {
        const f = fixture(); await f.lifecycle.capture(link); await f.lifecycle.decide(triggerRequestKey(link), decision)
        await f.lifecycle.decide(triggerRequestKey(link), decision)
        expect(f.ports.decide).toHaveBeenCalledTimes(1)
        expect((await f.journal.get(triggerRequestKey(link)))?.phase).toBe('accepted')
    })
    it('lost acknowledgement is receipt-reconciled after a new lifecycle instance without resending', async () => {
        const f = fixture(); await f.lifecycle.capture(link)
        f.ports.decide.mockImplementationOnce(async () => { throw new Error('connection lost') })
        await expect(f.lifecycle.decide(triggerRequestKey(link), decision)).rejects.toThrow()
        expect((await f.journal.get(triggerRequestKey(link)))?.phase).toBe('uncertain')
        f.ports.receipt.mockResolvedValue({ status: 'accepted', continuationId: continuationId(link) })
        const restarted = createTriggerRequestLifecycle(f.journal, f.ports)
        await restarted.reconcile(triggerRequestKey(link)); expect(f.ports.decide).toHaveBeenCalledTimes(1)
    })
    it('an unknown receipt blocks a changed answer and never implies completion', async () => {
        const f = fixture(); await f.lifecycle.capture(link)
        f.ports.decide.mockRejectedValue(new Error('unknown')); await expect(f.lifecycle.decide(triggerRequestKey(link), decision)).rejects.toThrow()
        f.ports.receipt.mockResolvedValue({ status: 'unknown' } as never)
        await expect(f.lifecycle.decide(triggerRequestKey(link), { ...decision, input: { ...decision.input, answers: [['43']] } })).rejects.toThrow()
        expect(f.ports.decide).toHaveBeenCalledTimes(1)
    })
    it.each(['disabled', 'deleted-trigger', 'revoked-grant', 'stopped-source'])('refuses %s before canonical effects', async () => {
        const f = fixture(); await f.lifecycle.capture(link); f.ports.authorize.mockRejectedValue(new Error('blocked'))
        await expect(f.lifecycle.decide(triggerRequestKey(link), decision)).rejects.toThrow('blocked'); expect(f.ports.decide).not.toHaveBeenCalled()
    })
    it('rejects stale source callbacks and does not turn missing requests into Done', async () => {
        const f = fixture(); await f.lifecycle.capture(link)
        f.setObservation({ ...pending(), link: { ...link, sourceRunId: 'new-run' } })
        await expect(f.lifecycle.decide(triggerRequestKey(link), decision)).rejects.toThrow()
        expect(f.ports.decide).not.toHaveBeenCalled()
    })
    it('Stop is serialized with decisions and prevents later stale callbacks', async () => {
        const f = fixture(); await f.lifecycle.capture(link); await f.lifecycle.stop(triggerRequestKey(link))
        await expect(f.lifecycle.decide(triggerRequestKey(link), decision)).rejects.toThrow()
        expect(f.ports.stop).toHaveBeenCalledTimes(1); expect(f.ports.decide).not.toHaveBeenCalled()
    })
    it('does not accept a foreign-session acknowledgement', async () => {
        const f = fixture(); await f.lifecycle.capture(link)
        f.ports.decide.mockResolvedValue(new Response(null, { headers: { 'x-session-id': 'private-chat', 'x-run-id': continuationId(link) } }))
        await expect(f.lifecycle.decide(triggerRequestKey(link), decision)).rejects.toThrow()
        expect((await f.journal.get(triggerRequestKey(link)))?.phase).toBe('uncertain')
    })
})
