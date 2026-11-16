// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopActivityRow, DesktopActivityView } from '@/lib/desktop/activity'
import { ACTIVITY_REFRESH_MS, DesktopActivityPanel } from './DesktopActivityDialog'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

const row = (seq: number, overrides: Partial<DesktopActivityRow> = {}): DesktopActivityRow => ({
    seq, id: `r${seq}`, at: '2026-11-16T09:00:00.000Z', coworker: 'Scout', coworkerId: 'app-scout', deleted: false, conversationId: 'chat-1', sentence: `Scout did action ${seq}`,
    outcome: 'completed', ruleWords: 'Permission: Use apps', tool: 'GMAIL_SEND_EMAIL', action: null, app: 'Gmail', kind: 'send', source: 'chat', sourceSlug: null, durationMs: 20, summary: null, ...overrides,
})
const view = (rows: DesktopActivityRow[], overrides: Partial<DesktopActivityView> = {}): DesktopActivityView => ({ rows, next: null, total: rows.length, dropped: 0, coworkers: [{ id: 'app-scout', name: 'Scout' }], ...overrides })

async function mount(initial: DesktopActivityView) {
    vi.useFakeTimers()
    const state = { view: initial }
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { requests.push(String(url)); return Response.json(state.view) }))
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    roots.push(root)
    await act(async () => { root.render(<DesktopActivityPanel />) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    const scroller = host.querySelector<HTMLElement>('[data-testid=desktop-activity] > .overflow-y-auto')!
    const scrolls: unknown[] = []
    scroller.scrollTo = ((options: unknown) => { scrolls.push(options); scroller.scrollTop = 0 }) as typeof scroller.scrollTo
    return { host, state, requests, scroller, scrolls, tick: () => act(async () => { await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS) }) }
}
const ids = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-activity-row]')]
const sentences = (host: HTMLElement) => ids(host).map(node => node.querySelector('.flex-1')!.textContent)
const pill = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[data-activity-new-pill]')

test('opening the view shows its rows settled, then reads the trail again every five seconds with the same request', async () => {
    const { host, requests, tick } = await mount(view([row(2), row(1)]))
    expect(requests).toEqual(['/api/desktop/activity?'])
    for (const node of ids(host)) { expect(node.hasAttribute('data-activity-fresh')).toBe(false); expect(node.className).toBe('') }
    await tick()
    expect(requests).toEqual(['/api/desktop/activity?', '/api/desktop/activity?'])
    // Nothing new: nothing moves, no pill, and the list was not replaced by a loading state.
    expect(sentences(host)).toEqual(['Scout did action 2', 'Scout did action 1'])
    expect(ids(host).every(node => !node.hasAttribute('data-activity-fresh'))).toBe(true)
    expect(pill(host)).toBeNull()
    expect(host.querySelector('[aria-busy]')).toBeNull()
})

test('at the top, new records slide in above the others', async () => {
    const { host, state, tick } = await mount(view([row(2), row(1)]))
    state.view = view([row(4), row(3), row(2), row(1)])
    await tick()
    expect(sentences(host)).toEqual(['Scout did action 4', 'Scout did action 3', 'Scout did action 2', 'Scout did action 1'])
    expect(ids(host).map(node => node.hasAttribute('data-activity-fresh'))).toEqual([true, true, false, false])
    const fresh = ids(host)[0]!
    for (const name of ['animate-in', 'fade-in-0', 'slide-in-from-top-2', 'motion-reduce:animate-none']) expect(fresh.classList.contains(name)).toBe(true)
    expect(pill(host)).toBeNull()
    expect(host.textContent).toContain('4 actions')
})

test('scrolled down, the list does not move: a pill counts what is new, and a click goes up and reveals it', async () => {
    const { host, state, scroller, scrolls, tick } = await mount(view([row(2), row(1)]))
    scroller.scrollTop = 240
    state.view = view([row(3), row(2), row(1)])
    await tick()
    expect(sentences(host)).toEqual(['Scout did action 2', 'Scout did action 1'])
    expect(pill(host)!.textContent).toBe('1 new action. Show it.')
    // It floats over the list and takes no room, so the rows under it stay where they are.
    expect(pill(host)!.parentElement!.className).toContain('h-0')
    expect(pill(host)!.parentElement!.className).toContain('sticky')
    state.view = view([row(5), row(4), row(3), row(2), row(1)])
    await tick()
    expect(sentences(host)).toEqual(['Scout did action 2', 'Scout did action 1'])
    expect(pill(host)!.textContent).toBe('3 new actions. Show them.')

    await act(async () => { pill(host)!.click() })
    expect(scrolls).toEqual([{ top: 0, behavior: 'smooth' }])
    expect(sentences(host)).toEqual(['Scout did action 5', 'Scout did action 4', 'Scout did action 3', 'Scout did action 2', 'Scout did action 1'])
    expect(ids(host).map(node => node.hasAttribute('data-activity-fresh'))).toEqual([true, true, true, false, false])
    expect(pill(host)).toBeNull()
    expect(host.textContent).toContain('5 actions')
})

test('scrolling back to the top by hand reveals what was waiting', async () => {
    const { host, state, scroller, tick } = await mount(view([row(1)]))
    scroller.scrollTop = 120
    state.view = view([row(2), row(1)])
    await tick()
    expect(pill(host)).not.toBeNull()
    scroller.scrollTop = 0
    await act(async () => { scroller.dispatchEvent(new Event('scroll', { bubbles: true })) })
    expect(pill(host)).toBeNull()
    expect(sentences(host)).toEqual(['Scout did action 2', 'Scout did action 1'])
})

test('with Reduce motion on, the pill jumps to the top instead of gliding', async () => {
    const { host, state, scroller, scrolls, tick } = await mount(view([row(1)]))
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion'), addEventListener() {}, removeEventListener() {} }))
    scroller.scrollTop = 120
    state.view = view([row(2), row(1)])
    await tick()
    expect(pill(host)!.classList.contains('motion-reduce:animate-none')).toBe(true)
    await act(async () => { pill(host)!.click() })
    expect(scrolls).toEqual([{ top: 0, behavior: 'auto' }])
    expect(ids(host)[0]!.classList.contains('motion-reduce:animate-none')).toBe(true)
})

test('nothing is read while the window is hidden, and it catches up when the window is shown again', async () => {
    const { host, state, requests, tick } = await mount(view([row(1)]))
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    state.view = view([row(2), row(1)])
    await tick(); await tick()
    expect(requests).toHaveLength(1)
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(1) })
    expect(requests).toHaveLength(2)
    expect(sentences(host)).toEqual(['Scout did action 2', 'Scout did action 1'])
})

test('the quiet read keeps the filters, and changing a filter starts the list over with nothing sliding in', async () => {
    const { host, state, requests, scroller, tick } = await mount(view([row(1)]))
    scroller.scrollTop = 200
    state.view = view([row(2), row(1)])
    await tick()
    expect(pill(host)).not.toBeNull()
    const risky = host.querySelector<HTMLInputElement>('input[type=checkbox]')!
    await act(async () => { risky.click(); await vi.advanceTimersByTimeAsync(10) })
    expect(requests.at(-1)).toContain('risky=1')
    expect(pill(host)).toBeNull()
    expect(ids(host).every(node => !node.hasAttribute('data-activity-fresh'))).toBe(true)
    const filtered = requests.at(-1)
    await tick()
    expect(requests.at(-1)).toBe(filtered)
})
