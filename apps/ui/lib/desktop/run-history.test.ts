import { expect, test } from 'vitest'
import type { Run } from '@rerun/contracts'
import { desktopRunView, recordedRunUsage } from './run-history'

const run: Run = { id: 'r', agentId: 'a', sessionId: 's', status: 'done', stepCount: 1, startedAt: '2026-11-03T12:00:00.000Z', finishedAt: null,
    usageJson: null, inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, reasoningTokens: null, costMicros: null,
    provider: null, model: null, triggerSource: null, triggerSlug: null, error: null }
test('shows unrecorded usage honestly, including malformed legacy usage', () => {
    for (const usageJson of [null, '{bad', '{"totalTokens":-1}', '{"totalTokens":"10"}'])
        expect(recordedRunUsage(desktopRunView({ ...run, usageJson }))).toEqual({
            total: null, input: null, output: null, cachedInput: null, reasoning: null, cost: null,
        })
})
test('preserves recorded zero, prefers structured counts, and can read legacy usage', () => {
    expect(recordedRunUsage(desktopRunView({ ...run, totalTokens: 0 })).total).toBe(0)
    expect(desktopRunView({ ...run, usageJson: '{"totalTokens":99}', totalTokens: 16 }).totalTokens).toBe(16)
    expect(recordedRunUsage(desktopRunView({ ...run, usageJson: '{"inputTokens":12,"outputTokens":4}' }))).toMatchObject({ total: 16, input: 12, output: 4 })
})
test('keeps partial usage partial and includes recorded cached, reasoning, and cost values', () => {
    expect(recordedRunUsage(desktopRunView({ ...run, inputTokens: 12 }))).toMatchObject({ total: null, input: 12, output: null })
    expect(recordedRunUsage(desktopRunView({ ...run, cachedInputTokens: 0, reasoningTokens: 2, costMicros: 1000 }))).toMatchObject({ cachedInput: 0, reasoning: 2, cost: 0.001 })
})
