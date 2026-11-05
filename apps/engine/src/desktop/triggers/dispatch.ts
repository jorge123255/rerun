import { randomUUID } from 'node:crypto'
import { DESKTOP_TRIGGER_SLUG_RE, desktopTriggerFireInputSchema, type DesktopTriggerFireInput } from '@rerun/contracts'
import { buildDesktopTriggerMessage, redactTriggerSecrets } from './message.js'
import { hashPayloadFingerprint } from './state.js'
import { tokenMatches } from './token.js'
import type { DesktopTriggerAuthority, DesktopTriggerStore } from './types.js'

export type DesktopTriggerDispatchResult =
    | { status: 202; eventId: string; runId: string; sessionId: string; localSessionId: string | null; replay: boolean }
    | { status: 204 }
    | { status: 404 }
    | { status: 405; allow: string[] }
    | { status: 409; error: string }
    | { status: 413 }
    | { status: 503; error: string }

export async function dispatchDesktopTriggerFire(input: {
    authority: DesktopTriggerAuthority
    store: DesktopTriggerStore
    engineAgentId: string
    slug: string
    fire: DesktopTriggerFireInput
}): Promise<DesktopTriggerDispatchResult> {
    const { authority, store, engineAgentId, slug } = input
    const fire = desktopTriggerFireInputSchema.parse(input.fire)

    try {
        authority.assertActive()
    } catch {
        return { status: 503, error: 'Triggers are stopping' }
    }

    if (!DESKTOP_TRIGGER_SLUG_RE.test(slug) || await store.isRevoked(engineAgentId)) return { status: 404 }

    const trigger = await authority.readTrigger(engineAgentId, slug)
    // Original: every rejection that is not a method mismatch answers 404.
    if (!trigger || !trigger.enabled || !trigger.token || !tokenMatches(fire.token, trigger.token)) return { status: 404 }
    if (!trigger.methods.includes(fire.method)) return { status: 405, allow: trigger.methods }

    let owner
    try {
        owner = await authority.resolveOwnerByEngineId(engineAgentId)
        if (owner.deleting || !owner.enabled) return { status: 404 }
        await authority.assertTriggerGrant(engineAgentId)
        await authority.assertSetupClear(engineAgentId)
        authority.assertActive()
    } catch (error) {
        const message = error instanceof Error ? error.message : 'refused'
        if (/setup/i.test(message)) return { status: 409, error: 'Coworker setup is still pending' }
        if (/grant|permission|capabilities|trigger/i.test(message)) return { status: 404 }
        if (/stopping|shutdown/i.test(message)) return { status: 503, error: 'Triggers are stopping' }
        return { status: 404 }
    }

    const fingerprint = fire.attemptFingerprint
        ? hashPayloadFingerprint({
            method: fire.method,
            query: fire.query,
            contentType: fire.contentType,
            body: fire.body,
            explicit: fire.attemptFingerprint,
        })
        : null

    if (fingerprint) {
        const prior = await store.findEventByFingerprint(engineAgentId, slug, fingerprint)
        if (prior) {
            return {
                status: 202,
                eventId: prior.eventId,
                runId: prior.runId ?? '',
                sessionId: prior.engineSessionId ?? '',
                localSessionId: prior.localSessionId,
                replay: true,
            }
        }
    }

    const receivedAt = new Date().toISOString()
    const { message, truncated } = buildDesktopTriggerMessage(trigger, fire, receivedAt)
    const revision = (await store.getRevision(engineAgentId, slug)) ?? 'r0'
    const eventId = randomUUID().replace(/-/g, '').slice(0, 24)

    const recorded = await store.recordEvent({
        eventId,
        attemptFingerprint: fingerprint,
        localAgentId: owner.localAgentId,
        engineAgentId,
        slug,
        triggerName: trigger.name,
        method: fire.method,
        receivedAt,
        status: 'accepted',
        localSessionId: null,
        engineSessionId: null,
        runId: null,
        revision,
        error: null,
        payloadBytes: fire.bodyBytes,
        truncated,
        capturedPayload: true,
        payloadPreview: fire.body.slice(0, 4096),
    })

    if (recorded === 'replay' && fingerprint) {
        const prior = await store.findEventByFingerprint(engineAgentId, slug, fingerprint)
        if (prior) {
            return {
                status: 202,
                eventId: prior.eventId,
                runId: prior.runId ?? '',
                sessionId: prior.engineSessionId ?? '',
                localSessionId: prior.localSessionId,
                replay: true,
            }
        }
    }

    let model
    try {
        model = await authority.resolveAutomationModel(engineAgentId, {
            connectionId: trigger.connectionId,
            provider: trigger.provider,
            model: trigger.model,
        })
        authority.assertActive()
        await authority.assertTriggerGrant(engineAgentId)
        await authority.assertSetupClear(engineAgentId)
    } catch (error) {
        const safe = redactTriggerSecrets(error instanceof Error ? error.message : 'Model unavailable', [trigger.token, fire.token])
        await store.updateEvent(engineAgentId, eventId, { status: 'refused', error: safe })
        if (/setup/i.test(safe)) return { status: 409, error: 'Coworker setup is still pending' }
        if (/budget|busy|limit/i.test(safe)) return { status: 409, error: safe }
        return { status: 404 }
    }

    let started
    try {
        started = await authority.startTriggerRun({
            engineAgentId,
            slug,
            name: trigger.name,
            message,
            model,
            eventId,
        })
    } catch (error) {
        const safe = redactTriggerSecrets(error instanceof Error ? error.message : 'Could not start trigger run', [trigger.token, fire.token])
        await store.updateEvent(engineAgentId, eventId, { status: 'error', error: safe })
        if (/disabled|not found/i.test(safe)) return { status: 404 }
        if (/busy|limit|budget|unavailable|no model/i.test(safe)) return { status: 409, error: safe }
        return { status: 409, error: 'Could not start trigger run' }
    }

    void authority.markFired(engineAgentId, slug, receivedAt).catch(() => {})

    let localSessionId: string | null = null
    try {
        const chat = await authority.adoptTriggerSession({
            localAgentId: owner.localAgentId,
            engineAgentId,
            engineSessionId: started.sessionId,
            runId: started.runId,
            title: trigger.name,
        })
        localSessionId = chat.sessionId
        await store.updateEvent(engineAgentId, eventId, {
            status: 'running',
            engineSessionId: started.sessionId,
            runId: started.runId,
            localSessionId,
        })
    } catch (error) {
        // Run may already be admitted — keep honest uncertain rather than replaying.
        const safe = redactTriggerSecrets(error instanceof Error ? error.message : 'Adoption failed', [trigger.token])
        await store.updateEvent(engineAgentId, eventId, {
            status: 'uncertain',
            engineSessionId: started.sessionId,
            runId: started.runId,
            error: safe,
        })
    }

    return {
        status: 202,
        eventId,
        runId: started.runId,
        sessionId: started.sessionId,
        localSessionId,
        replay: false,
    }
}
