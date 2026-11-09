// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { PlanLimitWindow } from '@rerun/contracts'
import type { BoxConnection } from '@/lib/engine/types'
import { DesktopPlanLimitsBlock } from './DesktopPlanLimitsBlock'

const NOW = Date.parse('2026-11-09T12:00:00.000Z')
const session: PlanLimitWindow = { kind: 'session', label: null, usedPercent: 42, resetsAt: '2026-11-09T14:00:00.000Z' }
const weekly: PlanLimitWindow = { kind: 'weekly', label: null, usedPercent: 81, resetsAt: '2026-11-13T08:00:00.000Z' }
const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
})

afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.useRealTimers()
})

function connection(patch: Partial<BoxConnection> = {}): BoxConnection {
    return {
        id: 'codex-1', name: 'ChatGPT', provider: 'codex', models: ['gpt-5.1-codex'], extraModels: [],
        createdAt: '2026-11-01T00:00:00.000Z', connected: true, credentialRejected: false, planLimits: null, ...patch,
    }
}

async function mount(current: BoxConnection) {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    roots.push(root)
    await act(async () => root.render(<DesktopPlanLimitsBlock connection={current} />))
}

test('missing usage is explicit and renders no zero-valued meter', async () => {
    await mount(connection())
    expect(document.body.textContent).toContain('Usage is unavailable for this ChatGPT account. No usage reading has been recorded.')
    expect(document.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
})

test('a stale reading preserves its values and states that refresh is unavailable', async () => {
    await mount(connection({ planLimits: { windows: [session], capturedAt: '2026-11-09T11:50:00.000Z' } }))
    expect(document.body.textContent).toContain('This usage reading may be stale. Refresh is unavailable in this build.')
    expect(document.body.textContent).toContain('Updated 10m ago')
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42')
})

test('a fresh reading renders the original plan meter presentation and capture age', async () => {
    await mount(connection({ planLimits: { windows: [session, weekly], capturedAt: '2026-11-09T11:58:00.000Z' } }))
    expect(document.body.textContent).toContain('Plan usage')
    expect(document.body.textContent).toContain('Session')
    expect(document.body.textContent).toContain('42% used')
    expect(document.body.textContent).toContain('Updated 2m ago')
    expect(document.body.textContent).not.toContain('Refresh is unavailable')
    expect(document.querySelectorAll('[role="progressbar"]')).toHaveLength(2)
})

test('the mounted usage window is bounded to three meters', async () => {
    const low = { ...weekly, kind: 'model' as const, label: 'GPT-4', usedPercent: 12 }
    const high = { ...weekly, kind: 'model' as const, label: 'GPT-5', usedPercent: 93 }
    await mount(connection({ planLimits: { windows: [low, session, high, weekly], capturedAt: '2026-11-09T11:58:00.000Z' } }))
    const meters = [...document.querySelectorAll('[role="progressbar"]')]
    expect(meters).toHaveLength(3)
    expect(meters.map(meter => meter.getAttribute('aria-label'))).toEqual(['Session limit used', 'Weekly limit used', 'GPT-5 weekly limit used'])
    expect(document.body.textContent).not.toContain('GPT-4 weekly')
})
