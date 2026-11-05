import { afterEach, describe, expect, test, vi } from 'vitest'

import { createBrowserRunObserver, isAcceptableSocketUrl, parseTrustedCurrentRun, projectBrowserRunScreen, projectSavedRun, sanitizeSite, type BrowserRunScreenState, type CurrentRunCheckResult } from './browser-run'

const run = { agentId: 'ada', sessionId: 's1', runId: 'r1' }
const trusted = { ...run, liveScreen: { kind: 'browser' as const, site: 'example.com' } }
const conversation = { agentId: 'ada', sessionId: 's1', active: true, selected: true, visible: true }
const ticket = () => ({ socketUrl: 'ws://127.0.0.1:4100/desktop/isolated-viewer-ws?ticket=t1', expiresAt: new Date(Date.now() + 60_000).toISOString() })
const running: CurrentRunCheckResult = { current: true, screen: 'running', site: 'example.com' }

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

function observe(check = vi.fn(async () => running), requestWatchTicket = vi.fn(async () => ticket())) {
    const states: BrowserRunScreenState[] = []
    const observer = createBrowserRunObserver({ run, check, transport: { requestWatchTicket }, onState: s => states.push(s) })
    return { observer, states, check, requestWatchTicket }
}

afterEach(() => vi.useRealTimers())

describe('trusted identity', () => {
    test('parses only the exact projection shape', () => {
        expect(parseTrustedCurrentRun(trusted)).toEqual(trusted)
        expect(parseTrustedCurrentRun({ ...trusted, engineAgentId: 'e' })).toBeNull()
        expect(parseTrustedCurrentRun({ ...trusted, runId: '../x' })).toBeNull()
        expect(parseTrustedCurrentRun({ agentId: 'ada', sessionId: 's1', liveScreen: null })).toBeNull()
        expect(parseTrustedCurrentRun({ ...trusted, liveScreen: { kind: 'tool-guess', site: null } })).toBeNull()
        expect(parseTrustedCurrentRun({ ...trusted, liveScreen: { kind: 'browser', site: 'https://u:p@shop.example.com/cart?token=1' } })?.liveScreen?.site).toBe('shop.example.com')
    })
    test('site badge keeps a host name only', () => {
        expect(sanitizeSite('https://www.example.com/path?q=1')).toBe('example.com')
        expect(sanitizeSite('javascript:alert(1)')).toBeNull()
        expect(sanitizeSite('')).toBeNull()
    })
    test('socket URLs must be ws(s) without credentials', () => {
        expect(isAcceptableSocketUrl('ws://127.0.0.1/x')).toBe(true)
        expect(isAcceptableSocketUrl('https://127.0.0.1/x')).toBe(false)
        expect(isAcceptableSocketUrl('ws://u:p@127.0.0.1/x')).toBe(false)
    })
})

describe('projection', () => {
    const p = (over: Partial<Parameters<typeof projectBrowserRunScreen>[0]> = {}) => projectBrowserRunScreen({ trusted, conversation, takeoverPending: false, ...over })
    test('current run with real screen work is eligible', () => expect(p()).toEqual({ eligible: true, run, site: 'example.com' }))
    test('no trusted run, no screen, wrong owner or session fail closed', () => {
        expect(p({ trusted: null })).toMatchObject({ eligible: false, reason: 'no-run' })
        expect(p({ trusted: { ...trusted, liveScreen: null } })).toMatchObject({ reason: 'no-screen' })
        expect(p({ trusted: { ...trusted, agentId: 'bea' } })).toMatchObject({ reason: 'mismatch' })
        expect(p({ trusted: { ...trusted, sessionId: 's2' } })).toMatchObject({ reason: 'mismatch' })
    })
    test('selection alone never establishes liveness; inactive, unselected and hidden do not view', () => {
        expect(p({ trusted: null, conversation: { ...conversation, selected: true } }).eligible).toBe(false)
        expect(p({ conversation: { ...conversation, active: false } })).toMatchObject({ reason: 'inactive' })
        expect(p({ conversation: { ...conversation, selected: false } })).toMatchObject({ reason: 'not-selected' })
        expect(p({ conversation: { ...conversation, visible: false } })).toMatchObject({ reason: 'hidden' })
    })
    test('a pending takeover owns the screen; no duplicate card', () => expect(p({ takeoverPending: true })).toMatchObject({ reason: 'takeover-pending' }))
    test('saved runs stay historical unless they are the exact trusted current run', () => {
        expect(projectSavedRun('r1', trusted, conversation)).toBe('current')
        expect(projectSavedRun('r0', trusted, conversation)).toBe('historical')
        expect(projectSavedRun('r1', null, conversation)).toBe('historical')
        expect(projectSavedRun('r1', { ...trusted, liveScreen: null }, conversation)).toBe('historical')
        expect(projectSavedRun('r1', trusted, { agentId: 'bea', sessionId: 's1' })).toBe('historical')
    })
})

describe('observer', () => {
    test('validates before requesting a watch ticket, then confirms again', async () => {
        const { observer, states, check, requestWatchTicket } = observe()
        await observer.start()
        expect(check).toHaveBeenCalledTimes(2)
        expect(check.mock.invocationCallOrder[0]).toBeLessThan(requestWatchTicket.mock.invocationCallOrder[0])
        expect(requestWatchTicket).toHaveBeenCalledWith(run, expect.any(AbortSignal))
        expect(states.at(-1)).toMatchObject({ status: 'live', site: 'example.com' })
    })
    test('stale run or stopped guest never requests a ticket (passive does not start a runtime)', async () => {
        for (const result of [{ current: false }, { current: true, screen: 'stopped' }] as CurrentRunCheckResult[]) {
            const { observer, states, requestWatchTicket } = observe(vi.fn(async () => result))
            await observer.start()
            expect(requestWatchTicket).not.toHaveBeenCalled()
            expect(states.at(-1)).toEqual({ status: 'stopped' })
        }
        const { observer, states, requestWatchTicket } = observe(vi.fn(async () => ({ current: true, screen: 'unavailable' }) as CurrentRunCheckResult))
        await observer.start()
        expect(requestWatchTicket).not.toHaveBeenCalled()
        expect(states.at(-1)).toMatchObject({ status: 'unavailable' })
    })
    test('run ends while ticket is issued: never shows live', async () => {
        const check = vi.fn<() => Promise<CurrentRunCheckResult>>().mockResolvedValueOnce(running).mockResolvedValueOnce({ current: false })
        const { observer, states } = observe(check)
        await observer.start()
        expect(states.some(s => s.status === 'live')).toBe(false)
        expect(states.at(-1)).toEqual({ status: 'stopped' })
    })
    test('transport errors reduce to fixed text without the ticket URL', async () => {
        const { observer, states } = observe(undefined, vi.fn(async () => { throw new Error('ws://secret?ticket=leak') }))
        await observer.start()
        expect(JSON.stringify(states)).not.toContain('leak')
        expect(states.at(-1)).toEqual({ status: 'unavailable', reason: 'The screen is not available' })
    })
    test('expired or malformed tickets are unavailable', async () => {
        const { observer, states } = observe(undefined, vi.fn(async () => ({ socketUrl: 'ws://x/y', expiresAt: new Date(0).toISOString() })))
        await observer.start()
        expect(states.at(-1)?.status).toBe('unavailable')
    })
    test('dispose ignores late replies and aborts in-flight work', async () => {
        const pending = deferred<{ socketUrl: string; expiresAt: string }>()
        let seen: AbortSignal | undefined
        const { observer, states } = observe(undefined, vi.fn((_r, signal: AbortSignal) => { seen = signal; return pending.promise }))
        const started = observer.start()
        await vi.waitFor(() => expect(seen).toBeDefined())
        observer.dispose()
        expect(seen!.aborted).toBe(true)
        pending.resolve(ticket())
        await started
        expect(states.some(s => s.status === 'live')).toBe(false)
    })
    test('an obsolete attempt cannot overwrite a newer view', async () => {
        const first = deferred<{ socketUrl: string; expiresAt: string }>()
        const requestWatchTicket = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ...ticket(), socketUrl: 'ws://127.0.0.1/new' })
        const { observer, states } = observe(undefined, requestWatchTicket)
        const a = observer.start()
        await vi.waitFor(() => expect(requestWatchTicket).toHaveBeenCalledTimes(1))
        await observer.retry()
        first.resolve({ ...ticket(), socketUrl: 'ws://127.0.0.1/old' })
        await a
        expect(states.at(-1)).toMatchObject({ status: 'live', socketUrl: 'ws://127.0.0.1/new' })
        expect(states.some(s => s.status === 'live' && s.socketUrl.endsWith('/old'))).toBe(false)
    })
    test('disconnect is honest, never auto-reconnects, and Retry revalidates', async () => {
        const { observer, states, check, requestWatchTicket } = observe()
        await observer.start()
        const url = (observer.state as { socketUrl: string }).socketUrl
        observer.disconnected('ws://other')
        expect(observer.state.status).toBe('live')
        observer.disconnected(url)
        expect(states.at(-1)).toMatchObject({ status: 'disconnected' })
        expect(requestWatchTicket).toHaveBeenCalledTimes(1)
        await observer.retry()
        expect(check).toHaveBeenCalledTimes(4)
        expect(requestWatchTicket).toHaveBeenCalledTimes(2)
    })
    test('a socket that never paints is bounded to disconnected, not a frozen live card', async () => {
        vi.useFakeTimers()
        const states: BrowserRunScreenState[] = []
        const observer = createBrowserRunObserver({ run, check: async () => running, transport: { requestWatchTicket: async () => ticket() }, onState: s => states.push(s), limits: { connectMs: 1000 } })
        await observer.start()
        await vi.advanceTimersByTimeAsync(1001)
        expect(states.at(-1)).toMatchObject({ status: 'disconnected', reason: 'The screen did not connect' })
    })
    test('connected clears the watchdog', async () => {
        vi.useFakeTimers()
        const observer = createBrowserRunObserver({ run, check: async () => running, transport: { requestWatchTicket: async () => ticket() }, onState: () => {}, limits: { connectMs: 1000 } })
        await observer.start()
        observer.connected((observer.state as { socketUrl: string }).socketUrl)
        await vi.advanceTimersByTimeAsync(5000)
        expect(observer.state.status).toBe('live')
    })
    test('a hung check is bounded by the setup limit', async () => {
        vi.useFakeTimers()
        const observer = createBrowserRunObserver({ run, check: (_r, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))), transport: { requestWatchTicket: async () => ticket() }, onState: () => {}, limits: { setupMs: 500, checkMs: 500 } })
        const started = observer.start()
        await vi.advanceTimersByTimeAsync(600)
        await started
        expect(observer.state.status).toBe('unavailable')
    })
    test('the observer has no stop, release or control surface', () => {
        const { observer } = observe()
        expect(Object.keys(observer).sort()).toEqual(['connected', 'disconnected', 'dispose', 'generation', 'retry', 'start', 'state'])
    })
})
