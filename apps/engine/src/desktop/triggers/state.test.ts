import { describe, expect, it } from 'vitest'
import { createClient } from '@libsql/client'
import { createDesktopTriggerStore, hashPayloadFingerprint, nextRevision } from './state.js'

function memoryClient() {
    const client = createClient({ url: ':memory:' })
    return async () => client
}

describe('desktop trigger durable state', () => {
    it('bumps revisions and replays mutations by request id', async () => {
        const store = createDesktopTriggerStore(memoryClient())
        await store.initialize('eng-1')
        const r1 = await store.bumpRevision('eng-1', 'hook')
        const r2 = await store.bumpRevision('eng-1', 'hook')
        expect(r1).not.toEqual(r2)
        expect(nextRevision(r2).startsWith('r')).toBe(true)

        await store.rememberMutation({
            engineAgentId: 'eng-1',
            requestId: '11111111-1111-1111-1111-111111111111',
            kind: 'rotate',
            slug: 'hook',
            revisionBefore: r1,
            revisionAfter: r2,
            resultJson: JSON.stringify({ ok: true, revision: r2 }),
        })
        await store.rememberMutation({
            engineAgentId: 'eng-1',
            requestId: '11111111-1111-1111-1111-111111111111',
            kind: 'rotate',
            slug: 'hook',
            revisionBefore: r2,
            revisionAfter: 'r99',
            resultJson: JSON.stringify({ ok: false }),
        })
        const found = await store.findMutation('eng-1', '11111111-1111-1111-1111-111111111111')
        expect(found?.resultJson).toContain(r2)
    })

    it('treats independent events as distinct and replays only explicit fingerprints', async () => {
        const store = createDesktopTriggerStore(memoryClient())
        await store.initialize('eng-1')
        const base = {
            localAgentId: 'local-1',
            engineAgentId: 'eng-1',
            slug: 'hook',
            triggerName: 'Hook',
            method: 'POST' as const,
            receivedAt: new Date().toISOString(),
            status: 'accepted' as const,
            localSessionId: null,
            engineSessionId: null,
            runId: null,
            revision: 'r1',
            error: null,
            payloadBytes: 2,
            truncated: false,
            capturedPayload: true,
            payloadPreview: '{}',
        }
        expect(await store.recordEvent({ ...base, eventId: 'e1', attemptFingerprint: null })).toBe('created')
        expect(await store.recordEvent({ ...base, eventId: 'e2', attemptFingerprint: null })).toBe('created')
        const fp = hashPayloadFingerprint({ method: 'POST', query: '', contentType: 'application/json', body: '{}', explicit: 'attempt-1' })
        expect(fp).toBeTruthy()
        expect(await store.recordEvent({ ...base, eventId: 'e3', attemptFingerprint: fp })).toBe('created')
        expect(await store.recordEvent({ ...base, eventId: 'e4', attemptFingerprint: fp })).toBe('replay')
        const events = await store.listEvents('eng-1', 'hook')
        expect(events).toHaveLength(3)
    })

    it('revokes owner ingress authority and marks incomplete events uncertain without replay', async () => {
        const store = createDesktopTriggerStore(memoryClient())
        await store.initialize('eng-1')
        await store.recordEvent({
            eventId: 'e1',
            attemptFingerprint: null,
            localAgentId: 'local-1',
            engineAgentId: 'eng-1',
            slug: 'hook',
            triggerName: 'Hook',
            method: 'POST',
            receivedAt: new Date().toISOString(),
            status: 'running',
            localSessionId: null,
            engineSessionId: 's1',
            runId: 'r1',
            revision: 'r1',
            error: null,
            payloadBytes: 0,
            truncated: false,
            capturedPayload: true,
            payloadPreview: '',
        })
        await store.recoverUncertain('eng-1')
        const event = await store.getEvent('eng-1', 'e1')
        expect(event?.status).toBe('uncertain')
        await store.revokeOwner('eng-1')
        expect(await store.isRevoked('eng-1')).toBe(true)
    })
})
