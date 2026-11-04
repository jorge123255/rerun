import { expect, test } from 'vitest'
import { boardActivityForAgents, boardActivitySchema, latestBoardAttention } from './board-activity'
import type { DesktopAttentionItem } from './attention'

const item = (agentId: string, sessionId = 'pending', updatedAt = '2026-11-04T11:00:00Z'): DesktopAttentionItem => ({
    id: `question-${sessionId}`, agentId, sessionId, agentName: agentId, agentEnabled: true,
    title: sessionId, summary: 'Choose a version', kind: 'question', updatedAt,
})
const attention = (items: DesktopAttentionItem[], unavailableAgentIds: string[] = []) => ({ items, unavailableAgentIds, checkedAt: '2026-11-04T12:00:00Z' })

test('older activity responses default to no attention, and unconfirmed waiting never becomes idle', () => {
    const result = boardActivityForAgents(boardActivitySchema.parse({ agents: { alice: 'waiting_human', bob: 'idle' } }), ['alice', 'bob', 'new'])
    expect(result.statuses).toEqual({ alice: 'unknown', bob: 'idle', new: 'unknown' })
    expect(result.attention.items).toEqual([])
})

test('working and unreachable precede pending requests while partial reads cannot look idle', () => {
    const result = boardActivityForAgents(boardActivitySchema.parse({
        agents: { busy: 'working', failed: 'unreachable', waiting: 'idle', partial: 'idle' },
        attention: attention([item('busy'), item('failed'), item('waiting')], ['waiting', 'partial']),
    }), ['busy', 'failed', 'waiting', 'partial'])
    expect(result.statuses).toEqual({ busy: 'working', failed: 'unreachable', waiting: 'waiting_human', partial: 'unreachable' })
    expect(result.attention.items.map(value => value.agentId)).toEqual(['busy', 'waiting'])
})

test('deleted, foreign and unreported owners cannot contribute a target for a current coworker', () => {
    const result = boardActivityForAgents(boardActivitySchema.parse({ agents: { alice: 'waiting_human', deleted: 'waiting_human' },
        attention: attention([item('foreign'), item('deleted'), item('new')], ['foreign', 'deleted']),
    }), ['alice', 'new'])
    expect(result.statuses).toEqual({ alice: 'unknown', new: 'unknown' })
    expect(result.attention.items).toEqual([])
    expect(result.attention.unavailableAgentIds).toEqual([])
    expect(latestBoardAttention(result.attention, 'alice')).toBeUndefined()
})

test('the newest known pending chat is chosen only within its owner', () => {
    const pending = attention([item('alice', 'older', '2026-11-03T11:00:00Z'),
        { ...item('alice', 'newer'), kind: 'approval' }, item('bob', 'foreign-newest', '2026-11-05T11:00:00Z')])
    expect(latestBoardAttention(pending, 'alice')?.sessionId).toBe('newer')
    expect(latestBoardAttention(pending, 'nobody')).toBeUndefined()
    expect(pending.items.map(value => value.sessionId)).toEqual(['older', 'newer', 'foreign-newest'])
})
