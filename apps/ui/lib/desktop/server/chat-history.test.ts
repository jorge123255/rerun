import { expect, test, vi } from 'vitest'
import { filterDesktopChats } from '../chat-history'
import { PENDING_QUESTION_READ_CONCURRENCY, readDesktopChatHistory, type DesktopHistoryEngineSession } from './chat-history'
import type { DesktopSession } from './store'

const agent = { id: 'alice', engineAgentId: 'engine-alice' }
const time = '2026-11-03T12:00:00.000Z'
const local = (id: string, agentId = agent.id): DesktopSession => ({ id, agentId, engineSessionId: `engine-${id}`, title: `Chat ${id}`, createdAt: time, updatedAt: time, modelConnectionId: null, model: null })
const remote = (id: string, source: DesktopHistoryEngineSession['source'] = 'dashboard', agentId = agent.engineAgentId): DesktopHistoryEngineSession => ({ id: `engine-${id}`, agentId, source, updatedAt: '2026-11-04T12:00:00.000Z' })

test('enriches only deduplicated local chats owned by the selected coworker and keeps local selection IDs', async () => {
    const pending = vi.fn(async (id: string) => id === 'approval' ? 'Review the proposed title' : null)
    const history = await readDesktopChatHistory({
        listLocalSessions: vi.fn(async () => [local('chat'), local('approval'), local('chat'), local('foreign', 'bob')]),
        listEngineSessions: vi.fn(async () => [remote('chat'), remote('approval', 'schedule'), remote('engine-only'), remote('foreign', 'trigger', 'engine-bob')]),
        pendingQuestionFor: pending,
    }, agent)
    expect(history.enrichment).toBe('ok')
    expect(history.conversations.map(row => row.id).sort()).toEqual(['approval', 'chat'])
    expect(pending.mock.calls.map(([id]) => id).sort()).toEqual(['approval', 'chat'])
    expect(history.conversations.find(row => row.id === 'approval')).toMatchObject({ agentId: 'alice', engineSessionId: 'engine-approval', source: 'schedule', needsYou: true, pendingQuestion: 'Review the proposed title' })
    expect(filterDesktopChats(history.conversations, 'automations', '')[0].id).toBe('approval')
})

test('missing, foreign and invalid source metadata remain unknown instead of implying no automated chats', async () => {
    const engine = [remote('known'), remote('foreign', 'trigger', 'engine-bob'), { ...remote('invalid'), source: 'made-up' }, { ...remote('bad-date'), updatedAt: 'not-a-date' }] as DesktopHistoryEngineSession[]
    const history = await readDesktopChatHistory({ listLocalSessions: async () => ['known', 'missing', 'foreign', 'invalid', 'bad-date'].map(id => local(id)),
        listEngineSessions: async () => engine, pendingQuestionFor: async () => null }, agent)
    expect(history.enrichment).toBe('unavailable')
    expect(history.conversations.filter(row => row.id !== 'known').every(row => row.source === null && row.updatedAt === time)).toBe(true)
    expect(filterDesktopChats(history.conversations, 'all', '')).toHaveLength(5)
    expect(filterDesktopChats(history.conversations, 'chats', '').map(row => row.id)).toEqual(['known'])
    expect(filterDesktopChats(history.conversations, 'automations', '')).toEqual([])
})

test('engine and individual pending-request failures retain saved chats and known pending requests', async () => {
    const history = await readDesktopChatHistory({ listLocalSessions: async () => [local('known'), local('failed')],
        listEngineSessions: async () => { throw new Error('Engine unavailable') },
        pendingQuestionFor: async id => { if (id === 'failed') throw new Error('History unavailable'); return 'Choose a color' } }, agent)
    expect(history.enrichment).toBe('unavailable')
    expect(history.questions).toBe('unavailable')
    expect(history.conversations).toHaveLength(2)
    expect(filterDesktopChats(history.conversations, 'needs', '').map(row => row.id)).toEqual(['known'])
})

test('missing General metadata does not make the Threads filters incomplete', async () => {
    const history = await readDesktopChatHistory({
        listLocalSessions: async () => [{ ...local('general'), kind: 'general' }, local('routine')],
        listEngineSessions: async () => [remote('routine', 'schedule')],
        pendingQuestionFor: async () => null,
    }, agent)
    expect(history.enrichment).toBe('ok')
    expect(filterDesktopChats(history.conversations, 'automations', '').map(row => row.id)).toEqual(['routine'])
})

test('uses a published result title for the owned automation without replacing its local chat id', async () => {
    const result = { title: 'No new leads', outcome: 'nothing' } as const
    const history = await readDesktopChatHistory({
        listLocalSessions: async () => [local('routine'), local('ordinary'), local('foreign')],
        listEngineSessions: async () => [
            { ...remote('routine', 'schedule'), automationResult: result },
            { ...remote('ordinary'), automationResult: result },
            { ...remote('foreign', 'trigger', 'engine-bob'), automationResult: result },
        ],
    }, agent)
    expect(history.conversations.find(row => row.id === 'routine')).toMatchObject({ title: result.title, automationOutcome: result.outcome })
    expect(history.conversations.find(row => row.id === 'ordinary')).toMatchObject({ title: 'Chat ordinary' })
    expect(history.conversations.find(row => row.id === 'foreign')).toMatchObject({ title: 'Chat foreign' })
    expect(filterDesktopChats(history.conversations, 'automations', 'new leads').map(row => row.id)).toEqual(['routine'])
})

test('bounds pending-request reads while processing the full saved list beyond one screen', async () => {
    const sessions = Array.from({ length: 75 }, (_, index) => local(String(index)))
    let active = 0, maximum = 0
    let release!: () => void, filled!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const workersFilled = new Promise<void>(resolve => { filled = resolve })
    const reading = readDesktopChatHistory({ listLocalSessions: async () => sessions,
        listEngineSessions: async () => sessions.map(row => remote(row.id, row.id === '74' ? 'trigger' : 'dashboard')),
        pendingQuestionFor: async id => {
            active++; maximum = Math.max(maximum, active)
            if (active === PENDING_QUESTION_READ_CONCURRENCY) filled()
            try { await gate; return id === '74' ? 'Approve the final item' : null } finally { active-- }
        } }, agent)
    await workersFilled
    release()
    const history = await reading
    expect(maximum).toBe(PENDING_QUESTION_READ_CONCURRENCY)
    expect(history.conversations).toHaveLength(75)
    expect(filterDesktopChats(history.conversations, 'needs', '74').map(row => row.id)).toEqual(['74'])
    expect(filterDesktopChats(history.conversations, 'automations', '74').map(row => row.id)).toEqual(['74'])
})

test('the thread list leaves General out and can match an opening line', () => {
    const row = (id: string, kind: 'general' | 'thread', firstMessage: string | null) => ({
        id, agentId: 'alice', engineSessionId: `engine-${id}`, title: id, createdAt: time, updatedAt: time,
        source: 'dashboard' as const, needsYou: false, pendingQuestion: null, kind, firstMessage,
    })
    expect(filterDesktopChats([row('General', 'general', null), row('Notes', 'thread', 'Check the funnel')], 'all', '').map(item => item.id)).toEqual(['Notes'])
    expect(filterDesktopChats([row('Notes', 'thread', 'Check the funnel')], 'all', 'funnel').map(item => item.id)).toEqual(['Notes'])
    expect(filterDesktopChats([row('Notes', 'thread', 'E\u0301VALUATION')], 'all', 'évaluation').map(item => item.id)).toEqual(['Notes'])
})
