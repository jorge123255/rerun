import { expect, test } from 'vitest'
import { readDesktopProviderUsage } from './usage.js'

test('totals each provider across coworkers for the last day and week, skipping a coworker that cannot be read', async () => {
    const now = Date.parse('2026-11-14T12:00:00.000Z')
    const usage = await readDesktopProviderUsage(now, {
        agents: async () => ['one', 'two', 'broken'],
        usage: async (agentId, since) => {
            if (agentId === 'broken') throw new Error('unreadable')
            const day = since === '2026-11-13T12:00:00.000Z'
            return agentId === 'one'
                ? [{ provider: 'codex', totalTokens: day ? 100 : 900, runCount: day ? 2 : 9 }, { provider: null, totalTokens: 5, runCount: 1 }]
                : [{ provider: 'codex', totalTokens: day ? 50 : 60, runCount: 1 }, { provider: 'kimi-code', totalTokens: 0, runCount: day ? 0 : 4 }]
        },
    })
    expect(usage.since).toEqual({ day: '2026-11-13T12:00:00.000Z', week: '2026-11-07T12:00:00.000Z' })
    expect(usage.providers).toEqual({
        codex: { day: { replies: 3, tokens: 150 }, week: { replies: 10, tokens: 960 } },
        'kimi-code': { day: { replies: 0, tokens: 0 }, week: { replies: 4, tokens: 0 } },
    })
})
