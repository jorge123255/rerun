// @vitest-environment happy-dom
import { act, StrictMode, useLayoutEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRemoteActor, DesktopRemoteCommand, DesktopRemoteMachineBridge, DesktopRemoteReceipt, DesktopRemoteSnapshot } from '@rerun/contracts'
import { useRemoteMachines, type RemoteMachinesState } from './use-remote-machines'
import { remoteActor as seed, remoteConnection as connection, remoteReceipt as receipt, emptyRemoteSnapshot as empty, connectedRemoteSnapshot as connected } from './remote-machines.test-support'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: { root: Root; host: HTMLElement }[] = []
function render(node: ReactNode) {
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host); roots.push({ root, host }); act(() => root.render(node))
    return { rerender: (next: ReactNode) => act(() => root.render(next)) }
}
async function waitFor(check: () => void, rounds = 20) {
    let lastError: unknown
    for (let i = 0; i < rounds; i++) {
        try { await act(async () => {}); check(); return } catch (error) { lastError = error }
    }
    throw lastError
}
function Probe({ active = true, actor = seed, capture, bridge }: { active?: boolean; actor?: DesktopRemoteActor; capture: { current: RemoteMachinesState | null }; bridge?: DesktopRemoteMachineBridge }) {
    const machines = useRemoteMachines(actor, { active, bridge })
    useLayoutEffect(() => { capture.current = machines })
    return <span>{machines.snapshot?.revision ?? 'none'}</span>
}
function effectResult(command: DesktopRemoteCommand, snapshot: DesktopRemoteSnapshot) {
    const effect: DesktopRemoteReceipt = { ...receipt, requestId: command.requestId,
        ...('connectionId' in command ? { connectionId: command.connectionId, expectedRevision: command.expectedRevision } : {}),
        ...(['pair', 'replace', 'select', 'remove', 'health'].includes(command.action) ? { kind: command.action as DesktopRemoteReceipt['kind'] } : {}) }
    const next = snapshot.connection && 'connectionId' in command ? { ...snapshot.connection, connectionId: command.connectionId } : snapshot.connection
    return { ok: true, snapshot: { ...snapshot, connection: next, activeReceipt: snapshot.selected ? effect : null }, receipt: effect }
}
function responsesFor(handler: (body: DesktopRemoteCommand) => unknown) {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json(handler(JSON.parse(String(init?.body)) as DesktopRemoteCommand)))
    vi.stubGlobal('fetch', fetchMock); return fetchMock
}
afterEach(() => { for (const { root, host } of roots.splice(0)) { act(() => root.unmount()); host.remove() }; vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('useRemoteMachines', () => {
    it('reads on open with the native actor but never probes health or connects', async () => {
        const capture = { current: null as RemoteMachinesState | null }
        const fetchMock = responsesFor(body => ({ ok: true, snapshot: connected(body.actor), receipt: null }))
        render(<Probe capture={capture} />)
        await waitFor(() => expect(capture.current?.snapshot?.connection?.address).toBe(connection.address))
        expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).action)).toEqual(['read'])
        expect(capture.current?.actor).toEqual(seed)
    })
    it('does not fetch while inactive and recreates the disposed client on reopen', async () => {
        const capture = { current: null as RemoteMachinesState | null }
        const fetchMock = responsesFor(body => ({ ok: true, snapshot: connected(body.actor), receipt: null }))
        const view = render(<Probe capture={capture} active={false} />)
        expect(fetchMock).not.toHaveBeenCalled()
        view.rerender(<Probe capture={capture} />)
        await waitFor(() => expect(capture.current?.snapshot).not.toBeNull())
        view.rerender(<Probe capture={capture} active={false} />)
        view.rerender(<Probe capture={capture} />)
        await waitFor(() => expect(capture.current?.snapshot).not.toBeNull())
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })
    it('survives StrictMode setup/cleanup with an owned new client', async () => {
        const capture = { current: null as RemoteMachinesState | null }
        responsesFor(body => ({ ok: true, snapshot: connected(body.actor), receipt: null }))
        render(<StrictMode><Probe capture={capture} /></StrictMode>)
        await waitFor(() => expect(capture.current?.snapshot?.actor).toEqual(seed))
        expect(capture.current?.unavailable).toBe(false)
    })
    it('pairs only from the explicit callback and applies its exact receipt', async () => {
        const capture = { current: null as RemoteMachinesState | null }
        let paired = false
        responsesFor(body => {
            if (body.action === 'pair') { paired = true; return effectResult(body, connected(body.actor, { selected: false, runtimeState: 'not_connected' })) }
            return { ok: true, snapshot: paired ? connected(body.actor, { selected: false, runtimeState: 'not_connected' }) : empty(body.actor), receipt: null }
        })
        render(<Probe capture={capture} />)
        await waitFor(() => expect(capture.current?.snapshot?.revision).toBe('unconfigured'))
        await act(async () => { await capture.current!.pair(connection.address, 'engine-key-1234567890123456') })
        expect(capture.current?.snapshot?.connection?.address).toBe(connection.address)
        expect(capture.current?.snapshot?.selected).toBe(false)
        expect(capture.current?.busy).toBeNull()
    })
    it('keeps a transport-lost mutation identity and retries the exact envelope', async () => {
        const capture = { current: null as RemoteMachinesState | null }; let uncertain = true
        const fetchMock = responsesFor(body => {
            if (body.action === 'read') return { ok: true, snapshot: empty(body.actor), receipt: null }
            if (uncertain) return { ok: false, code: 'uncertain', message: 'No acknowledgement.', receipt: null }
            return effectResult(body, connected(body.actor))
        })
        render(<Probe capture={capture} />)
        await waitFor(() => expect(capture.current?.snapshot).not.toBeNull())
        await act(async () => { await capture.current!.pair(connection.address, 'engine-key-1234567890123456') })
        const first = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).find(body => body.action === 'pair')
        expect(capture.current?.pendingRetry?.requestId).toBe(first.requestId)
        uncertain = false
        await act(async () => { await capture.current!.retry() })
        const pairs = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(body => body.action === 'pair')
        expect(pairs).toHaveLength(2); expect(pairs[1]).toEqual(pairs[0])
        expect(capture.current?.pendingRetry).toBeNull()
    })
    it('targets the exact saved operation for recovery and cancellation', async () => {
        const capture = { current: null as RemoteMachinesState | null }
        const open = { ...receipt, requiresRecovery: true, phase: 'failed_after_drain' as const }
        const fetchMock = responsesFor(body => body.action === 'read' ? { ok: true, snapshot: connected(body.actor, { openReceipt: open }), receipt: null } : effectResult(body, connected(body.actor)))
        render(<Probe capture={capture} />)
        await waitFor(() => expect(capture.current?.snapshot?.openReceipt).not.toBeNull())
        await act(async () => { await capture.current!.recover() })
        await act(async () => { await capture.current!.cancel() })
        const calls = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
        expect(calls.find(body => body.action === 'recover')).toMatchObject({ requestId: receipt.requestId, expectedReceiptRevision: receipt.revision, resume: true })
        expect(calls.find(body => body.action === 'cancel')).toMatchObject({ requestId: receipt.requestId })
    })
    it('does not clear an uncertain request merely because its receipt was found', async () => {
        const capture = { current: null as RemoteMachinesState | null }
        const fetchMock = responsesFor(body => {
            if (body.action === 'read') return { ok: true, snapshot: empty(body.actor), receipt: null }
            if (body.action === 'receipt') return { ok: true, snapshot: empty(body.actor), receipt: { ...receipt, requestId: body.requestId, requiresRecovery: true, phase: 'failed_after_drain' } }
            return { ok: false, code: 'uncertain', message: 'No acknowledgement.', receipt: null }
        })
        render(<Probe capture={capture} />)
        await waitFor(() => expect(capture.current?.snapshot).not.toBeNull())
        await act(async () => { await capture.current!.pair(connection.address, 'engine-key-1234567890123456') })
        const id = capture.current!.pendingRetry!.requestId
        await act(async () => { await capture.current!.settle() })
        expect(capture.current?.pendingRetry?.requestId).toBe(id)
        expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).find(body => body.action === 'receipt').requestId).toBe(id)
    })
    it('drops another renderer actor and surfaces unavailable state', async () => {
        const capture = { current: null as RemoteMachinesState | null }
        responsesFor(body => ({ ok: true, snapshot: connected({ ...body.actor, rendererEpoch: '99999999-9999-4999-8999-999999999999' }), receipt: null }))
        render(<Probe capture={capture} />)
        await waitFor(() => expect(capture.current?.unavailable).toBe(true))
        expect(capture.current?.snapshot).toBeNull()
    })
    it('does not publish an old scope response into a replacement native actor', async () => {
        const capture = { current: null as RemoteMachinesState | null }; let resolveOld!: (response: Response) => void
        const old = new Promise<Response>(resolve => { resolveOld = resolve })
        const next = { ...seed, workspaceId: 2, rendererEpoch: '99999999-9999-4999-8999-999999999999' }
        vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
            const body = JSON.parse(String(init.body)) as DesktopRemoteCommand
            return body.actor.workspaceId === 1 ? old : Response.json({ ok: true, snapshot: empty(body.actor), receipt: null })
        }))
        const view = render(<Probe capture={capture} />)
        view.rerender(<Probe capture={capture} actor={next} />)
        await waitFor(() => expect(capture.current?.snapshot?.actor).toEqual(next))
        await act(async () => { resolveOld(Response.json({ ok: true, snapshot: connected(seed), receipt: null })) })
        expect(capture.current?.snapshot?.actor).toEqual(next)
    })
})
