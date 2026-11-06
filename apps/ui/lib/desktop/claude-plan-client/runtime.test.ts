// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDesktopClaudePlanClient } from './runtime'

const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000002'
const snapshot = (attemptId: string | null, revision: string, phase = 'waiting') => ({ status: { connectionId: 'mac-claude', attemptId, revision, phase }, providers: { connections: [], default: null } })
const originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage')
beforeEach(() => {
    const values = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) }, clear: () => values.clear() } })
})
afterEach(() => { vi.unstubAllGlobals(); if (originalStorage) Object.defineProperty(window, 'localStorage', originalStorage); else Reflect.deleteProperty(window, 'localStorage') })
it('restart reads saved state without sending or replaying a sign-in action', async () => {
    window.localStorage.setItem('rerun:claude-login:pending:v1', JSON.stringify({ requestId: A, attemptId: A, expectedRevision: '1', operation: 'complete' }))
    const network = vi.fn(async () => Response.json(snapshot(A, '2', 'checking')))
    vi.stubGlobal('fetch', network)
    await createDesktopClaudePlanClient(vi.fn()).reconcile(null, new AbortController().signal)
    expect(network).toHaveBeenCalledExactlyOnceWith('/api/desktop/claude-login', expect.objectContaining({ cache: 'no-store' }))
    expect(network.mock.calls[0]).not.toContain('POST')
})
it('closing an old attempt cannot discover and cancel a newer attempt', async () => {
    const network = vi.fn(async () => Response.json(snapshot(B, '5')))
    vi.stubGlobal('fetch', network)
    await createDesktopClaudePlanClient(vi.fn()).cancel(A, new AbortController().signal)
    expect(network).toHaveBeenCalledTimes(1)
})
it('cancel of a captured attempt uses its latest checking revision only', async () => {
    const network = vi.fn(async (_url: string, init?: RequestInit) => Response.json(snapshot(A, init?.method === 'POST' ? '3' : '2', init?.method === 'POST' ? 'cancelled' : 'checking')))
    vi.stubGlobal('fetch', network)
    await createDesktopClaudePlanClient(vi.fn()).cancel(A, new AbortController().signal)
    expect(JSON.parse(network.mock.calls[1][1]!.body as string)).toMatchObject({ operation: 'cancel', attemptId: A, expectedRevision: '2' })
})
it('lost completion acknowledgement persists only public identity, never the code, and does not retry', async () => {
    const network = vi.fn(async (_url: string, init?: RequestInit) => { if (init?.method === 'POST') throw new Error('lost response'); return Response.json(snapshot(A, '1')) })
    vi.stubGlobal('fetch', network)
    const runtime = createDesktopClaudePlanClient(vi.fn()), signal = new AbortController().signal
    await runtime.reconcile(null, signal)
    await expect(runtime.submit(A, 'private-code', signal)).rejects.toThrow('lost response')
    expect(window.localStorage.getItem('rerun:claude-login:pending:v1')).not.toContain('private-code')
    expect(network).toHaveBeenCalledTimes(2)
})

it('storage denied by the browser does not prevent passive reconciliation or retry an action', async () => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('Storage disabled') } })
    const network = vi.fn(async () => Response.json(snapshot(A, '2', 'connected')))
    vi.stubGlobal('fetch', network)
    await expect(createDesktopClaudePlanClient(vi.fn()).reconcile(null, new AbortController().signal)).resolves.toMatchObject({ phase: 'connected' })
    expect(network).toHaveBeenCalledTimes(1)
})
