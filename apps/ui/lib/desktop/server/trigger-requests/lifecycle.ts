import 'server-only'
import { DesktopHttpError } from '../auth'
import { canonicalRequestId, triggerRequestDecisionSchema, type TriggerRequestDecision, type TriggerRequestLink, type TriggerRequestObservation, type TriggerRequestReceipt, type TriggerRequestView } from '../../trigger-requests/types'
import { bindDecision, decisionDigest, triggerRequestKey } from './identity'
import type { TriggerRequestJournal, TriggerRequestRecord } from './journal'

export type TriggerRequestPorts = {
    observe(link: TriggerRequestLink): Promise<TriggerRequestObservation>
    authorize(link: TriggerRequestLink, mode: 'read' | 'decision' | 'stop'): Promise<void>
    withDecisionClaim<T>(link: TriggerRequestLink, work: () => Promise<T>): Promise<T>
    decide(row: TriggerRequestRecord, decision: TriggerRequestDecision): Promise<Response>
    receipt(row: TriggerRequestRecord): Promise<TriggerRequestReceipt>
    stop(row: TriggerRequestRecord): Promise<void>
    stopReceipt?: (row: TriggerRequestRecord) => Promise<'stopped' | 'unknown'>
}
function exact(observation: TriggerRequestObservation, link: TriggerRequestLink) {
    if (triggerRequestKey(observation.link) !== triggerRequestKey(link)) throw new DesktopHttpError(409, 'This webhook request was replaced. Refresh the result chat.')
}
function view(observation: TriggerRequestObservation, row: TriggerRequestRecord): TriggerRequestView {
    return { key: triggerRequestKey(row.link), link: row.link, phase: row.phase, continuationId: row.continuationId,
        acceptedRunId: row.acceptedRunId ?? null, runStatus: observation.runStatus, availability: observation.availability,
        request: row.phase === 'accepted' || row.phase === 'stopped' || row.phase === 'superseded' ? null : observation.request }
}
function acknowledged(row: TriggerRequestRecord) {
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1',
        [row.link.kind === 'question' ? 'x-question-id' : row.link.kind === 'approval' ? 'x-approval-id' : row.link.kind === 'takeover' ? 'x-takeover-id' : row.link.kind === 'service' ? 'x-service-request-id' : 'x-secret-request-id']: row.link.requestId,
        'x-session-id': row.link.sessionId, 'x-run-id': row.acceptedRunId ?? row.continuationId, 'x-trigger-request-key': triggerRequestKey(row.link), 'cache-control': 'no-store' } })
}
function requireReady(observation: TriggerRequestObservation) {
    if (observation.availability !== 'ready' || !observation.request || observation.runStatus !== 'done') throw new DesktopHttpError(409, 'The webhook request is not currently answerable. Refresh its result chat.')
}
export function createTriggerRequestLifecycle(journal: TriggerRequestJournal, ports: TriggerRequestPorts) {
    async function required(key: string) { const row = await journal.get(key); if (!row) throw new DesktopHttpError(404, 'Webhook request not found'); return row }
    async function reconcileRow(row: TriggerRequestRecord): Promise<TriggerRequestRecord> {
        await ports.authorize(row.link, 'read')
        if (row.phase === 'stop-uncertain') {
            if (await ports.stopReceipt?.(row) === 'stopped') return journal.transition(triggerRequestKey(row.link), 'stopped')
            return row
        }
        if (row.phase !== 'uncertain' && row.phase !== 'pending') return row
        const receipt = await ports.receipt(row)
        if (receipt.status === 'accepted') {
            if (row.phase === 'pending') await journal.reserve(triggerRequestKey(row.link), 'canonical:' + receipt.continuationId)
            return journal.transition(triggerRequestKey(row.link), 'accepted', receipt.continuationId)
        }
        if (receipt.status === 'absent' && row.phase === 'uncertain' && row.decisionDigest) return journal.releaseUnadmitted(triggerRequestKey(row.link), row.decisionDigest)
        return row
    }
    return {
        async read(link: TriggerRequestLink): Promise<TriggerRequestView | null> {
            await ports.authorize(link, 'read')
            const row = await journal.get(triggerRequestKey(link))
            if (!row) return null
            const observation = await ports.observe(link)
            if (!['accepted', 'stopped', 'superseded'].includes(row.phase)) exact(observation, link)
            return view(observation, row)
        },
        async capture(link: TriggerRequestLink): Promise<TriggerRequestRecord> {
            await ports.authorize(link, 'read')
            const observation = await ports.observe(link)
            exact(observation, link)
            if (!observation.request) throw new DesktopHttpError(409, 'No actual pending webhook request to link')
            return journal.publish(link, observation.canonicalAttemptId)
        },
        async reconcile(key: string): Promise<TriggerRequestRecord> {
            const row = await required(key)
            return ports.withDecisionClaim(row.link, async () => reconcileRow(await required(key)))
        },
        async decide(key: string, raw: TriggerRequestDecision): Promise<Response> {
            const initial = await required(key)
            const decision = triggerRequestDecisionSchema.parse(raw)
            if (decision.kind !== initial.link.kind || canonicalRequestId(decision) !== initial.link.requestId) throw new DesktopHttpError(409, 'Decision belongs to a different webhook request')
            return ports.withDecisionClaim(initial.link, async () => {
                const row = await reconcileRow(await required(key))
                const bound = bindDecision(decision, row.continuationId), digest = decisionDigest(bound)
                if (row.phase === 'accepted' && row.decisionDigest?.startsWith('canonical:')) {
                    const response = await ports.decide(row, bound)
                    if (!response.ok || response.headers.get('x-session-id') !== row.link.sessionId || response.headers.get('x-run-id') !== row.acceptedRunId) {
                        void response.body?.cancel().catch(() => {})
                        throw new DesktopHttpError(409, 'That decision does not match the canonical saved result')
                    }
                    response.headers.set('x-trigger-request-key', key)
                    response.headers.set('cache-control', 'no-store')
                    return response
                }
                if (row.decisionDigest && row.decisionDigest !== digest) throw new DesktopHttpError(409, 'Retry the saved decision, not a different answer')
                if (row.phase === 'accepted') return acknowledged(row)
                if (['stop-uncertain', 'stopped', 'superseded'].includes(row.phase)) throw new DesktopHttpError(409, 'This webhook request was stopped or replaced')
                if (row.phase === 'uncertain') {
                    const receipt = await ports.receipt(row)
                    if (receipt.status === 'unknown') throw new DesktopHttpError(409, 'Admission is still unknown. Check the saved outcome before retrying.')
                }
                await ports.authorize(row.link, 'decision')
                const observation = await ports.observe(row.link)
                exact(observation, row.link)
                requireReady(observation)
                const reserved = await journal.reserve(key, digest)
                const response = await ports.decide(reserved.row, bound)
                const receipt = await ports.receipt(reserved.row)
                if (!response.ok || receipt.status !== 'accepted' || response.headers.get('x-session-id') !== row.link.sessionId || response.headers.get('x-run-id') !== receipt.continuationId) {
                    void response.body?.cancel().catch(() => {})
                    throw new DesktopHttpError(502, 'The follow-up acknowledgement is unknown. Reconcile this same decision.')
                }
                await journal.transition(key, 'accepted', receipt.continuationId)
                response.headers.set('x-trigger-request-key', key)
                response.headers.set('cache-control', 'no-store')
                return response
            })
        },
        async recoverCanonical(key: string, attemptId: string, work: () => Promise<Response>): Promise<Response> {
            const initial = await required(key)
            return ports.withDecisionClaim(initial.link, async () => {
                const row = await reconcileRow(await required(key))
                if (row.link.kind !== 'secret' || row.continuationId !== attemptId) throw new DesktopHttpError(409, 'Credential retry belongs to another saved attempt')
                if (row.phase === 'stopped' || row.phase === 'stop-uncertain' || row.phase === 'superseded') throw new DesktopHttpError(409, 'This webhook request was stopped or replaced')
                if (row.phase !== 'accepted') {
                    await ports.authorize(row.link, 'decision')
                    const observation = await ports.observe(row.link)
                    exact(observation, row.link); requireReady(observation)
                    if (row.phase === 'pending') await journal.reserve(key, 'canonical:' + attemptId)
                }
                const response = await work(), receipt = await ports.receipt(row)
                if (!response.ok || receipt.status !== 'accepted' || response.headers.get('x-session-id') !== row.link.sessionId || response.headers.get('x-run-id') !== receipt.continuationId) {
                    void response.body?.cancel().catch(() => {})
                    throw new DesktopHttpError(502, 'The saved credential continuation acknowledgement is unknown')
                }
                await journal.transition(key, 'accepted', receipt.continuationId)
                response.headers.set('x-trigger-request-key', key)
                return response
            })
        },
        async stop(key: string): Promise<void> {
            const row = await required(key)
            return ports.withDecisionClaim(row.link, async () => {
                const current = await reconcileRow(await required(key))
                if (current.phase === 'stopped') return
                if (current.phase !== 'pending' && current.phase !== 'stop-uncertain') throw new DesktopHttpError(409, 'Resolve the saved decision or Stop acknowledgement before taking a conflicting action')
                await ports.authorize(current.link, 'stop')
                if (current.phase === 'pending') await journal.transition(key, 'stop-uncertain')
                await ports.stop(current)
                await journal.transition(key, 'stopped')
            })
        },
    }
}
export type TriggerRequestLifecycle = ReturnType<typeof createTriggerRequestLifecycle>
