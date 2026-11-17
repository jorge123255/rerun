import { describe, expect, it } from 'vitest'
import { phoneInboxItems, phoneInboxReadTargets } from './phone-inbox'

const pending = [
    { id: 'q1', kind: 'question' as const, agentId: 'ada', agentName: 'Ada', agentEnabled: true, sessionId: 's1', title: 'Chart', summary: 'Which color?', requestedAt: '2026-11-17T10:00:00.000Z', updatedAt: '2026-11-17T11:00:00.000Z' },
    { id: 'a1', kind: 'approval' as const, agentId: 'bo', agentName: 'Bo', agentEnabled: true, sessionId: 's2', title: 'Invoice', summary: 'Send the invoice', updatedAt: '2026-11-17T09:00:00.000Z' },
    { id: 's1', kind: 'secret' as const, agentId: 'bo', agentName: 'Bo', agentEnabled: true, sessionId: 's3', title: 'Stripe', summary: 'Needs API key', updatedAt: '2026-11-17T08:00:00.000Z' },
]
const done = [{ id: 'g1', agentId: 'ada', agentName: 'Ada', agentEnabled: true, sessionId: 's9', sessionIds: ['s9', 's8'], title: 'Daily digest', message: null, source: 'schedule' as const, slug: 'digest', count: 2, completedAt: '2026-11-17T07:00:00.000Z', completionIds: ['c-1', 'c-2'] }]

describe('the inbox a paired phone lists', () => {
    it('lists what waits, then what finished, and says what only the Mac settles', () => {
        const items = phoneInboxItems(pending, done)
        expect(items.map(item => [item.id, item.state, item.sessionId, item.updatedAt, item.count])).toEqual([
            ['p:q1', 'question', 's1', '2026-11-17T10:00:00.000Z', 1],
            ['p:a1', 'approval', 's2', '2026-11-17T09:00:00.000Z', 1],
            ['p:s1', 'on-mac', 's3', '2026-11-17T08:00:00.000Z', 1],
            ['d:g1', 'done', 's9', '2026-11-17T07:00:00.000Z', 2],
        ])
        expect(items[3].sessionIds).toEqual(['s9', 's8'])
        // The identities the Mac marks completions read by stay on the Mac.
        expect(JSON.stringify(items)).not.toContain('c-1')
    })

    it('marks read only rows the inbox still holds, by the Mac\'s own targets', () => {
        expect(phoneInboxReadTargets(['p:q1', 'd:g1', 'p:gone', 'q1', 'd:c-1'], pending, done)).toEqual({
            items: [{ id: 'q1', kind: 'question', agentId: 'ada', sessionId: 's1' }],
            completionIds: ['c-1', 'c-2'],
        })
        expect(phoneInboxReadTargets([], pending, done)).toEqual({ items: [], completionIds: [] })
        // A pending id and a finished one never stand in for each other.
        expect(phoneInboxReadTargets(['d:q1', 'p:g1'], pending, done)).toEqual({ items: [], completionIds: [] })
    })
})
