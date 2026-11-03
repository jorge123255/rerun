// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopCoworkerMonitoring } from './DesktopCoworkerMonitoring'
import type { DesktopMonitoring, MonitoringRange } from '@/lib/desktop/monitoring'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const alice = { id: 'alice', name: 'Alice', description: '', createdAt: '', updatedAt: '' }
const bob = { ...alice, id: 'bob', name: 'Bob' }

const point = (value: number, count: number, group: string | null = null, bucket = '2026-11-03') => ({ bucket, group, value, count })
const body = (agentId: string, range: MonitoringRange, over: Partial<DesktopMonitoring> = {}): DesktopMonitoring => ({
    agentId, range,
    runs: [point(8, 8)],
    errorRate: [point(0.5, 2, null, '2026-11-02'), point(0, 6)],
    runsByStatus: [point(6, 6, 'done'), point(2, 2, 'error')],
    runsByModel: [point(8, 8, 'local-test')],
    totalTokens: [point(320, 8)],
    cost: [point(2_500_000, 8)],
    ...over,
})

const click = (label: string) => act(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)
    expect(button, label).toBeTruthy()
    button!.click()
})
const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? ''

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers() })

function mount() {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    return { container, root }
}

test('shows the skeleton then the monitoring cards for the coworker', async () => {
    let finish!: (response: Response) => void
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve })).mockResolvedValue(Response.json(body('alice', '7d')))
    vi.stubGlobal('fetch', fetcher)
    const { root } = mount()
    try {
        await act(async () => { root.render(<DesktopCoworkerMonitoring agent={alice} />) })
        await click('Monitoring')
        expect(document.querySelector('[role="dialog"] .animate-pulse')).not.toBeNull()
        await act(async () => { finish(Response.json(body('alice', '7d'))) })
        expect(document.querySelector('[role="dialog"] .animate-pulse')).toBeNull()
        expect(dialogText()).toContain('Runs for Alice over the selected period.')
        expect(dialogText()).toContain('Runs')
        expect(dialogText()).toContain('Error rate')
        expect(dialogText()).toContain('12.5%')
        expect(dialogText()).toContain('Total cost')
        expect(dialogText()).toContain('$2.50')
        expect(dialogText()).toContain('Total tokens')
        expect(dialogText()).toContain('320')
        expect(dialogText()).toContain('Runs over time')
        expect(dialogText()).toContain('Runs by model')
        expect(fetcher.mock.calls.every(([url, init]) => String(url).includes('/monitoring?') && !init?.method)).toBe(true)
    } finally { await act(async () => { root.unmount() }) }
})

test('weights both halves of the error-rate trend by the number of runs', async () => {
    const errorRate = [
        point(0.5, 2, null, '2026-10-31'),
        point(0, 98, null, '2026-11-01'),
        point(0.02, 100, null, '2026-11-02'),
        point(0.02, 100, null, '2026-11-03'),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body('alice', '7d', {
        errorRate, runs: errorRate.map(p => ({ ...p, value: p.count })),
    }))))
    const { root } = mount()
    try {
        await act(async () => { root.render(<DesktopCoworkerMonitoring agent={alice} />) })
        await click('Monitoring')
        const card = [...document.querySelectorAll('[data-slot="card"]')].find(el => el.textContent?.startsWith('Error rate'))
        expect(card?.textContent).toContain('1.7%')
        expect(card?.textContent).toContain('▲ 100%')
    } finally { await act(async () => { root.unmount() }) }
})

test('names the empty period and hides cost and token cards when not recorded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body('alice', '7d', { runs: [], errorRate: [], runsByStatus: [], runsByModel: [], totalTokens: null, cost: null }))))
    const { root } = mount()
    try {
        await act(async () => { root.render(<DesktopCoworkerMonitoring agent={alice} />) })
        await click('Monitoring')
        expect(dialogText()).toContain('No runs in the last 7 days')
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(body('alice', '24h', { runs: [], errorRate: [], runsByStatus: [], runsByModel: [], totalTokens: null, cost: null }))))
        await click('24h')
        expect(dialogText()).toContain('No runs in the last 24 hours')
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(body('alice', '30d', { totalTokens: null, cost: null }))))
        await click('30d')
        expect(dialogText()).toContain('Runs')
        expect(dialogText()).not.toContain('Total cost')
        expect(dialogText()).not.toContain('Total tokens')
    } finally { await act(async () => { root.unmount() }) }
})

test('drops a late reply for a previous range or coworker instead of replacing current data', async () => {
    const pending = new Map<string, (response: Response) => void>()
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>(resolve => pending.set(url, resolve))))
    const { root } = mount()
    try {
        await act(async () => { root.render(<DesktopCoworkerMonitoring agent={alice} />) })
        await click('Monitoring')
        await click('30d')
        await act(async () => { pending.get('/api/desktop/agents/alice/monitoring?range=30d')!(Response.json(body('alice', '30d', { runs: [point(41, 41)] }))) })
        expect(dialogText()).toContain('41')
        const pressed = () => document.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.textContent
        expect(pressed()).toBe('30d')
        await act(async () => { pending.get('/api/desktop/agents/alice/monitoring?range=7d')!(Response.json(body('alice', '7d', { runs: [point(99, 99)] }))) })
        expect(dialogText()).toContain('41')
        expect(dialogText()).not.toContain('99')
        expect(pressed()).toBe('30d')
        await act(async () => { root.render(<DesktopCoworkerMonitoring agent={bob} />) })
        await act(async () => { pending.get('/api/desktop/agents/bob/monitoring?range=7d')!(Response.json(body('bob', '7d', { runs: [point(42, 42)] }))) })
        expect(dialogText()).toContain('Runs for Bob')
        expect(dialogText()).toContain('42')
    } finally { await act(async () => { root.unmount() }) }
})

test('shows the engine error, keeps last data on refresh failure, and retries', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let response = () => Response.json({ error: 'Unavailable' }, { status: 502 })
    vi.stubGlobal('fetch', vi.fn(async () => response()))
    const { root } = mount()
    try {
        await act(async () => { root.render(<DesktopCoworkerMonitoring agent={alice} />) })
        await click('Monitoring')
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not load monitoring. The local engine may be unreachable.')
        expect(document.querySelector('[role="dialog"] .animate-pulse')).toBeNull()
        response = () => Response.json(body('alice', '7d'))
        await click('Retry')
        expect(document.querySelector('[role="alert"]')).toBeNull()
        expect(dialogText()).toContain('Total cost')
        response = () => Response.json({ error: 'Unavailable' }, { status: 502 })
        await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('Showing the last loaded monitoring.')
        expect(dialogText()).toContain('Total cost')
    } finally { await act(async () => { root.unmount() }) }
})
