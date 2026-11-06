import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRemoteCommand, DesktopRemoteReceipt } from '@rerun/contracts'
import { createDesktopRemoteMachinesClient, RemoteMachineRequestError, REMOTE_MACHINES_ROUTE } from './remote-machines-client'
import { remoteActor as actor, remoteConnection as connection, remoteReceipt as receipt, connectedRemoteSnapshot as connected, emptyRemoteSnapshot as empty } from './remote-machines.test-support'

const fetchMock = vi.fn()
afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const ok = (command?: DesktopRemoteCommand) => {
    const effect = command && command.action !== 'read' ? { ...receipt, requestId: command.requestId,
        ...('connectionId' in command ? { connectionId: command.connectionId, expectedRevision: command.expectedRevision } : {}),
        ...(['pair', 'replace', 'select', 'remove', 'health'].includes(command.action) ? { kind: command.action as DesktopRemoteReceipt['kind'] } : {}) } : null
    const next = command && 'connectionId' in command ? { ...connection, connectionId: command.connectionId } : connection
    return { ok: true as const, snapshot: command?.action === 'remove' ? empty(actor) : connected(actor, { connection: next, activeReceipt: effect ?? receipt }), receipt: effect }
}
const bodyOf = (index = 0) => JSON.parse(String(fetchMock.mock.calls[index][1]?.body)) as DesktopRemoteCommand
const response = () => fetchMock.mockImplementation(async (_url, init) => Response.json(ok(JSON.parse(String(init.body)))))

describe('native-actor remote machine client', () => {
    it('uses the exact native renderer lease rather than minting an epoch', async () => {
        vi.stubGlobal('fetch', response())
        const client = createDesktopRemoteMachinesClient(actor)
        await client.read()
        expect(fetchMock.mock.calls[0][0]).toBe(REMOTE_MACHINES_ROUTE)
        expect(bodyOf().actor).toEqual(actor)
        expect(bodyOf().requestId).toMatch(/^[0-9a-f-]{36}$/)
        client.dispose()
    })
    it('refuses a partial actor instead of trusting a renderer-generated epoch', () => {
        const { rendererEpoch: _epoch, ...partial } = actor
        expect(() => createDesktopRemoteMachinesClient(partial as typeof actor)).toThrow()
        expect(fetchMock).not.toHaveBeenCalled()
    })
    it('uses a concrete native bridge without sending credentials through fetch', async () => {
        const bridge = { execute: vi.fn(async (command: DesktopRemoteCommand) => ok(command)) }
        const client = createDesktopRemoteMachinesClient(actor, { bridge })
        await client.read()
        expect(bridge.execute).toHaveBeenCalledWith(expect.objectContaining({ action: 'read', actor }), expect.any(AbortSignal))
        expect(fetchMock).not.toHaveBeenCalled()
        client.dispose()
    })
    it('pairs and replaces with exact typed envelopes, and removes only with confirmation', async () => {
        vi.stubGlobal('fetch', response())
        const client = createDesktopRemoteMachinesClient(actor)
        await client.pair('https://machine.example', 'engine-key-1234567890123456')
        await client.replace(connection.connectionId, connection.revision, 'https://next.example', 'engine-key-1234567890123456')
        await client.select(connection.connectionId, connection.revision)
        await client.remove(connection.connectionId, connection.revision)
        expect(bodyOf()).toMatchObject({ action: 'pair', expectedRevision: 'unconfigured', apiKey: 'engine-key-1234567890123456' })
        expect(bodyOf(1)).toMatchObject({ action: 'replace', connectionId: connection.connectionId, expectedRevision: connection.revision })
        expect(bodyOf(2)).toMatchObject({ action: 'select', connectionId: connection.connectionId })
        expect(bodyOf(3)).toMatchObject({ action: 'remove', confirmation: 'Remove' })
        client.dispose()
    })
    it('receipt, Cancel and Recover target the original operation rather than new IDs', async () => {
        vi.stubGlobal('fetch', response())
        const client = createDesktopRemoteMachinesClient(actor)
        await client.receipt(receipt.requestId)
        await client.cancel(receipt.requestId)
        await client.recover(receipt.revision, receipt.requestId)
        expect(bodyOf()).toMatchObject({ action: 'receipt', requestId: receipt.requestId })
        expect(bodyOf(1)).toMatchObject({ action: 'cancel', requestId: receipt.requestId })
        expect(bodyOf(2)).toMatchObject({ action: 'recover', requestId: receipt.requestId, resume: true, expectedReceiptRevision: receipt.revision })
        client.dispose()
    })
    it('retains a transport-lost mutation and retries byte-identical input once, then drops the raw-key retry body', async () => {
        vi.stubGlobal('fetch', fetchMock.mockRejectedValueOnce(new TypeError('secret-bearing transport error')).mockImplementation(async (_url, init) => Response.json(ok(JSON.parse(String(init.body))))))
        const client = createDesktopRemoteMachinesClient(actor)
        const failure = await client.pair('https://machine.example', 'engine-key-1234567890123456').catch(error => error)
        expect(failure).toMatchObject({ code: 'uncertain' })
        expect(failure.message).not.toContain('secret-bearing')
        const first = bodyOf()
        await client.retry(first.requestId)
        expect(bodyOf(1)).toEqual(first)
        await expect(client.retry(first.requestId)).rejects.toMatchObject({ code: 'unavailable' })
        expect(fetchMock).toHaveBeenCalledTimes(2)
        client.dispose()
    })
    it('refuses a receipt from another request and preserves the unresolved original retry', async () => {
        vi.stubGlobal('fetch', fetchMock.mockResolvedValueOnce(Response.json({ ...ok(), receipt })))
        const client = createDesktopRemoteMachinesClient(actor)
        await expect(client.pair('https://machine.example', 'engine-key-1234567890123456')).rejects.toMatchObject({ code: 'uncertain' })
        const first = bodyOf()
        fetchMock.mockImplementation(async (_url, init) => Response.json(ok(JSON.parse(String(init.body)))))
        await expect(client.retry(first.requestId)).resolves.toMatchObject({ ok: true })
        client.dispose()
    })
    it('does not consider an unresolved receipt to be a completed retry', async () => {
        vi.stubGlobal('fetch', fetchMock.mockImplementation(async (_url, init) => {
            const command = JSON.parse(String(init.body)) as DesktopRemoteCommand
            return Response.json({ ok: true as const, snapshot: connected(actor), receipt: { ...receipt, requestId: command.requestId, requiresRecovery: true, phase: 'failed_after_drain' } satisfies DesktopRemoteReceipt })
        }))
        const client = createDesktopRemoteMachinesClient(actor)
        const commandId = receipt.requestId
        expect((await client.receipt(commandId))?.requiresRecovery).toBe(true)
        client.dispose()
    })
    it('bounds native bridge waits and retains uncertainty rather than losing an admitted request', async () => {
        const timeout = new AbortController()
        vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
        const client = createDesktopRemoteMachinesClient(actor, { bridge: { execute: () => new Promise(() => {}) } })
        const pending = client.pair('https://machine.example', 'engine-key-1234567890123456').catch(error => error)
        expect(AbortSignal.timeout).toHaveBeenCalledWith(70_000)
        timeout.abort()
        expect(await pending).toMatchObject({ code: 'uncertain' })
        client.dispose()
    })
    it('keeps read failures safe and refuses work after dispose', async () => {
        vi.stubGlobal('fetch', fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')))
        const client = createDesktopRemoteMachinesClient(actor)
        await expect(client.read()).rejects.toMatchObject({ code: 'network' })
        client.dispose()
        await expect(client.read()).rejects.toMatchObject({ code: 'cancelled' })
        expect(fetchMock).toHaveBeenCalledOnce()
    })
})
