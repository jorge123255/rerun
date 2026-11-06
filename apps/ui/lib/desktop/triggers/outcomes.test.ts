import { describe, expect, it } from 'vitest'
import { latestTriggerOutcomes, triggerOutcomeKey } from './outcomes'
import type { DesktopTriggerHistoryItem } from '@rerun/contracts'

describe('latestTriggerOutcomes', () => {
    it('does not invent results and prefers ended over running', () => {
        expect(latestTriggerOutcomes([])).toEqual({})
        const outcomes = latestTriggerOutcomes([
            {
                eventId: 'e1', slug: 'hook', triggerName: 'Hook', status: 'running', receivedAt: '2026-11-05T10:00:00.000Z',
                finishedAt: null, localSessionId: 'l1', runId: 'r1', error: null, capturedPayload: true, liveOnly: false,
            },
            {
                eventId: 'e2', slug: 'hook', triggerName: 'Hook', status: 'finished', receivedAt: '2026-11-05T09:00:00.000Z',
                finishedAt: '2026-11-05T09:01:00.000Z', localSessionId: 'l0', runId: 'r0', error: null, capturedPayload: true, liveOnly: false,
            },
            {
                eventId: 'e3', slug: 'other', triggerName: 'Other', status: 'needs-input', receivedAt: '2026-11-05T11:00:00.000Z',
                finishedAt: null, localSessionId: 'l2', runId: 'r2', error: null, capturedPayload: false, liveOnly: true,
            },
        ])
        expect(outcomes[triggerOutcomeKey('hook')].status).toBe('done')
        expect(outcomes[triggerOutcomeKey('hook')].localSessionId).toBe('l0')
        expect(outcomes[triggerOutcomeKey('other')].status).toBe('needs-input')
        expect(outcomes[triggerOutcomeKey('other')].liveOnly).toBe(true)
    })

    it.each([false, true])('keeps the newest waiting chat visible ahead of old Done results (reverse=%s)', reverse => {
        const base = { slug: 'hook', triggerName: 'Hook', finishedAt: null, error: null, capturedPayload: true, liveOnly: false }
        const items: DesktopTriggerHistoryItem[] = [
            { ...base, eventId: 'new-question', status: 'needs-input', receivedAt: '2026-11-06T03:00:00.000Z', localSessionId: 'new-chat', runId: 'new-run' },
            { ...base, eventId: 'old-question', status: 'needs-input', receivedAt: '2026-11-06T02:00:00.000Z', localSessionId: 'older-chat', runId: 'older-run' },
            { ...base, eventId: 'completed', status: 'finished', receivedAt: '2026-11-06T01:00:00.000Z', finishedAt: '2026-11-06T01:01:00.000Z', localSessionId: 'done-chat', runId: 'done-run' },
        ]
        const result = latestTriggerOutcomes(reverse ? items.reverse() : items)[triggerOutcomeKey('hook')]
        expect(result).toMatchObject({ status: 'needs-input', localSessionId: 'new-chat', runId: 'new-run' })
    })
})
