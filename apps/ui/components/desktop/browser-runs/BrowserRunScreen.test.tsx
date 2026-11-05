// @vitest-environment happy-dom
import { act, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { CurrentRunCheckResult, TrustedCurrentRun } from '@/lib/desktop/browser-run'

import { BrowserRunScreen, type BrowserRunScreenProps } from './BrowserRunScreen'

const seen = vi.hoisted(() => ({ value: true }))
const mirrors = vi.hoisted(() => ({ sources: [] as unknown[] }))
vi.mock('motion/react', () => ({ AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@/hooks/useSeenInThread', () => ({ useSeenInThread: () => seen.value }))
vi.mock('@/components/desktop/DesktopViewer', () => ({ DesktopViewer: () => null }))
vi.mock('@/components/desktop/DesktopScreenLoader', () => ({ DesktopScreenLoader: () => <div data-testid="loader" /> }))
vi.mock('@/components/desktop/ScreenMirror', () => ({ ScreenMirror: ({ source }: { source: unknown }) => { mirrors.sources.push(source); return <div data-testid="mirror" /> } }))
vi.mock('@/components/desktop/FloatingScreen', () => ({ FloatingScreen: ({ children, onTakeControl, takeControlLabel }: { children: ReactNode; onTakeControl: () => void; takeControlLabel: string }) => <div data-testid="floating"><button onClick={onTakeControl}>{`float:${takeControlLabel}`}</button>{children}</div> }))
vi.mock('@/components/desktop/ScreenCard', () => ({
    ScreenCard: ({ live, site, screen, onTakeControl }: { live: boolean; site: string | null; screen: ReactNode; onTakeControl: () => void }) => (
        <div data-testid="card" data-live={String(live)} data-site={site ?? ''}>{screen}{live && <button onClick={onTakeControl}>Take control</button>}</div>
    ),
}))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Viewer = { socketUrl: string; viewOnly: boolean; onDisconnect: () => void; onCanvas: (c: HTMLCanvasElement | null) => void }
const viewers: { mounted: Viewer[]; unmounted: string[] } = { mounted: [], unmounted: [] }
function FakeViewer(props: Viewer) {
    useEffect(() => {
        viewers.mounted.push(props)
        return () => { viewers.unmounted.push(props.socketUrl) }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return <div data-testid="viewer" data-view-only={String(props.viewOnly)} />
}

const trusted: TrustedCurrentRun = { agentId: 'ada', sessionId: 's1', runId: 'r1', liveScreen: { kind: 'browser', site: 'example.com' } }
const running: CurrentRunCheckResult = { current: true, screen: 'running', site: 'example.com' }
let root: Root | undefined
let host: HTMLDivElement
let floatingHost: HTMLDivElement
let ticketCount = 0
let props: BrowserRunScreenProps

beforeEach(() => {
    ticketCount = 0
    viewers.mounted = []; viewers.unmounted = []; mirrors.sources = []; seen.value = true
    host = document.body.appendChild(document.createElement('div'))
    floatingHost = document.body.appendChild(document.createElement('div'))
    props = {
        trusted, agentId: 'ada', sessionId: 's1', active: true, selected: true, takeoverPending: false, fullViewerOpen: false,
        checkCurrentRun: vi.fn(async () => running),
        transport: { requestWatchTicket: vi.fn(async () => ({ socketUrl: `ws://127.0.0.1/v?ticket=${++ticketCount}`, expiresAt: new Date(Date.now() + 60_000).toISOString() })) },
        onOpenFullViewer: vi.fn(async () => {}),
        scroller: document.body, floatingHost, fallback: <div data-testid="fallback">activity</div>, Viewer: FakeViewer,
    }
})
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.restoreAllMocks() })

async function render(over: Partial<BrowserRunScreenProps> = {}) {
    props = { ...props, ...over }
    root ??= createRoot(host)
    await act(async () => root!.render(<BrowserRunScreen {...props} />))
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`)

test('current run with real screen work shows a passive view-only card with the site badge', async () => {
    await render()
    expect(q('card')?.getAttribute('data-live')).toBe('true')
    expect(q('card')?.getAttribute('data-site')).toBe('example.com')
    expect(viewers.mounted).toHaveLength(1)
    expect(viewers.mounted[0].viewOnly).toBe(true)
})

test('no trusted screen, historical run or wrong owner keeps the activity fallback and never asks for a view', async () => {
    for (const trustedRun of [null, { ...trusted, liveScreen: null }, { ...trusted, agentId: 'bea' }, { ...trusted, sessionId: 's2' }]) {
        await render({ trusted: trustedRun })
        expect(q('fallback')).not.toBeNull()
    }
    expect(props.checkCurrentRun).not.toHaveBeenCalled()
    expect(props.transport.requestWatchTicket).not.toHaveBeenCalled()
})

test('inactive tab, unselected coworker and hidden window hold no viewer; return revalidates freshly', async () => {
    await render()
    expect(viewers.mounted).toHaveLength(1)
    await render({ active: false })
    expect(viewers.unmounted).toHaveLength(1)
    expect(q('fallback')).not.toBeNull()
    await render({ active: true })
    expect(props.checkCurrentRun).toHaveBeenCalledTimes(4)
    expect(props.transport.requestWatchTicket).toHaveBeenCalledTimes(2)
    expect(viewers.mounted[1].socketUrl).not.toBe(viewers.mounted[0].socketUrl)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(viewers.unmounted).toHaveLength(2)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(props.transport.requestWatchTicket).toHaveBeenCalledTimes(3)
})

test('a run change remounts a fresh observer; Stop (trusted null) releases only this viewer', async () => {
    await render()
    await render({ trusted: { ...trusted, runId: 'r2' } })
    expect(viewers.unmounted).toEqual([viewers.mounted[0].socketUrl])
    expect(props.transport.requestWatchTicket).toHaveBeenLastCalledWith({ agentId: 'ada', sessionId: 's1', runId: 'r2' }, expect.any(AbortSignal))
    await render({ trusted: null })
    expect(viewers.unmounted).toHaveLength(2)
    expect(q('fallback')).not.toBeNull()
})

test('a late ticket after unmount is dropped', async () => {
    let resolve!: (t: { socketUrl: string; expiresAt: string }) => void
    await render({ transport: { requestWatchTicket: vi.fn(() => new Promise<{ socketUrl: string; expiresAt: string }>(r => { resolve = r })) } })
    await act(async () => root!.unmount()); root = undefined
    resolve({ socketUrl: 'ws://127.0.0.1/late', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(viewers.mounted).toHaveLength(0)
})

test('the screen state check reporting a stopped guest shows the fallback and requests no ticket', async () => {
    await render({ checkCurrentRun: vi.fn(async () => ({ current: true, screen: 'stopped' }) as CurrentRunCheckResult) })
    expect(q('fallback')).not.toBeNull()
    expect(props.transport.requestWatchTicket).not.toHaveBeenCalled()
})

test('disconnect shows an honest state with Retry that revalidates before a new view', async () => {
    await render()
    await act(async () => viewers.mounted[0].onDisconnect())
    expect(document.body.textContent).toContain('The screen went away')
    expect(q('viewer')).toBeNull()
    const retry = [...document.querySelectorAll('button')].find(b => b.textContent === 'Try again')!
    await act(async () => retry.click())
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(props.checkCurrentRun).toHaveBeenCalledTimes(4)
    expect(viewers.mounted).toHaveLength(2)
})

test('explicit Open calls the acknowledged callback with the exact run; rejection stays visible and retryable', async () => {
    const onOpenFullViewer = vi.fn().mockRejectedValueOnce(new Error('ws://leak')).mockResolvedValueOnce(undefined)
    await render({ onOpenFullViewer })
    const take = () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Take control')!
    await act(async () => take().click())
    expect(onOpenFullViewer).toHaveBeenCalledWith({ agentId: 'ada', sessionId: 's1', runId: 'r1' })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('The browser could not be opened.')
    expect(document.body.textContent).not.toContain('leak')
    const again = [...document.querySelectorAll('[role="alert"] button')][0] as HTMLButtonElement
    await act(async () => again.click())
    expect(onOpenFullViewer).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[role="alert"]')).toBeNull()
})

test('a pending takeover suppresses this card so the takeover card owns the controls', async () => {
    await render({ takeoverPending: true })
    expect(q('fallback')).not.toBeNull()
    expect(props.transport.requestWatchTicket).not.toHaveBeenCalled()
})

test('floating mirror copies the existing canvas, opens no second connection and hides while the full viewer is open', async () => {
    seen.value = false
    await render()
    expect(q('floating')).not.toBeNull()
    const canvas = document.createElement('canvas')
    await act(async () => viewers.mounted[0].onCanvas(canvas))
    expect(mirrors.sources.at(-1)).toBe(canvas)
    expect(viewers.mounted).toHaveLength(1)
    expect(props.transport.requestWatchTicket).toHaveBeenCalledTimes(1)
    await render({ fullViewerOpen: true })
    expect(q('floating')).toBeNull()
    await render({ trusted: null })
    expect(floatingHost.childElementCount).toBe(0)
})

test('restart: a fresh mount for the same current run validates again and never reuses a ticket', async () => {
    await render()
    const first = viewers.mounted[0].socketUrl
    await act(async () => root!.unmount()); root = undefined
    await render()
    expect(viewers.mounted.at(-1)!.socketUrl).not.toBe(first)
    expect(props.checkCurrentRun).toHaveBeenCalledTimes(4)
})

test('restart with the screen gone shows unavailable with Retry, not a frozen live card', async () => {
    await render({ checkCurrentRun: vi.fn(async () => ({ current: true, screen: 'unavailable' }) as CurrentRunCheckResult) })
    expect(q('card')?.getAttribute('data-live')).toBe('false')
    expect(document.body.textContent).toContain('The screen is not available')
    expect(q('viewer')).toBeNull()
})
