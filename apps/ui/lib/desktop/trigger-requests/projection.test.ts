import { describe, expect, it } from 'vitest'
import { decorateTriggerAttention, projectTriggerEventOutcome, sameTriggerResultOwner, triggerRequestMetadata, triggerRequestStatus, triggerResultTarget } from './projection'
import { testTriggerLink as link, testTriggerView as view } from './fixtures.test-support'

const event = { eventId: link.eventId, localSessionId: link.sessionId, runId: link.triggerRunId, slug: link.slug, triggerName: 'Arithmetic', status: 'needs-input' as const, receivedAt: '2026-11-05T20:00:00-06:00', finishedAt: null, error: null, capturedPayload: false, liveOnly: false }
describe('webhook attention projection', () => {
    it('keeps the canonical Actions ID and only decorates an exactly owned row', () => {
        const item = { id: link.requestId, kind: 'question', agentId: link.agentId, sessionId: link.sessionId }
        expect(decorateTriggerAttention(item, view)?.id).toBe(link.requestId)
        for (const foreign of [{ ...item, sessionId: 'private-chat' }, { ...item, agentId: 'copy' }, { ...item, id: 'old-request' }]) expect(decorateTriggerAttention(foreign, view)).toBeNull()
        expect(decorateTriggerAttention(item, { ...view, phase: 'accepted' })).toBeNull()
    })
    it('metadata contains only routing identities, not question or interactive answers', () => {
        expect(triggerRequestMetadata(link)).toEqual({ source: 'trigger', triggerSlug: link.slug, eventId: link.eventId, runId: link.triggerRunId, sourceRunId: link.sourceRunId, requestId: link.requestId, requestKind: 'question', agentId: link.agentId, sessionId: link.sessionId })
        expect(JSON.stringify(triggerRequestMetadata(link))).not.toContain('What is')
    })
    it('opens an exact existing trigger tab without selecting a private conversation by name', () => {
        expect(triggerResultTarget(link)).toMatchObject({ sessionId: link.sessionId, tabUid: `trigger:${link.sessionId}`, runId: link.triggerRunId })
        expect(sameTriggerResultOwner(link, { ...link, sessionId: 'private-chat' })).toBe(false)
        expect(sameTriggerResultOwner(link, { ...link, eventId: 'different-delivery' })).toBe(false)
    })
    it('a completed source turn with a question remains attention, not Done', () => {
        expect(projectTriggerEventOutcome(event, [view], { continuation: null, pendingChecked: true })).toMatchObject({ status: 'needs-input', canNotifyDone: false })
        expect(projectTriggerEventOutcome(event, [], { continuation: null, pendingChecked: true })).toMatchObject({ status: 'uncertain', canNotifyDone: false })
    })
    it('a follow-up admission is not a completed result', () => {
        const accepted = { ...view, phase: 'accepted' as const, request: null, acceptedRunId: 'human-run' }
        expect(triggerRequestStatus(accepted)).toBe('Response sent')
        expect(projectTriggerEventOutcome(event, [accepted], { continuation: { id: 'foreign-run', status: 'done' }, pendingChecked: true }).canNotifyDone).toBe(false)
        expect(projectTriggerEventOutcome(event, [accepted], { continuation: { id: 'human-run', status: 'done' }, pendingChecked: false }).canNotifyDone).toBe(false)
        expect(projectTriggerEventOutcome(event, [accepted], { continuation: { id: 'human-run', status: 'done' }, pendingChecked: true })).toMatchObject({ status: 'finished', canNotifyDone: true })
    })
    it.each(['uncertain', 'stop-uncertain'] as const)('never reports Done for %s', phase => {
        expect(projectTriggerEventOutcome(event, [{ ...view, phase }], { continuation: null, pendingChecked: true }).canNotifyDone).toBe(false)
    })
    it.each(['error', 'cancelled'] as const)('preserves actual follow-up %s', status => {
        const result = projectTriggerEventOutcome(event, [{ ...view, phase: 'accepted', acceptedRunId: 'human-run' }], { continuation: { id: 'human-run', status }, pendingChecked: true })
        expect(result.status).toBe(status); expect(result.canNotifyDone).toBe(false)
    })
    it('follows receipt topology instead of array or lexical coworker order', () => {
        const first = { ...view, phase: 'accepted' as const, acceptedRunId: 'human-run-1' }
        const second = { ...first, link: { ...link, sourceRunId: 'human-run-1', requestId: 'second-request' }, acceptedRunId: 'human-run-2' }
        expect(projectTriggerEventOutcome(event, [second, first], { continuation: { id: 'human-run-2', status: 'done' }, pendingChecked: true }).canNotifyDone).toBe(true)
    })
})
