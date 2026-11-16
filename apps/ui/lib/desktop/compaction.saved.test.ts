import { expect, test } from 'vitest'
import type { EngineMessage } from '@/lib/engine/types'
import { transformEngineMessages } from '@/lib/chat/engine-history'
import { savedCompactionOf } from './compaction'

const ID = 'a'.repeat(21)
const row = (id: string, role: 'user' | 'assistant', text: string, extra: Partial<EngineMessage> = {}): EngineMessage => ({
    id, sessionId: 'session', role, contentJson: JSON.stringify([{ type: 'text', text }]), toolCallsJson: null, createdAt: '2026-11-12T00:00:00.000Z', ...extra,
} as EngineMessage)

test('a reopened chat carries the saved compaction on the prompt that caused it, and nowhere else', () => {
    const history = transformEngineMessages([
        row('m1', 'user', 'Earlier prompt'),
        row('m2', 'assistant', 'Earlier reply'),
        row('m3', 'user', 'The prompt that filled the context', { desktopCompaction: { id: ID, status: 'done', messagesCompacted: 12, tokensRecovered: 4321 } }),
        row('m4', 'assistant', 'The reply after it'),
    ])
    expect(history.map(message => savedCompactionOf(message))).toEqual([
        undefined, undefined, { id: ID, status: 'done', messagesCompacted: 12, tokensRecovered: 4321 }, undefined,
    ])
})

test('a saved failure is kept as a failure, with no counts', () => {
    const [message] = transformEngineMessages([row('m1', 'user', 'Prompt', { desktopCompaction: { id: ID, status: 'error' } })])
    expect(savedCompactionOf(message!)).toEqual({ id: ID, status: 'error' })
})

test('only a complete receipt on a prompt draws a row', () => {
    const done = { id: ID, status: 'done', messagesCompacted: 3, tokensRecovered: 10 }
    expect(savedCompactionOf({ role: 'user', metadata: { compactionReceipt: done } })).toEqual(done)
    // A reply never carries one, a row still running was never settled, and invented or partial counts are refused.
    expect(savedCompactionOf({ role: 'assistant', metadata: { compactionReceipt: done } })).toBeUndefined()
    for (const receipt of [undefined, null, 'done', { id: ID, status: 'running' }, { id: ID, status: 'done' }, { id: ID, status: 'done', messagesCompacted: 0, tokensRecovered: 1 },
        { id: 'short', status: 'done', messagesCompacted: 3, tokensRecovered: 10 }, { ...done, summary: 'leaked text' }]) {
        expect(savedCompactionOf({ role: 'user', metadata: { compactionReceipt: receipt } }), JSON.stringify(receipt)).toBeUndefined()
    }
    expect(savedCompactionOf({ role: 'user', metadata: undefined })).toBeUndefined()
})
