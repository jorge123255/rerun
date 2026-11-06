import { describe, expect, it, vi } from 'vitest'
import { createDesktopGuestShellService } from './service.js'
import type { DesktopGuestShellIdentity, DesktopGuestShellInput, DesktopGuestShellReceipt, DesktopGuestShellResult, DesktopGuestShellRequest, DesktopGuestShellStore } from './types.js'
const identity: DesktopGuestShellIdentity = { agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'provider-call-1', requestId: '11111111-1111-4111-8111-111111111111', guest: { engineAgentId: 'agent', launchNonce: 'launch', sessionGeneration: 'a'.repeat(32), workspaceFingerprint: 'b'.repeat(64) } }
const input: DesktopGuestShellInput = { command: 'printf ok', timeoutMs: 120000, cwd: '' }
const result = (status: DesktopGuestShellResult['status'] = 'done'): DesktopGuestShellResult => ({ requestId: identity.requestId, status, stdout: 'ok', stderr: '', exitCode: status === 'done' ? 0 : null, durationMs: 1 })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
    const records = new Map<string, DesktopGuestShellReceipt>()
    const store: DesktopGuestShellStore = { read: vi.fn(async id => records.get(id) ?? null), begin: vi.fn(async (_id, value) => { const prior = records.get(value.requestId); if (prior) return prior; records.set(value.requestId, value); return 'execute' as const }), complete: vi.fn(async (_id, value) => { records.set(value.requestId, value) }) }
    const transport = { execute: vi.fn(async (_identity: DesktopGuestShellRequest, _signal: AbortSignal) => result()), inspect: vi.fn(async (_identity: DesktopGuestShellIdentity, _signal: AbortSignal) => result()), cancel: vi.fn(async (_identity: DesktopGuestShellIdentity, _signal: AbortSignal) => result('cancelled')) }
    const authority = vi.fn(async (_base: Omit<DesktopGuestShellIdentity, 'guest'>, _signal: AbortSignal, _phase?: 'execute' | 'inspect') => identity.guest)
    const packageAuthority = vi.fn(async () => [{ package: 'is-number@7.0.0', manifestSha256: 'c'.repeat(64), lockSha256: 'd'.repeat(64) }])
    return { records, store, transport, authority, packageAuthority, service: createDesktopGuestShellService({ store, transport, authority, packageAuthority }) }
}
describe('guest command immutable admission and recovery', () => {
    it('persists before effect; replay of a confirmed command never starts or probes a guest', async () => {
        const f = fixture()
        f.transport.execute.mockImplementationOnce(async () => { expect(f.records.get(identity.requestId)?.status).toBe('interrupted'); return result() })
        const first = await f.service.execute(identity, input, new AbortController().signal)
        f.authority.mockRejectedValue(new Error('Guest stopped'))
        expect(await f.service.execute(identity, input, new AbortController().signal)).toEqual(first)
        expect(f.transport.execute).toHaveBeenCalledTimes(1)
    })
    it('refuses changed command or cross-owner retry before provider execution', async () => {
        const f = fixture(); await f.service.execute(identity, input, new AbortController().signal)
        await expect(f.service.execute(identity, { ...input, command: 'echo changed' }, new AbortController().signal)).rejects.toThrow('different command')
        await expect(f.service.execute({ ...identity, sessionId: 'other' }, input, new AbortController().signal)).rejects.toThrow('another invocation')
        expect(f.transport.execute).toHaveBeenCalledTimes(1)
    })
    it('does not execute after permission is revoked while saving the reservation', async () => {
        const f = fixture(), held = deferred<'execute'>(), entered = deferred<void>()
        f.store.begin = vi.fn(async () => { entered.resolve(); return held.promise })
        const service = createDesktopGuestShellService({ store: f.store, transport: f.transport, authority: f.authority })
        const task = service.execute(identity, input, new AbortController().signal)
        await entered.promise; f.authority.mockRejectedValue(new Error('Grant revoked')); held.resolve('execute')
        await expect(task).rejects.toThrow('Grant revoked'); expect(f.transport.execute).not.toHaveBeenCalled()
    })
    it('recovers an interrupted receipt by inspection, never a second execution', async () => {
        const f = fixture(); f.transport.execute.mockRejectedValueOnce(new Error('Lost ACK'))
        expect((await f.service.execute(identity, input, new AbortController().signal)).status).toBe('interrupted')
        expect((await f.service.execute(identity, input, new AbortController().signal)).status).toBe('done')
        expect(f.transport.execute).toHaveBeenCalledTimes(1); expect(f.transport.inspect).toHaveBeenCalledTimes(1)
        expect(f.authority.mock.calls.at(-1)?.[2]).toBe('inspect')
    })
    it('keeps unknown cancellation interrupted and uses a fresh signal for drain', async () => {
        const f = fixture(), controller = new AbortController()
        f.transport.execute.mockImplementationOnce(async () => { controller.abort(); throw new Error('Stopped') })
        f.transport.cancel.mockImplementationOnce(async (_identity, signal) => { expect(signal.aborted).toBe(false); throw new Error('No drain ACK') })
        expect((await f.service.execute(identity, input, controller.signal)).status).toBe('interrupted')
    })
    it('records the saved cancelled result only after exact cleanup acknowledges drain', async () => {
        const f = fixture(), controller = new AbortController()
        f.transport.execute.mockImplementationOnce(async () => { controller.abort(); throw new Error('Stopped') })
        expect((await f.service.execute(identity, input, controller.signal)).status).toBe('cancelled')
        expect(f.transport.cancel).toHaveBeenCalledWith(identity, expect.any(AbortSignal))
    })
    it.each(['done', 'failed', 'timeout'] as const)('retains known %s through a late final-authorization Abort even when cleanup fails', async status => {
        const f = fixture(), controller = new AbortController(), completed = result(status)
        f.transport.execute.mockResolvedValueOnce(completed)
        f.authority.mockImplementation(async () => {
            if (f.transport.execute.mock.calls.length) controller.abort()
            return identity.guest
        })
        f.transport.cancel.mockRejectedValueOnce(new Error('Cleanup acknowledgement lost'))
        const receipt = await f.service.execute(identity, input, controller.signal)
        expect(receipt).toMatchObject(completed)
        expect(f.records.get(identity.requestId)).toEqual(receipt)
        const reopened = createDesktopGuestShellService({ store: f.store, transport: f.transport, authority: async () => { throw new Error('Stopped owner') } })
        expect(await reopened.inspect(identity, new AbortController().signal)).toEqual(receipt)
        expect(f.transport.inspect).not.toHaveBeenCalled()
        expect(f.transport.execute).toHaveBeenCalledTimes(1)
    })
    it('uses the saved completion when Stop loses its race with the execute acknowledgement', async () => {
        const f = fixture(), controller = new AbortController()
        f.transport.execute.mockImplementationOnce(async () => { controller.abort(); throw new Error('Execute acknowledgement lost') })
        f.transport.cancel.mockResolvedValueOnce(result())
        expect(await f.service.execute(identity, input, controller.signal)).toMatchObject(result())
        expect(f.transport.execute).toHaveBeenCalledTimes(1)
    })
    it('keeps an unknown saved result interrupted despite a positive drain acknowledgement', async () => {
        const f = fixture(), controller = new AbortController()
        f.transport.execute.mockImplementationOnce(async () => { controller.abort(); throw new Error('Stopped') })
        f.transport.cancel.mockResolvedValueOnce(result('interrupted'))
        expect((await f.service.execute(identity, input, controller.signal)).status).toBe('interrupted')
    })
    it('explicit Stop preserves the original completed receipt and output', async () => {
        const f = fixture()
        f.transport.execute.mockRejectedValueOnce(new Error('Execute acknowledgement lost'))
        expect((await f.service.execute(identity, input, new AbortController().signal)).status).toBe('interrupted')
        f.transport.cancel.mockResolvedValueOnce(result())
        expect(await f.service.stop(identity, new AbortController().signal)).toMatchObject(result())
        expect(f.transport.execute).toHaveBeenCalledTimes(1)
    })
    it('aborted admission and absent reviewed package evidence cause no reservation or guest work', async () => {
        const f = fixture(), controller = new AbortController(); controller.abort()
        await expect(f.service.execute(identity, input, controller.signal)).rejects.toThrow()
        f.packageAuthority.mockResolvedValueOnce([])
        await expect(f.service.execute(identity, { ...input, packages: ['is-number@7.0.0'] }, new AbortController().signal)).rejects.toThrow('reviewed package')
        expect(f.store.begin).not.toHaveBeenCalled(); expect(f.transport.execute).not.toHaveBeenCalled()
    })
    it('in-flight duplicate IDs cannot share results with another owner', async () => {
        const f = fixture(), held = deferred<DesktopGuestShellResult>(), started = deferred<void>()
        f.transport.execute.mockImplementationOnce(async () => { started.resolve(); return held.promise })
        const task = f.service.execute(identity, input, new AbortController().signal); await started.promise
        await expect(f.service.execute({ ...identity, agentId: 'other' }, input, new AbortController().signal)).rejects.toThrow('Another invocation')
        held.resolve(result()); await task
    })
})
