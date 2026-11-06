// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: { root: Root; host: HTMLElement }[] = []
function render(node: ReactNode) {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    act(() => root.render(node))
    return { rerender: (next: ReactNode) => act(() => root.render(next)) }
}
async function waitFor(check: () => void, rounds = 12) {
    let lastError: unknown
    for (let i = 0; i < rounds; i++) {
        try {
            await act(async () => {})
            check()
            return
        } catch (error) {
            lastError = error
        }
    }
    throw lastError
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRemoteActor, DesktopRemoteSnapshot } from '@rerun/contracts'
import { useRemoteMachines, type RemoteMachinesState } from './use-remote-machines'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const seed = { installId: '11111111-1111-4111-8111-111111111111', workspaceId: 1, launchNonce: '22222222-2222-4222-8222-222222222222' }
const connection = {
    connectionId: '33333333-3333-4333-8333-333333333333',
    revision: '44444444-4444-4444-8444-444444444444',
    workspaceId: 1,
    address: 'https://machine.example',
    identity: { protocolVersion: 1, machineId: '55555555-5555-4555-8555-555555555555', workspaceId: 1 },
    credentialConfigured: true,
    removable: true,
    health: { state: 'connected', checkedAt: '2026-11-06T00:00:00.000Z', commit: 'abc1234', activeAgents: 3, reason: null },
}
const receipt = {
    version: 1,
    receiptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    installId: seed.installId,
    workspaceId: 1,
    kind: 'pair',
    connectionId: connection.connectionId,
    expectedRevision: 'unconfigured',
    revision: connection.revision,
    phase: 'published',
    effectGeneration: 0,
    closeAttempted: true,
    requiresRecovery: false,
    reason: null,
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
}
const empty = (actor: DesktopRemoteActor): DesktopRemoteSnapshot => ({ version: 1, actor, revision: 'unconfigured', connection: null, selected: false, openReceipt: null })
const connected = (actor: DesktopRemoteActor, overrides: Partial<DesktopRemoteSnapshot> = {}): DesktopRemoteSnapshot => ({ version: 1, actor, revision: connection.revision, connection, selected: true, openReceipt: null, ...overrides })

function Probe({ active = true, capture }: { active?: boolean; capture: { current: RemoteMachinesState | null } }) {
    const machines = useRemoteMachines(seed, { active })
    capture.current = machines
    return (
        <div>
            <button onClick={() => void machines.pair('https://machine.example', 'engine-key-1234567890123456')}>pair</button>
            <button onClick={() => void machines.replace(connection.connectionId, connection.revision, 'https://next.example', 'engine-key-1234567890123456')}>replace</button>
            <button onClick={() => void machines.remove(connection.connectionId, connection.revision)}>remove</button>
            <button onClick={() => void machines.select(connection.connectionId, connection.revision)}>select</button>
            <button onClick={() => void machines.retry()}>retry</button>
            <button onClick={() => void machines.settle()}>settle</button>
            <button onClick={() => void machines.recover()}>recover</button>
            <button onClick={() => void machines.cancel()}>cancel</button>
            <button onClick={() => void machines.refresh()}>refresh</button>
            <span data-testid="revision">{machines.snapshot?.revision ?? 'none'}</span>
            <span data-testid="busy">{machines.busy?.kind ?? ''}</span>
            <span data-testid="pending">{machines.pendingRetry ? 'yes' : 'no'}</span>
            <span data-testid="unavailable">{machines.unavailable ? 'yes' : 'no'}</span>
            <span data-testid="error">{machines.error ?? ''}</span>
        </div>
    )
}

type Envelope = Record<string, unknown> & { action: string; actor: DesktopRemoteActor }
function responsesFor(handler: (body: Envelope) => unknown) {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json(handler(JSON.parse(String(init?.body)) as Envelope)))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
}

afterEach(() => {
    for (const { root, host } of roots.splice(0)) {
        act(() => root.unmount())
        host.remove()
    }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('useRemoteMachines', () => {
    it('reads on open and applies the snapshot for the panel actor', async () => {
        const capture: { current: RemoteMachinesState | null } = { current: null }
        responsesFor(body => ({ ok: true, snapshot: connected(body.actor), receipt: null }))
        render(<Probe capture={capture} />)
        await waitFor(() => expect(capture.current?.snapshot?.connection?.address).toBe('https://machine.example'))
        expect(capture.current?.snapshot?.selected).toBe(true)
    })

    it('never fetches while the panel is not active', async () => {
        const capture: { current: RemoteMachinesState | null } = { current: null }
        const fetchMock = responsesFor(body => ({ ok: true, snapshot: connected(body.actor), receipt: null }))
        render(<Probe capture={capture} active={false} />)
        await act(async () => {})
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('pairs on explicit connect and applies the settled snapshot', async () => {
        const capture: { current: RemoteMachinesState | null } = { current: null }
        let paired = false
        responsesFor(body => {
            if (body.action === 'pair') {
                paired = true
                return { ok: true, snapshot: connected(body.actor), receipt }
            }
            return { ok: true, snapshot: paired ? connected(body.actor) : empty(body.actor), receipt: null }
        })
        render(<Probe capture={capture} />)
        await waitFor(() => expect(capture.current?.snapshot?.revision).toBe('unconfigured'))
        act(() => { void capture.current!.pair('https://machine.example', 'engine-key-1234567890123456') })
        await waitFor(() => expect(capture.current?.snapshot?.connection?.address).toBe('https://machine.example'))
        expect(capture.current?.busy).toBeNull()
        expect(capture.current?.pendingRetry).toBeNull()
    })

    it('keeps a lost-ack request identity and retries the exact envelope', async () => {
        const capture: { current: RemoteMachinesState | null } = { current: null }
        let uncertain = true
        const fetchMock = responsesFor(body => {
            if (body.action === 'read') return { ok: true, snapshot: empty(body.actor), receipt: null }
            if (uncertain) return { ok: false, code: 'uncertain', message: 'No acknowledgement.', receipt: null }
            return { ok: true, snapshot: connected(body.actor), receipt }
        })
        render(<Probe capture={capture} />)
        await waitFor(() => expect(capture.current?.snapshot?.revision).toBe('unconfigured'))
        fetchMock.mockClear()
        act(() => { void capture.current!.pair('https://machine.example', 'engine-key-1234567890123456') })
        await waitFor(() => expect(capture.current?.pendingRetry).not.toBeNull())
        const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { requestId: string }
        uncertain = false
        act(() => { void capture.current!.retry() })
        await waitFor(() => expect(capture.current?.pendingRetry).toBeNull())
        const retried = fetchMock.mock.calls
            .map(([, init]) => JSON.parse(String(init?.body)) as { action: string; requestId: string })
            .find((body, index) => body.action === 'pair' && index > 0)
        expect(retried).toBeTruthy()
        expect(retried!.requestId).toBe(first.requestId)
    })

    it('drops a read whose actor belongs to another renderer epoch', async () => {
        const capture: { current: RemoteMachinesState | null } = { current: null }
        responsesFor(body => ({ ok: true, snapshot: connected({ ...body.actor, rendererEpoch: '99999999-9999-4999-8999-999999999999' }), receipt: null }))
        render(<Probe capture={capture} />)
        await act(async () => {})
        expect(capture.current?.snapshot).toBeNull()
    })

    it('reports authority_missing as unavailable and stops', async () => {
        const capture: { current: RemoteMachinesState | null } = { current: null }
        responsesFor(() => ({ ok: false, code: 'authority_missing', message: 'This remote-machine capability is not connected to the desktop lifecycle.', receipt: null }))
        render(<Probe capture={capture} />)
        await waitFor(() => expect(capture.current?.unavailable).toBe(true))
        expect(capture.current?.error).toContain('not connected')
    })

    it('removes against the exact connection revision', async () => {
        const capture: { current: RemoteMachinesState | null } = { current: null }
        let removed = false
        const fetchMock = responsesFor(body => {
            if (body.action === 'remove') {
                removed = true
                return { ok: true, snapshot: empty(body.actor), receipt: { ...receipt, kind: 'remove' } }
            }
            return { ok: true, snapshot: removed ? empty(body.actor) : connected(body.actor), receipt: null }
        })
        render(<Probe capture={capture} />)
        await waitFor(() => expect(capture.current?.snapshot?.connection).toBeTruthy())
        fetchMock.mockClear()
        act(() => { void capture.current!.remove(connection.connectionId, connection.revision) })
        await waitFor(() => expect(capture.current?.snapshot?.revision).toBe('unconfigured'))
        const removeCall = fetchMock.mock.calls.find(([, init]) => (JSON.parse(String(init?.body)) as { action: string }).action === 'remove')
        expect(removeCall).toBeTruthy()
        expect(JSON.parse(String(removeCall![1]?.body))).toMatchObject({ action: 'remove', connectionId: connection.connectionId, expectedRevision: connection.revision, confirmation: 'Remove' })
    })

    it('surfaces an open recovery receipt and recovers it', async () => {
        const capture: { current: RemoteMachinesState | null } = { current: null }
        const fetchMock = responsesFor(body => {
            if (body.action === 'recover') return { ok: true, snapshot: connected(body.actor), receipt: { ...receipt, requiresRecovery: false } }
            return { ok: true, snapshot: connected(body.actor, { openReceipt: { ...receipt, requiresRecovery: true, phase: 'failed_after_drain' } }), receipt: null }
        })
        render(<Probe capture={capture} />)
        await waitFor(() => expect(capture.current?.snapshot?.openReceipt?.requiresRecovery).toBe(true))
        fetchMock.mockClear()
        act(() => { void capture.current!.recover() })
        await waitFor(() => expect(capture.current?.busy).toBeNull())
        const recoverCall = fetchMock.mock.calls.find(([, init]) => (JSON.parse(String(init?.body)) as { action: string }).action === 'recover')
        expect(recoverCall).toBeTruthy()
    })
})
