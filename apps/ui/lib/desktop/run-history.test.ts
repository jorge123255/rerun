import { expect, test } from 'vitest'
import type { Run } from '@rerun/contracts'
import { desktopRunView, recordedRunUsage } from './run-history'

const run: Run = { id: 'r', agentId: 'a', sessionId: 's', status: 'done', stepCount: 1, startedAt: '2026-11-03T12:00:00.000Z', finishedAt: null,
    usageJson: null, inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, reasoningTokens: null, costMicros: null,
    provider: null, model: null, triggerSource: null, triggerSlug: null, error: null }
test('shows unrecorded usage honestly, including malformed legacy usage', () => {
    for (const usageJson of [null, '{bad', '{"totalTokens":-1}', '{"totalTokens":"10"}'])
        expect(recordedRunUsage(desktopRunView({ ...run, usageJson }))).toBe('Usage not recorded')
})
test('preserves recorded zero, prefers structured counts, and can read legacy usage', () => {
    expect(recordedRunUsage(desktopRunView({ ...run, totalTokens: 0 }))).toBe('0 tokens')
    expect(desktopRunView({ ...run, usageJson: '{"totalTokens":99}', totalTokens: 16 }).totalTokens).toBe(16)
    expect(recordedRunUsage(desktopRunView({ ...run, usageJson: '{"inputTokens":12,"outputTokens":4}' }))).toBe('16 tokens · 12 input · 4 output')
})
test('keeps partial usage partial and includes recorded cached, reasoning, and cost values', () => {
    expect(recordedRunUsage(desktopRunView({ ...run, inputTokens: 12 }))).toBe('12 input')
    expect(recordedRunUsage(desktopRunView({ ...run, cachedInputTokens: 0, reasoningTokens: 2, costMicros: 1000 }))).toBe('0 cached input · 2 reasoning · $0.001 recorded cost')
})
