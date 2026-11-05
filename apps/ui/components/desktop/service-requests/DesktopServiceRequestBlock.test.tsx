// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopServiceRequestMutation } from '@rerun/contracts'
import type { DesktopOpenApps } from '@/lib/desktop/service-requests-client'
import { DesktopServiceRequestBlock, type DesktopServiceRequestBlockProps } from './DesktopServiceRequestBlock'
import { cardRevision, finishFixtureResponse, installationRevision, nextCardRevision, scope, serviceRequestFixture } from './service-request-fixtures'

// These component cases isolate the card interaction. Durable endpoint recovery is
// exercised separately by service-requests-client and server retry-store cases.
const retryEntries = vi.hoisted(() => new Map<string, string>())
vi.mock('@/lib/desktop/service-requests-client', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/desktop/service-requests-client')>()
    return { ...actual, createDesktopServiceRequestsClient: (owner: Parameters<typeof actual.createDesktopServiceRequestsClient>[0]) => actual.createDesktopServiceRequestsClient(owner, {
        getItem: (key: string) => retryEntries.get(key) ?? null,
        setItem: (key: string, value: string) => { retryEntries.set(key, value) },
        removeItem: (key: string) => { retryEntries.delete(key) },
    }) }
})

vi.mock('@rerun/ui', () => ({ BorderBeam: () => null }))
vi.mock('motion/react', async () => {
    const { createElement } = await import('react')
    return { AnimatePresence: ({ children }: { children: ReactNode }) => children,
        motion: { div: ({ children, className }: { children: ReactNode; className: string }) => createElement('div', { className }, children) } }
})

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { await act(async () => root?.unmount()); document.body.innerHTML = ''; retryEntries.clear(); vi.unstubAllGlobals() })

function button(label: string) {
    return [...document.querySelectorAll('button')].find(item => item.textContent === label)!
}
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
async function mount(overrides: Partial<DesktopServiceRequestBlockProps> = {}) {
    const onOpenApps = vi.fn<DesktopOpenApps>(async () => ({ status: 'closed' }))
    const onAccepted = vi.fn<DesktopServiceRequestBlockProps['onAccepted']>(async input => { await input.response.body?.cancel() })
    const props = { agentId: scope.agentId, sessionId: scope.sessionId, request: serviceRequestFixture(), onOpenApps, onAccepted, ...overrides }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopServiceRequestBlock {...props} />))
    await flush()
    return { props, onOpenApps, onAccepted }
}

test('returning from Apps refreshes authoritative health but never saves progress or sends a reply', async () => {
    let detail = serviceRequestFixture()
    const fetcher = vi.fn(async () => Response.json({ request: detail }))
    vi.stubGlobal('fetch', fetcher)
    const { onOpenApps, onAccepted } = await mount()
    expect(button('Finish').disabled).toBe(true)
    detail = serviceRequestFixture(true)
    await act(async () => button('Connect').click())
    await flush()
    expect(onOpenApps).toHaveBeenCalledExactlyOnceWith({ agentId: scope.agentId, slug: 'fixture', serviceRequestId: scope.serviceRequestId,
        sourceFingerprint: scope.source.fingerprint, signal: expect.any(AbortSignal) })
    expect(fetcher.mock.calls).toHaveLength(2)
    expect(button('Finish').disabled).toBe(false)
    expect(onAccepted).not.toHaveBeenCalled()
})

test('Cancel aborts only its Apps flow, preserves pending choices and never answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ request: serviceRequestFixture() })))
    let signal!: AbortSignal
    const open: DesktopOpenApps = input => new Promise((_, reject) => {
        signal = input.signal
        signal.addEventListener('abort', () => reject(new DOMException('Closed', 'AbortError')), { once: true })
    })
    const { onAccepted } = await mount({ onOpenApps: open })
    await act(async () => button('Connect').click())
    expect(button('Cancel').disabled).toBe(false)
    await act(async () => button('Cancel').click())
    await flush()
    expect(signal.aborted).toBe(true)
    expect(button('Finish').disabled).toBe(true)
    expect(onAccepted).not.toHaveBeenCalled()
    expect(retryEntries.size).toBe(0)
})

test('Finish first acknowledges exact installation progress and then sends once with the new card revision', async () => {
    let detail = serviceRequestFixture(true)
    const sent: DesktopServiceRequestMutation[] = []
    let acknowledge!: () => void
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === 'GET') return Response.json({ request: detail })
        const input = JSON.parse(String(init.body)) as DesktopServiceRequestMutation
        sent.push(input)
        if (input.action === 'progress') {
            await new Promise<void>(resolve => { acknowledge = resolve })
            detail = { ...detail, choices: input.choices, revision: nextCardRevision }
            return Response.json({ serviceRequestId: scope.serviceRequestId, revision: nextCardRevision, currentIndex: 0, choices: input.choices })
        }
        return finishFixtureResponse(input.requestId)
    }))
    const { onAccepted } = await mount()
    await act(async () => { button('Finish').click(); button('Finish').click() })
    expect(sent).toHaveLength(1)
    expect(sent[0].action).toBe('progress')
    expect(sent[0].expectedRevision).toBe(cardRevision)
    expect(sent[0].choices).toEqual([{ slug: 'fixture', choice: 'use-connection', installation: { key: 'fixture', revision: installationRevision } }])
    expect(onAccepted).not.toHaveBeenCalled()
    await act(async () => acknowledge())
    await flush()
    expect(sent).toHaveLength(2)
    expect(sent[1].action).toBe('finish')
    expect(sent[1].expectedRevision).toBe(nextCardRevision)
    expect(sent[1].choices).toEqual(sent[0].choices)
    expect(onAccepted).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('App setup result sent.')
})

test('unknown progress remounts with the exact choices and retry UUID; mount never replays it', async () => {
    const sent: DesktopServiceRequestMutation[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === 'GET') return Response.json({ request: serviceRequestFixture() })
        sent.push(JSON.parse(String(init.body)))
        throw new Error('Lost acknowledgement')
    }))
    const first = await mount()
    await act(async () => button('Not now').click())
    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].choices).toEqual([{ slug: 'fixture', choice: 'skip' }])
    await act(async () => root!.unmount())
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopServiceRequestBlock {...first.props} />))
    await flush()
    expect(sent).toHaveLength(1)
    expect(document.body.textContent).toContain('fixture: Skipped')
    await act(async () => button('Retry progress').click())
    await flush()
    expect(sent[1]).toEqual(sent[0])
    expect(first.onAccepted).not.toHaveBeenCalled()
})

test('owner/source replacement aborts the matching Apps flow and ignores its late close', async () => {
    let release!: () => void
    let oldSignal!: AbortSignal
    const fetcher = vi.fn(async () => Response.json({ request: serviceRequestFixture() }))
    vi.stubGlobal('fetch', fetcher)
    const open: DesktopOpenApps = input => new Promise(resolve => { oldSignal = input.signal; release = () => resolve({ status: 'closed' }) })
    const first = await mount({ onOpenApps: open })
    await act(async () => button('Connect').click())
    await act(async () => root!.render(<DesktopServiceRequestBlock {...first.props} agentId="other-owner" disabled />))
    expect(oldSignal.aborted).toBe(true)
    const reads = fetcher.mock.calls.length
    await act(async () => release())
    expect(fetcher.mock.calls).toHaveLength(reads)
    expect(first.onAccepted).not.toHaveBeenCalled()
})
