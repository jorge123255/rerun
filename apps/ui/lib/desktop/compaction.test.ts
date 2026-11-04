import { expect, test } from 'vitest'
import { desktopCompactionData, desktopCompactionSteps } from './compaction'

const part = (data: unknown, id?: string) => ({
    type: 'data-compaction',
    ...(id !== undefined && { id }),
    data,
})

test('accepts the engine’s running, completed and failed events', () => {
    expect(desktopCompactionData(part({ status: 'running' }))).toEqual({ status: 'running' })
    expect(desktopCompactionData(part({ status: 'done', messagesCompacted: 10, tokensRecovered: 1234 })))
        .toEqual({ status: 'done', messagesCompacted: 10, tokensRecovered: 1234 })
    expect(desktopCompactionData(part({ status: 'error' }))).toEqual({ status: 'error' })
})

const invalidEvents: [string, Record<string, unknown>][] = [
    ['an unknown status', { status: 'settled' }],
    ['a missing status', {}],
]
test.each(invalidEvents)('drops an event it cannot label: %s', (_name, data) => {
    expect(desktopCompactionData(part(data))).toBeUndefined()
})

const invalidMetrics: [string, Record<string, unknown>][] = [
    ['a NaN message count', { messagesCompacted: Number.NaN }],
    ['an infinite message count', { messagesCompacted: Number.POSITIVE_INFINITY }],
    ['a negative message count', { messagesCompacted: -1 }],
    ['a fractional message count', { messagesCompacted: 1.5 }],
    ['a string message count', { messagesCompacted: '10' }],
    ['a NaN token count', { tokensRecovered: Number.NaN }],
    ['an infinite token count', { tokensRecovered: Number.POSITIVE_INFINITY }],
    ['a negative token count', { tokensRecovered: -2 }],
    ['a string token count', { tokensRecovered: '900' }],
]
test.each(invalidMetrics)('keeps a real completed event but omits %s', (_name, metrics) => {
    expect(desktopCompactionData(part({ status: 'done', ...metrics }))).toEqual({ status: 'done' })
})

test('rejects anything that is not a data-compaction event', () => {
    expect(desktopCompactionData(undefined)).toBeUndefined()
    expect(desktopCompactionData({ type: 'text', text: 'Not a compaction' })).toBeUndefined()
    expect(desktopCompactionData({ type: 'data-compaction' })).toBeUndefined()
    expect(desktopCompactionData({ type: 'data-compaction', data: null })).toBeUndefined()
    expect(desktopCompactionData({ type: 'data-compaction', data: 'done' })).toBeUndefined()
})

test('an unconfirmed running row is suppressed when its stream ends, not shown as failed', () => {
    const running = part({ status: 'running' }, 'checkpoint-1')
    expect(desktopCompactionSteps([running], true).get(0)?.data).toEqual({ status: 'running' })
    expect(desktopCompactionSteps([running], false).size).toBe(0)
    // The validator reports the event as received; the projection decides not to draw it.
    expect(desktopCompactionData(running)).toEqual({ status: 'running' })
})

test('a completed event survives its stream ending at the first position', () => {
    const steps = desktopCompactionSteps([
        { type: 'text', text: 'Before' },
        part({ status: 'running' }, 'checkpoint-1'),
        part({ status: 'done', messagesCompacted: 3, tokensRecovered: 900 }, 'checkpoint-1'),
    ], false)
    expect([...steps.entries()]).toEqual([
        [1, { key: 'compaction-checkpoint-1', data: { status: 'done', messagesCompacted: 3, tokensRecovered: 900 } }],
    ])
})

test('a received error event keeps its failure wording after the stream ends', () => {
    const steps = desktopCompactionSteps([
        part({ status: 'running' }, 'checkpoint-1'),
        part({ status: 'error' }, 'checkpoint-1'),
    ], false)
    expect([...steps.values()]).toEqual([
        { key: 'compaction-checkpoint-1', data: { status: 'error' } },
    ])
})

test('re-emitted events settle one row in place at its first position', () => {
    const steps = desktopCompactionSteps([
        { type: 'text', text: 'Before' },
        part({ status: 'running' }, 'checkpoint-1'),
        part({ status: 'done', messagesCompacted: 3, tokensRecovered: 900 }, 'checkpoint-1'),
        part({ status: 'running' }, 'checkpoint-2'),
    ], true)
    expect([...steps.entries()]).toEqual([
        [1, { key: 'compaction-checkpoint-1', data: { status: 'done', messagesCompacted: 3, tokensRecovered: 900 } }],
        [3, { key: 'compaction-checkpoint-2', data: { status: 'running' } }],
    ])
})

test('an invalid later event does not erase the last valid state', () => {
    const steps = desktopCompactionSteps([
        part({ status: 'done', messagesCompacted: 4, tokensRecovered: 1200 }, 'checkpoint-1'),
        part({ status: 'finished' }, 'checkpoint-1'),
    ], false)
    expect([...steps.values()]).toEqual([
        { key: 'compaction-checkpoint-1', data: { status: 'done', messagesCompacted: 4, tokensRecovered: 1200 } },
    ])
})

test('events without an id each keep their own row', () => {
    const steps = desktopCompactionSteps([
        part({ status: 'running' }),
        part({ status: 'running' }),
    ], true)
    expect([...steps.entries()]).toEqual([
        [0, { key: 'compaction-0', data: { status: 'running' } }],
        [1, { key: 'compaction-1', data: { status: 'running' } }],
    ])
})
