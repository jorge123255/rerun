import 'server-only'
import type { Client } from '@libsql/client'
import { hitlKindOf, desktopTriggerDeliveryReceiptSchema } from '@rerun/contracts'
import { getRun, getRunTools } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'
import { findDesktopAgent, findDesktopSession } from '../store'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { readDesktopRuntime, type DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { authorizeDesktopTriggers, authorizeDesktopTriggersBasic } from '../triggers/binding'
import { triggerRead } from '../triggers/adoption'
import type { TriggerRequestForm, TriggerRequestLink, TriggerRequestObservation, TriggerRequestTarget } from '../../trigger-requests/types'
import { invokeCanonicalTriggerDecision, readCanonicalTriggerForm, readCanonicalTriggerReceipt, type TriggerRequestRootBindings, MissingTriggerRequestAuthority } from './canonical'
import { createTriggerRequestLifecycle } from './lifecycle'
import { createTriggerRequestJournal, type TriggerRequestJournal } from './journal'
import { triggerRequestKey } from './identity'
import { probeCanonicalTriggerAdmission } from './recovery'

function sourceOf(form: TriggerRequestForm) {
    switch (form.kind) {
        case 'question': return { requestId: form.value.id, sourceMessageId: form.value.messageId, toolCallId: form.value.toolCallId, fingerprint: form.value.id, canonicalAttemptId: form.value.attempt?.requestId }
        case 'approval': return { requestId: form.value.id, sourceMessageId: form.value.messageId, toolCallId: form.value.toolCallId, fingerprint: form.value.id, canonicalAttemptId: form.value.attempt?.requestId }
        case 'takeover': return { requestId: form.value.id, sourceMessageId: form.value.messageId, toolCallId: form.value.toolCallId, fingerprint: form.value.id, canonicalAttemptId: form.value.attempt?.requestId }
        case 'service': return { requestId: form.value.serviceRequestId, ...form.value.source, canonicalAttemptId: form.value.receipt?.requestId ?? form.value.retry.requestId }
        case 'secret': return { requestId: form.value.requestId, sourceMessageId: form.value.source.sourceMessageId, toolCallId: form.value.source.toolCallId, fingerprint: form.value.source.fingerprint, canonicalAttemptId: form.value.pendingAttempt?.attemptId ?? form.value.receipt?.attemptId }
        case 'signin': return { requestId: form.value.requestId, sourceMessageId: form.value.sourceMessageId, toolCallId: form.value.toolCallId, fingerprint: form.value.fingerprint }
    }
}
export function createDesktopTriggerRequests(runtime: DesktopRuntime, db: Client, root: TriggerRequestRootBindings, journal: TriggerRequestJournal = createTriggerRequestJournal(db)) {
    for (const name of ['readDelivery', 'resolveSessionSource', 'withDecisionClaim', 'assertCurrentRequestPermission', 'stop', 'stopReceipt'] as const) {
        if (typeof root[name] !== 'function') throw new MissingTriggerRequestAuthority(name)
    }
    if (!root.workspaceIdentity) throw new MissingTriggerRequestAuthority('durable workspaceIdentity')
    const signal = () => AbortSignal.timeout(15_000)
    async function scope(target: TriggerRequestTarget, currentSignal: AbortSignal) {
        currentSignal.throwIfAborted()
        const currentRuntime = await readDesktopRuntime()
        if (currentRuntime.launchNonce !== runtime.launchNonce || currentRuntime.dataRoot !== runtime.dataRoot || currentRuntime.engine.origin !== runtime.engine.origin || currentRuntime.app.origin !== runtime.app.origin) throw new DesktopHttpError(409, 'Rerun restarted. Reload this webhook result.')
        if (target.workspaceId !== root.workspaceIdentity) throw new DesktopHttpError(409, 'Webhook workspace changed')
        const agent = await findDesktopAgent(db, target.agentId), session = await findDesktopSession(db, target.sessionId)
        if (!agent || agent.workspaceId !== 1 || !session || session.agentId !== agent.id || agent.engineAgentId !== target.engineAgentId || session.engineSessionId !== target.engineSessionId) throw new DesktopHttpError(409, 'Webhook conversation ownership changed')
        await assertCoworkerNotDeleting(db, agent.id)
        const raw = await root.readDelivery(agent.engineAgentId, target.eventId, currentSignal)
        if (!raw) throw new DesktopHttpError(404, 'Webhook delivery not found')
        const event = desktopTriggerDeliveryReceiptSchema.parse(raw)
        if (event.eventId !== target.eventId || event.localAgentId !== agent.id || event.engineAgentId !== agent.engineAgentId || event.localSessionId !== session.id || event.engineSessionId !== session.engineSessionId || event.runId !== target.triggerRunId || event.slug !== target.slug) throw new DesktopHttpError(409, 'Webhook delivery identity changed')
        const run = await getRun(engineOf(runtime), agent.engineAgentId, target.triggerRunId, { signal: currentSignal })
        if (run.id !== target.triggerRunId || run.agentId !== agent.engineAgentId || run.sessionId !== session.engineSessionId || run.triggerSource !== 'trigger' || run.triggerSlug !== event.slug) throw new DesktopHttpError(409, 'Not an owned webhook source run')
        currentSignal.throwIfAborted()
        return { agent, session, event, run }
    }
    async function discover(target: TriggerRequestTarget): Promise<TriggerRequestObservation | null> {
        const currentSignal = signal(), bound = await scope(target, currentSignal)
        const form = await readCanonicalTriggerForm(runtime, root, target.sessionId, currentSignal)
        if (!form) return null
        const source = sourceOf(form), records = await journal.list(target)
        const runs = [...new Set([target.triggerRunId, ...(await root.readContinuationRuns?.(target,currentSignal) ?? []), ...records.filter(row => row.phase === 'accepted' && row.acceptedRunId).map(row => row.acceptedRunId!)])]
        if (runs.length > 65) throw new DesktopHttpError(409, 'Webhook continuation chain exceeds reconciliation bounds')
        const matches: { id: string; status: 'running' | 'done' | 'error' | 'cancelled' }[] = []
        for (const id of runs) {
            currentSignal.throwIfAborted()
            const run = id === target.triggerRunId ? bound.run : await getRun(engineOf(runtime), target.engineAgentId, id, { signal: currentSignal })
            if (run.id !== id || run.agentId !== target.engineAgentId || run.sessionId !== target.engineSessionId) throw new DesktopHttpError(409, 'Webhook continuation belongs to another conversation')
            const calls = await triggerRead(getRunTools(engineOf(runtime), target.engineAgentId, id), currentSignal)
            const exact = calls.filter(call => call.agentId === target.engineAgentId && call.sessionId === target.engineSessionId && call.runId === id && call.toolCallId === source.toolCallId && !call.isError && hitlKindOf(call.toolName) === (form.kind === 'signin' ? 'mcp' : form.kind))
            if (exact.length > 1) throw new DesktopHttpError(409, 'Ambiguous webhook tool source')
            if (exact.length === 1) matches.push({ id, status: run.status })
        }
        if (matches.length !== 1) throw new DesktopHttpError(409, 'Pending request is not from this exact webhook or an acknowledged human continuation')
        if (form.kind === 'secret' && (form.value.source.agentId !== target.agentId || form.value.source.sessionId !== target.sessionId || form.value.source.runId !== matches[0].id)) throw new DesktopHttpError(409, 'Credential request belongs to a different webhook source')
        const { canonicalAttemptId, ...identity } = source as typeof source & { canonicalAttemptId?: string }
        const link: TriggerRequestLink = { ...target, ...identity, kind: form.kind, sourceRunId: matches[0].id }
        const current = await scope(target, currentSignal)
        let availability: TriggerRequestObservation['availability'] = !current.agent.enabled ? 'disabled' : current.event.stopRequestId || current.event.status === 'cancelled' || matches[0].status === 'cancelled' ? 'stopped' : form.kind === 'signin' ? 'unavailable' : 'ready'
        if (availability === 'ready') {
            try {
                await authorizeDesktopTriggers(runtime, db, target.engineAgentId, currentSignal)
                await root.assertCurrentRequestPermission(link, currentSignal)
            } catch (error) {
                availability = error instanceof DesktopHttpError && error.status === 403 ? 'revoked'
                    : error instanceof DesktopHttpError && error.status === 404 ? 'deleted-trigger'
                    : error instanceof DesktopHttpError && error.status === 409 ? 'superseded' : 'unavailable'
            }
        }
        return { link, runStatus: matches[0].status, availability, request: form, ...(canonicalAttemptId ? { canonicalAttemptId } : {}) }
    }
    const lifecycle = createTriggerRequestLifecycle(journal, {
        async authorize(link, mode) {
            const currentSignal = signal()
            await scope(link, currentSignal)
            await authorizeDesktopTriggersBasic(runtime, db, link.engineAgentId, currentSignal)
            if (mode === 'decision') {
                await authorizeDesktopTriggers(runtime, db, link.engineAgentId, currentSignal)
                await root.assertCurrentRequestPermission(link, currentSignal)
            }
        },
        withDecisionClaim: (link, work) => root.withDecisionClaim(link, work),
        async observe(link) {
            const currentSignal = signal(), bound = await scope(link, currentSignal)
            const observed = await discover(link)
            if (observed) return observed
            const sourceRun = await getRun(engineOf(runtime), link.engineAgentId, link.sourceRunId, { signal: currentSignal })
            if (sourceRun.agentId !== link.engineAgentId || sourceRun.sessionId !== link.engineSessionId || sourceRun.id !== link.sourceRunId) throw new DesktopHttpError(409, 'Webhook source run changed')
            return { link, request: null, runStatus: sourceRun.status,
                availability: bound.event.stopRequestId || sourceRun.status === 'cancelled' ? 'stopped' : link.kind === 'secret' && !root.secret || link.kind === 'signin' ? 'unavailable' : 'superseded' }
        },
        decide: (row, decision) => invokeCanonicalTriggerDecision(runtime, root, row, decision, signal()),
        async receipt(row) {
            const known = await readCanonicalTriggerReceipt(db, row)
            if (known.status !== 'reserved') return known
            return probeCanonicalTriggerAdmission(runtime, db, root, row)
        },
        stop: row => root.stop(row, signal()), stopReceipt: row => root.stopReceipt(row, signal()),
    })
    async function reconcileEvent(target: TriggerRequestTarget) {
        await scope(target, signal())
        const rows = await journal.list(target), result = []
        for (const row of rows) result.push(await lifecycle.reconcile(triggerRequestKey(row.link)))
        return result
    }
    return {
        lifecycle, journal, discover, reconcileEvent,
        async currentForSession(sessionId: string) {
            const source = await root.resolveSessionSource(sessionId, signal())
            if (source.kind === 'ordinary') return null
            if (source.kind === 'unavailable') throw new DesktopHttpError(503, 'Webhook source identity is unavailable')
            const records = await reconcileEvent(source.target)
            const observation = await discover(source.target)
            if (observation) {
                const saved = await lifecycle.capture(observation.link)
                return lifecycle.read(saved.link)
            }
            const latest = records.at(-1)
            return latest ? lifecycle.read(latest.link) : null
        },
        async captureForSession(sessionId: string) {
            const source = await root.resolveSessionSource(sessionId, signal())
            if (source.kind === 'unavailable') throw new DesktopHttpError(503, 'Webhook source identity is unavailable; no human decision was sent')
            if (source.kind === 'ordinary') return false
            if (source.target.sessionId !== sessionId) throw new DesktopHttpError(409, 'Webhook source belongs to another conversation')
            await reconcileEvent(source.target)
            const observation = await discover(source.target)
            if (observation) await lifecycle.capture(observation.link)
            return true
        },
        async capturePending(target: TriggerRequestTarget) {
            await reconcileEvent(target)
            const observation = await discover(target)
            if (!observation) return null
            return lifecycle.capture(observation.link)
        },
    }
}
export type DesktopTriggerRequests = ReturnType<typeof createDesktopTriggerRequests>
