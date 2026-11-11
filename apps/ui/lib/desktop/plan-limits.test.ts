import { describe, expect, it } from 'vitest'
import type { PlanLimitWindow } from '@rerun/contracts'
import type { BoxConnection } from '@/lib/engine/types'
import { desktopPlanPillUsage, desktopPlanUsage } from './plan-limits'

const NOW = Date.parse('2026-11-09T12:00:00.000Z')
const FRESH = '2026-11-09T11:58:00.000Z'
const session: PlanLimitWindow = { kind: 'session', label: null, usedPercent: 42, resetsAt: '2026-11-09T14:00:00.000Z' }
const weekly: PlanLimitWindow = { kind: 'weekly', label: null, usedPercent: 81, resetsAt: '2026-11-13T08:00:00.000Z' }

function connection(patch: Partial<BoxConnection> = {}): BoxConnection {
    return {
        id: 'codex-1',
        name: 'ChatGPT',
        provider: 'codex',
        models: ['gpt-5.1-codex'],
        extraModels: [],
        createdAt: '2026-11-01T00:00:00.000Z',
        connected: true,
        credentialRejected: false,
        planLimits: { windows: [session, weekly], capturedAt: FRESH },
        ...patch,
    }
}

describe('desktopPlanUsage', () => {
    it('projects fresh redacted windows without fabricating provider data', () => {
        expect(desktopPlanUsage(connection(), NOW)).toEqual({
            status: 'ready', reason: 'fresh', capturedAt: FRESH, windows: [session, weekly],
        })
    })

    it('zeroes a window whose reset passed while retaining the fresh reading', () => {
        const expired = { ...session, usedPercent: 97, resetsAt: '2026-11-09T11:59:00.000Z' }
        expect(desktopPlanUsage(connection({ planLimits: { windows: [expired, weekly], capturedAt: FRESH } }), NOW)).toEqual({
            status: 'ready', reason: 'fresh', capturedAt: FRESH,
            windows: [{ ...expired, usedPercent: 0, resetsAt: null }, weekly],
        })
    })

    it('keeps missing and empty readings explicitly unknown', () => {
        expect(desktopPlanUsage(connection({ planLimits: null }), NOW)).toEqual({
            status: 'unknown', reason: 'missing-reading', capturedAt: null, windows: [],
        })
        expect(desktopPlanUsage(connection({ planLimits: { windows: [], capturedAt: FRESH } }), NOW)).toEqual({
            status: 'unknown', reason: 'empty-reading', capturedAt: null, windows: [],
        })
    })

    it('marks an invalid capture timestamp stale without displaying it as a date', () => {
        expect(desktopPlanUsage(connection({ planLimits: { windows: [session], capturedAt: 'not-a-date' } }), NOW)).toEqual({
            status: 'stale', reason: 'invalid-captured-at', capturedAt: null, windows: [session],
        })
    })

    it('marks readings older than five minutes stale without zeroing their values', () => {
        const capturedAt = '2026-11-09T11:54:59.000Z'
        expect(desktopPlanUsage(connection({ planLimits: { windows: [session], capturedAt } }), NOW)).toEqual({
            status: 'stale', reason: 'stale-reading', capturedAt, windows: [session],
        })
    })

    it('does not show usage for a provider without subscription readings', () => {
        expect(desktopPlanUsage(connection({ provider: 'openrouter' }), NOW)).toEqual({
            status: 'unknown', reason: 'unsupported-provider', capturedAt: null, windows: [],
        })
    })

    it('bounds model windows by highest reported use after session and weekly', () => {
        const low = { ...weekly, kind: 'model' as const, label: 'GPT-4', usedPercent: 12 }
        const high = { ...weekly, kind: 'model' as const, label: 'GPT-5', usedPercent: 93 }
        expect(desktopPlanUsage(connection({ planLimits: { windows: [low, session, high, weekly], capturedAt: FRESH } }), NOW).windows)
            .toEqual([session, weekly, high])
    })
})

describe('desktopPlanPillUsage', () => {
    it('shows session inside the tightest longer window with names and percentages', () => {
        const perModel = { ...weekly, kind: 'model' as const, label: 'GPT-5', usedPercent: 93 }
        expect(desktopPlanPillUsage(connection({ planLimits: { windows: [session, weekly, perModel], capturedAt: FRESH } }), NOW)).toMatchObject({
            inner: 42, outer: 93, label: 'Session 42% used, GPT-5 weekly 93% used', windows: [session, weekly, perModel],
        })
    })

    it('uses a single ring and expires at the first reset or reading deadline', () => {
        const resetting = { ...weekly, resetsAt: new Date(NOW + 2000).toISOString() }
        const source = connection({ planLimits: { windows: [resetting], capturedAt: FRESH } })
        expect(desktopPlanPillUsage(source, NOW)).toMatchObject({ inner: 81, outer: null, nextChangeAt: NOW + 2000 })
        expect(desktopPlanPillUsage(source, NOW + 2000)).toMatchObject({ inner: 0, nextChangeAt: Date.parse(FRESH) + 300001 })
        expect(desktopPlanPillUsage(source, Date.parse(FRESH) + 300001)).toBeNull()
    })

    it('uses Claude subscription readings when the desktop runner supplies them', () => {
        expect(desktopPlanPillUsage(connection({ provider: 'claude' }), NOW)).toMatchObject({
            inner: 42, outer: 81, label: 'Session 42% used, Weekly 81% used',
        })
    })

    it('leaves missing and unsupported readings out of the composer', () => {
        expect(desktopPlanPillUsage(connection({ planLimits: null }), NOW)).toBeNull()
        expect(desktopPlanPillUsage(connection({ provider: 'openrouter' }), NOW)).toBeNull()
    })
})
