// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { BrowserRunScreenProps } from './BrowserRunScreen'

const state = vi.hoisted(() => ({ props: null as BrowserRunScreenProps | null, scrollRef: { current: null as HTMLElement | null } }))
vi.mock('use-stick-to-bottom', () => ({ useStickToBottomContext: () => ({ scrollRef: state.scrollRef }) }))
vi.mock('./BrowserRunScreen', () => ({ BrowserRunScreen: (props: BrowserRunScreenProps) => { state.props = props; return <div data-testid="screen" /> } }))
import { DesktopBrowserRun } from './DesktopBrowserRun'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const trusted = { agentId: 'agent', sessionId: 'session', runId: 'run-1', liveScreen: { kind: 'browser', site: 'example.com' } }
let root: Root | undefined
let host: HTMLDivElement
const fetcher = vi.fn<typeof fetch>()
const onOpen = vi.fn()
let props: Parameters<typeof DesktopBrowserRun>[0]
const reply = (value: unknown = trusted) => Response.json({ trusted: value })
const visibility = (value: 'hidden' | 'visible') => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetcher)
    fetcher.mockReset().mockImplementation(async () => reply())
    onOpen.mockReset()
    visibility('visible')
    state.props = null
    host = document.body.appendChild(document.createElement('div'))
    state.scrollRef.current = host.appendChild(document.createElement('div'))
    props = { agentId: 'agent', sessionId: 'session', active: true, takeoverPending: false, fullViewerOpen: false, onOpen, fallback: <div data-testid="fallback" /> }
})
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.useRealTimers(); vi.unstubAllGlobals()
})
async function render(change: Partial<typeof props> = {}) {
    props = { ...props, ...change }
    root ??= createRoot(host)
    await act(async () => root!.render(<DesktopBrowserRun {...props} />))
}

test('only the active chat polls and closing it aborts its work without a screen mutation', async () => {
    await render({ active: false })
    expect(fetcher).not.toHaveBeenCalled()
    await render({ active: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(state.props?.trusted).toEqual(trusted)
    expect(state.props?.scroller).toBe(state.scrollRef.current)
    const signal = fetcher.mock.calls[0][1]?.signal
    await render({ active: false })
    expect(signal?.aborted).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-testid="fallback"]')).not.toBeNull()
    await render({ active: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true)
})

test('hidden windows wait for visibility and pending takeover removes the ordinary preview', async () => {
    visibility('hidden')
    await render()
    expect(fetcher).not.toHaveBeenCalled()
    visibility('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await render({ takeoverPending: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-testid="screen"]')).toBeNull()
})

test('a late current-run check cannot open the viewer after the chat closes', async () => {
    await render()
    let resolve!: (response: Response) => void
    fetcher.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r }))
    const opening = state.props!.onOpenFullViewer(trusted).catch(error => error)
    await render({ active: false })
    await act(async () => { resolve(reply()); await opening })
    expect(onOpen).not.toHaveBeenCalled()
})

test('a late read from the old session cannot replace the selected session preview', async () => {
    let resolve!: (response: Response) => void
    fetcher.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r }))
    await render()
    const next = { ...trusted, sessionId: 'next-session', runId: 'next-run' }
    fetcher.mockImplementation(async () => reply(next))
    await render({ sessionId: next.sessionId })
    expect(state.props?.trusted).toEqual(next)
    await act(async () => { resolve(reply()) })
    expect(state.props?.trusted).toEqual(next)
})

test('opening the viewer revalidates the exact run and refuses a replacement', async () => {
    await render()
    await state.props!.onOpenFullViewer(trusted)
    expect(onOpen).toHaveBeenCalledTimes(1)
    fetcher.mockImplementation(async () => reply({ ...trusted, runId: 'next-run' }))
    await expect(state.props!.onOpenFullViewer(trusted)).rejects.toThrow('ended')
    expect(onOpen).toHaveBeenCalledTimes(1)
})
