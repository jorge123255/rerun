import { expect, it } from 'vitest'
import { boundedMessage, completionIdentityOf, cursorOf, groupCompletions, groupKeyOf, parseCompletionIdentity, parseCursor, type CompletionRow } from './completed-actions'

const row = (overrides: Partial<CompletionRow> = {}): CompletionRow => ({
    id: 'run-1',
    agentId: 'researcher',
    sessionId: 's1',
    runId: 'run-1',
    source: 'chat',
    slug: null,
    completedAt: '2026-11-04T11:50:00.000Z',
    text: 'Here is the final answer.',
    provider: 'openai',
    model: 'gpt-5',
    costMicros: 123,
    stepCount: 4,
    title: 'Filter before matching',
    ...overrides,
})

it('bounds the final-answer summary to 200 characters with the original fallback', () => {
    expect(boundedMessage(null)).toBe('Message completed')
    expect(boundedMessage('')).toBe('Message completed')
    expect(boundedMessage('   ')).toBe('Message completed')
    expect(boundedMessage('  Hello world  ')).toBe('Hello world')
    const long = 'x'.repeat(500)
    expect(boundedMessage(long)).toBe('x'.repeat(200))
    expect(boundedMessage(long).length).toBe(200)
})

it('keys chat rows by their session and scheduled rows by agent/source/slug', () => {
    expect(groupKeyOf(row())).toBe('s1')
    expect(groupKeyOf(row({ source: 'chat', sessionId: 's9' }))).toBe('s9')
    expect(groupKeyOf(row({ source: 'schedule', slug: 'nightly-sync' }))).toBe('researcher:schedule:nightly-sync')
    expect(groupKeyOf(row({ source: 'trigger', slug: 'webhook' }))).toBe('researcher:trigger:webhook')
    // A scheduled run without a slug is folded like a chat run: by its conversation.
    expect(groupKeyOf(row({ source: 'schedule', slug: null }))).toBe('s1')
})

it('folds runs of the same scheduled task into one ×count row, newest first', () => {
    const groups = groupCompletions([
        row({ id: 'a', source: 'schedule', slug: 'nightly-sync', sessionId: 's1', completedAt: '2026-11-04T11:50:00.000Z', text: 'answer a' }),
        row({ id: 'b', source: 'schedule', slug: 'nightly-sync', sessionId: 's2', completedAt: '2026-11-04T12:00:00.000Z', text: 'answer b' }),
        row({ id: 'c', source: 'schedule', slug: 'nightly-sync', sessionId: 's3', completedAt: '2026-11-04T11:55:00.000Z', text: 'answer c' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
        key: 'researcher:schedule:nightly-sync',
        title: 'nightly-sync',
        message: null,
        count: 3,
        sessionId: 's2', // the newest conversation is the navigation target
        sessionIds: ['s1', 's2', 's3'],
        completionIds: ['a', 'b', 'c'],
        completedAt: '2026-11-04T12:00:00.000Z',
    })
})

it('folds chat runs by conversation and keeps the newest summary and time', () => {
    const groups = groupCompletions([
        row({ id: 'a', sessionId: 's1', completedAt: '2026-11-04T11:50:00.000Z', text: 'first' }),
        row({ id: 'b', sessionId: 's1', completedAt: '2026-11-04T12:00:00.000Z', text: 'second' }),
        row({ id: 'c', sessionId: 's9', completedAt: '2026-11-04T12:10:00.000Z', text: 'other conversation' }),
    ])
    expect(groups).toHaveLength(2)
    // Newest group first.
    expect(groups[0].key).toBe('s9')
    expect(groups[1].key).toBe('s1')
    expect(groups[1]).toMatchObject({ count: 2, message: 'second', completedAt: '2026-11-04T12:00:00.000Z', sessionIds: ['s1', 's1'], completionIds: ['a', 'b'] })
})

it('sorts groups newest first with a stable tie-break on the key', () => {
    const a = row({ id: 'a', sessionId: 's1', completedAt: '2026-11-04T12:00:00.000Z', text: 'a' })
    const b = row({ id: 'b', sessionId: 's2', completedAt: '2026-11-04T12:00:00.000Z', text: 'b' })
    const [first, second] = groupCompletions([a, b])
    expect([first.key, second.key]).toEqual(['s1', 's2'])
})

it('round-trips the stable (time, id) cursor, including ids that contain the separator', () => {
    const completedAt = '2026-11-04T12:00:00.000Z'
    const id = 'run_a__b-1'
    const cursor = cursorOf({ completedAt, id, agentId: 'owner' })
    expect(parseCursor(cursor)).toEqual({ completedAt, id, agentId: 'owner' })
    expect(parseCursor(null)).toBeNull()
    expect(parseCursor(undefined)).toBeNull()
    expect(parseCursor('')).toBeNull()
    expect(parseCursor('no-separator')).toBeNull()
    expect(parseCursor('__missing-time')).toBeNull()
    expect(parseCursor(encodeURIComponent(JSON.stringify([1, 'invalid', id, 'owner'])))).toBeNull()
})

it('binds a completion identity to its exact local owner, engine owner and session', () => {
    const target = { agentId: 'alice', engineAgentId: 'engine-a', engineSessionId: 'chat', terminalId: 'same__run' }
    const id = completionIdentityOf(target)
    expect(parseCompletionIdentity(id)).toEqual(target)
    expect(completionIdentityOf({ ...target, agentId: 'bob' })).not.toBe(id)
    expect(completionIdentityOf({ ...target, engineAgentId: 'replacement' })).not.toBe(id)
    expect(completionIdentityOf({ ...target, engineSessionId: 'other' })).not.toBe(id)
    expect(parseCompletionIdentity('same__run')).toBeNull()
    expect(parseCompletionIdentity(decodeURIComponent(id))).toBeNull()
})
