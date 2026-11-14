import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_CLAUDE_CONNECTION_ID } from '@rerun/contracts'
import { forgetPlanLimits, readPlanLimits } from '../../connections/plan-limits.js'
import type { LoadedConnection } from '../../connections/types.js'
import { fetchDesktopClaudePlanUsage, refreshStaleDesktopClaudePlanLimits, resetDesktopClaudePlanLimitPacing } from './usage.js'
import { planLimitWindowsFromClaude } from '../../connections/plan-limits.js'

const names = ['RERUN_DESKTOP_APP', 'RERUN_DESKTOP_CLAUDE_RUNNER', 'RERUN_DESKTOP_CLAUDE_SANDBOX'] as const
const saved = names.map(name => process.env[name])
const connection = (env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' }, id = DESKTOP_CLAUDE_CONNECTION_ID) =>
    ({ id, config: { name: 'Claude', provider: 'claude', models: [], extraModels: [], createdAt: '2026-11-14T00:00:00.000Z' }, env }) as unknown as LoadedConnection
const usage = { rate_limits: { five_hour: { utilization: 41, resets_at: '2026-11-14T15:00:00Z' }, seven_day: { utilization: 12, resets_at: '2026-11-20T00:00:00Z' } } }

beforeEach(() => {
    process.env.RERUN_DESKTOP_APP = '1'
    process.env.RERUN_DESKTOP_CLAUDE_RUNNER = '/fixture/claude'
    process.env.RERUN_DESKTOP_CLAUDE_SANDBOX = '/fixture/claude.sb'
    resetDesktopClaudePlanLimitPacing()
    forgetPlanLimits(DESKTOP_CLAUDE_CONNECTION_ID)
})
afterEach(() => { names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index] }) })

describe('Claude plan limits on demand', () => {
    it('records the session and weekly windows without a reply having run', async () => {
        const read = vi.fn(async () => usage)
        await refreshStaleDesktopClaudePlanLimits(connection(), { HARNESS: '1' }, read, 1_000_000)
        expect(read).toHaveBeenCalledExactlyOnceWith('fixture-token', { HARNESS: '1' })
        expect(readPlanLimits(DESKTOP_CLAUDE_CONNECTION_ID)?.windows).toMatchObject([
            { kind: 'session', usedPercent: 41 },
            { kind: 'weekly', usedPercent: 12 },
        ])
    })

    it('asks at most every five minutes, and once while a read is under way', async () => {
        const read = vi.fn(async () => usage)
        const first = refreshStaleDesktopClaudePlanLimits(connection(), {}, read, 1_000_000)
        void refreshStaleDesktopClaudePlanLimits(connection(), {}, read, 1_000_000)
        await first
        await refreshStaleDesktopClaudePlanLimits(connection(), {}, read, 1_000_000 + 4 * 60_000)
        expect(read).toHaveBeenCalledTimes(1)
        await refreshStaleDesktopClaudePlanLimits(connection(), {}, read, 1_000_000 + 6 * 60_000)
        expect(read).toHaveBeenCalledTimes(2)
    })

    it('does not start Claude for a signed-out plan, another connection, or a failed read', async () => {
        const read = vi.fn(async () => null)
        await refreshStaleDesktopClaudePlanLimits(connection({}), {}, read, 1_000_000)
        await refreshStaleDesktopClaudePlanLimits(connection(undefined, 'another'), {}, read, 1_000_000)
        expect(read).not.toHaveBeenCalled()
        await refreshStaleDesktopClaudePlanLimits(connection(), {}, read, 1_000_000)
        expect(readPlanLimits(DESKTOP_CLAUDE_CONNECTION_ID)).toBeNull()
    })

    it('reads the windows from Anthropic\'s usage endpoint with the plan sign-in', async () => {
        const request = vi.fn(async () => Response.json({ five_hour: { utilization: 41, resets_at: '2026-11-14T15:00:00Z' }, seven_day: { utilization: 12, resets_at: null }, seven_day_opus: null }))
        const usage = await fetchDesktopClaudePlanUsage('fixture-token', request as unknown as typeof fetch)
        const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe('https://api.anthropic.com/api/oauth/usage')
        expect(init.headers).toMatchObject({ authorization: 'Bearer fixture-token', 'anthropic-beta': 'oauth-2025-04-20' })
        expect(init.redirect).toBe('error')
        expect(planLimitWindowsFromClaude(usage)).toMatchObject([{ kind: 'session', usedPercent: 41 }, { kind: 'weekly', usedPercent: 12 }])
    })

    it('has no reading when the endpoint refuses or cannot be reached', async () => {
        expect(await fetchDesktopClaudePlanUsage('fixture-token', (async () => new Response('', { status: 401 })) as unknown as typeof fetch)).toBeNull()
        expect(await fetchDesktopClaudePlanUsage('fixture-token', (async () => { throw new Error('offline') }) as unknown as typeof fetch)).toBeNull()
    })
})
