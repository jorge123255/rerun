// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionSummary } from '@rerun/contracts'
import { buildDesktopModelView, usableConnection } from '../chat-model'
import { createDesktopClaudePlanClient } from './runtime'

const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000002'
const id = 'mac-claude', model = 'claude-opus-5-5', signal = () => new AbortController().signal
const pick = { connectionId: id, model }
const connection = (connected: boolean, credentialRejected = false): ConnectionSummary => ({ id, name: 'Claude', provider: 'claude', models: [model], extraModels: [], connected, credentialRejected, createdAt: '2026-11-09T00:00:00.000Z', planLimits: null })
const originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage')
afterEach(() => { vi.unstubAllGlobals(); if (originalStorage) Object.defineProperty(window, 'localStorage', originalStorage); else Reflect.deleteProperty(window, 'localStorage') })

it('sign-in response enables the saved selection, reload reads only, and rejected credential disables replies without changing the selection', async () => {
    const journal = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (key: string) => journal.get(key) ?? null, setItem: (key: string, value: string) => journal.set(key, value), removeItem: (key: string) => journal.delete(key) } })
    const snapshots = [
        { connectionId: id, attemptId: null, revision: '0', phase: 'idle' },
        { connectionId: id, attemptId: A, revision: '1', phase: 'waiting' },
        { connectionId: id, attemptId: null, revision: '3', phase: 'connected', credentialRevision: '1' },
    ]
    let status = snapshots[0], currentConnection = connection(false)
    const network = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            const input = JSON.parse(String(init.body))
            status = snapshots[input.operation === 'start' ? 1 : 2]
            if (input.operation === 'complete') currentConnection = connection(true)
        }
        return Response.json({ status, providers: { connections: [currentConnection], default: null } })
    })
    vi.stubGlobal('fetch', network)
    let providers: ConnectionSummary[] = []
    const receive = (value: { connections: ConnectionSummary[] }) => { providers = value.connections }
    let client = createDesktopClaudePlanClient(receive)
    const view = () => buildDesktopModelView({ connections: providers, workspace: null, coworker: null, conversation: pick })
    await client.reconcile(null, signal())
    expect(view().effective.available).toBe(false)
    await client.start(null, signal())
    expect(view().effective.available).toBe(false)
    await client.submit(A, 'synthetic-code', signal())
    expect(view().effective.available).toBe(true)
    expect(providers.map(item => item.id)).toEqual([id])
    expect([...journal.values()].join('')).not.toContain('synthetic-code')
    const before = network.mock.calls.length
    client = createDesktopClaudePlanClient(receive)
    await client.reconcile(null, signal())
    expect(network.mock.calls.slice(before).every(([, init]) => init?.method !== 'POST')).toBe(true)
    expect(view().effective.available).toBe(true)
    currentConnection = connection(true, true)
    await client.reconcile(null, signal())
    expect(view().effective).toMatchObject({ available: false, connectionId: id, model })
    expect(usableConnection(providers, pick)).toBeNull()
})

it('stale completion and closing an old reconnect cannot act on the replacement attempt', async () => {
    const network = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ status: { connectionId: id, attemptId: B, revision: '8', phase: 'connected', credentialRevision: '1', pendingAttempt: { attemptId: B, phase: 'waiting' } }, providers: { connections: [connection(true)], default: null } }))
    vi.stubGlobal('fetch', network)
    const client = createDesktopClaudePlanClient(vi.fn())
    await client.reconcile(null, signal())
    await expect(client.submit(A, 'synthetic-old-code', signal())).rejects.toThrow(/changed/)
    await client.cancel(A, signal())
    expect(network.mock.calls.every(([url, init]) => url === '/api/desktop/claude-login' && init?.method !== 'POST')).toBe(true)
})
