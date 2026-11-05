import { createHash, randomUUID } from 'node:crypto'
import { DESKTOP_TRIGGER_SLUG_RE, desktopTriggerFireInputSchema, type DesktopTriggerFireInput } from '@rerun/contracts'
import { buildDesktopTriggerMessage } from './message.js'
import { hashPayloadFingerprint } from './state.js'
import { desktopTriggerDefinitionRevision } from './lifecycle.js'
import { tokenMatches } from './token.js'
import type { DesktopTriggerAuthority, DesktopTriggerStore } from './types.js'

export type DesktopTriggerDispatchResult =
    | { status: 202; eventId: string; runId: string; sessionId: string; localSessionId: string | null; replay: boolean }
    | { status: 204 } | { status: 404 } | { status: 405; allow: string[] }
    | { status: 409; error: string } | { status: 413 } | { status: 503; error: string }

export async function dispatchDesktopTriggerFire(input: { authority: DesktopTriggerAuthority; store: DesktopTriggerStore; engineAgentId: string; slug: string; fire: DesktopTriggerFireInput }): Promise<DesktopTriggerDispatchResult> {
    const { authority, store, engineAgentId: id, slug } = input
    const parsed = desktopTriggerFireInputSchema.safeParse(input.fire)
    if (!parsed.success || Buffer.byteLength(parsed.data.body, 'utf8') > 1048576) return { status: 413 }
    const fire = { ...parsed.data, bodyBytes: Buffer.byteLength(parsed.data.body, 'utf8') }
    try { authority.assertActive() } catch { return { status: 503, error: 'Triggers are stopping' } }
    if (!DESKTOP_TRIGGER_SLUG_RE.test(slug) || await store.isRevoked(id)) return { status: 404 }
    const trigger = await authority.readTrigger(id, slug)
    if (!trigger || !trigger.enabled || !trigger.token || !tokenMatches(fire.token, trigger.token)) return { status: 404 }
    if (!trigger.methods.includes(fire.method)) return { status: 405, allow: trigger.methods }
    const owner = await authority.resolveOwnerByEngineId(id).catch(() => null)
    if (!owner || owner.engineAgentId !== id || owner.deleting || !owner.enabled) return { status: 404 }
    const revision = desktopTriggerDefinitionRevision(trigger)
    const admission = async () => {
        authority.assertActive()
        if (await store.isRevoked(id)) throw new Error('Coworker triggers revoked')
        const currentOwner = await authority.resolveOwnerByEngineId(id)
        if (currentOwner.localAgentId !== owner.localAgentId || currentOwner.engineAgentId !== id || currentOwner.deleting || !currentOwner.enabled) throw new Error('Coworker identity changed')
        await authority.assertTriggerGrant(id)
        await authority.assertSetupClear(id)
        if (desktopTriggerDefinitionRevision(await authority.readTrigger(id, slug)) !== revision) throw new Error('Trigger changed before launch')
        authority.assertActive()
    }
    try { await admission() } catch { return { status: 409, error: 'Trigger is not ready. Check its permissions and coworker setup.' } }
    const fingerprint = hashPayloadFingerprint({ method: fire.method, query: fire.query, contentType: fire.contentType, body: fire.body, explicit: fire.attemptFingerprint })
    const requestFingerprint = createHash('sha256').update(JSON.stringify({ revision, method: fire.method, query: fire.query, contentType: fire.contentType, body: fire.body })).digest('hex')
    const replay = async () => {
        if (!fingerprint) return null
        const prior = await store.findEventByFingerprint(id, slug, fingerprint)
        if (!prior) return null
        if (prior.requestFingerprint !== requestFingerprint) return { status: 409 as const, error: 'This delivery attempt belongs to a different request.' }
        return { status: 202 as const, eventId: prior.eventId, runId: prior.runId ?? '', sessionId: prior.engineSessionId ?? '', localSessionId: prior.localSessionId, replay: true }
    }
    const prior = await replay(); if (prior) return prior
    const receivedAt = new Date().toISOString(), eventId = randomUUID()
    const { message, truncated } = buildDesktopTriggerMessage(trigger, fire, receivedAt)
    const recorded = await store.recordEvent({ eventId, attemptFingerprint: fingerprint, requestFingerprint, localAgentId: owner.localAgentId, engineAgentId: id, slug, triggerName: trigger.name, method: fire.method, receivedAt, status: 'accepted', localSessionId: null, engineSessionId: null, runId: null, revision, error: null, payloadBytes: fire.bodyBytes, truncated, capturedPayload: false, payloadPreview: '' })
    if (recorded === 'replay') return (await replay()) ?? { status: 409, error: 'Delivery acknowledgement is unavailable' }
    let runId: string | null = null, sessionId: string | null = null, localSessionId: string | null = null
    try {
        const model = await authority.resolveAutomationModel(id, { connectionId: trigger.connectionId, provider: trigger.provider, model: trigger.model })
        await admission()
        const assertActive = async () => {
            await admission()
            const event = await store.getEvent(id, eventId)
            if (!event || event.stopRequestId || !['accepted', 'running'].includes(event.status)) throw new Error('Trigger delivery was stopped')
        }
        const started = await authority.startTriggerRun({ engineAgentId: id, slug, name: trigger.name, message, model, eventId, assertActive,
            onSessionCreated: async minted => {
                sessionId = minted
                await store.updateEvent(id, eventId, { engineSessionId: minted })
                const chat = await authority.adoptTriggerSession({ localAgentId: owner.localAgentId, engineAgentId: id, engineSessionId: minted, runId: null, title: trigger.name })
                if (chat.agentId !== owner.localAgentId || chat.engineAgentId !== id || chat.engineSessionId !== minted || chat.runId !== null) throw new Error('Trigger conversation acknowledgement changed')
                localSessionId = chat.sessionId
                await store.updateEvent(id, eventId, { localSessionId })
                await assertActive()
            },
            onRunCreated: async (minted, session) => {
                runId = minted
                await store.updateEvent(id, eventId, { runId: minted, engineSessionId: session })
                await assertActive()
            },
        })
        if (started.runId !== runId || started.sessionId !== sessionId) {
            await authority.cancelExactRun(id, started.runId)
            throw new Error('Trigger run was not recorded before execution')
        }
        await store.updateEvent(id, eventId, { status: 'running', capturedPayload: true })
        await authority.markFired(id, slug, receivedAt).catch(() => {})
        if (!started.settled) throw new Error('Trigger settlement is unavailable')
        void started.settled.then(async outcome => {
            await store.updateEvent(id, eventId, { status: outcome.kind === 'cancelled' ? 'cancelled' : outcome.kind === 'error' ? 'error' : outcome.pendingToolCallId ? 'needs-input' : 'finished', pendingToolCallId: outcome.pendingToolCallId ?? null, error: outcome.kind === 'error' ? 'The trigger run failed. Open its chat for details.' : null })
        }).catch(async () => { await store.updateEvent(id, eventId, { status: 'uncertain', error: 'Could not save the trigger outcome. Refresh its history.' }).catch(() => {}) })
        return { status: 202, eventId, runId, sessionId, localSessionId, replay: false }
    } catch {
        let stopped = runId === null
        if (runId) stopped = await authority.cancelExactRun(id, runId).then(() => true, () => false)
        const latest = await store.getEvent(id, eventId).catch(() => null)
        if (!latest || ['accepted', 'running', 'uncertain'].includes(latest.status)) await store.updateEvent(id, eventId, { status: stopped ? latest?.stopRequestId ? 'cancelled' : 'error' : 'uncertain', error: stopped ? 'The trigger could not start. Check its settings and try a new delivery.' : 'The trigger has not finished stopping. Open its chat.' }).catch(() => {})
        return { status: 409, error: stopped ? 'The trigger could not start.' : 'The trigger has not finished stopping.' }
    }
}
