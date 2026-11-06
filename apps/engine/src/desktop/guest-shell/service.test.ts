import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createDesktopGuestShellService } from './service'
import type { DesktopGuestShellIdentity, DesktopGuestShellInput, DesktopGuestShellReceipt, DesktopGuestShellStore } from './types'

const identity: DesktopGuestShellIdentity = {
    agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'tool', requestId: '11111111-1111-4111-8111-111111111111',
    guest: { engineAgentId: 'engine', launchNonce: 'launch', sessionGeneration: 'a'.repeat(32), workspaceFingerprint: 'b'.repeat(64) },
}
const input: DesktopGuestShellInput = { command: 'printf ok', timeoutMs: 120_000, cwd: '', packages: ['is-number@7.0.0'] }

function fingerprint(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function receipt(result: Partial<DesktopGuestShellReceipt>, currentIdentity = identity, currentInput = input): DesktopGuestShellReceipt {
    return {
        requestId: currentIdentity.requestId,
        status: 'done', stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1,
        identity: currentIdentity,
        fingerprint: fingerprint([currentIdentity.agentId, currentIdentity.sessionId, currentIdentity.runId, currentIdentity.toolCallId, currentIdentity.requestId, currentIdentity.guest, currentInput]),
        ...result,
    }
}

function fixture(overrides: { execute?: (request: unknown) => Promise<Partial<DesktopGuestShellReceipt>> } = {}) {
    const records = new Map<string, DesktopGuestShellReceipt>()
    const store: DesktopGuestShellStore = {
        async begin(_request, initial) {
            const existing = records.get(initial.requestId)
            if (existing) return existing
            records.set(initial.requestId, initial)
            return 'execute'
        },
        async complete(_identity, value) { records.set(value.requestId, value) },
        async read(requestId) { return records.get(requestId) ?? null },
    }
    const execute = vi.fn(async () => overrides.execute ? overrides.execute({}) : receipt({}))
    const inspect = vi.fn(async () => receipt({}))
    const cancel = vi.fn(async () => {})
    const packageAuthority = vi.fn(async () => [{ package: 'is-number@7.0.0', manifestSha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64) }])
    const authority = vi.fn(async () => identity.guest)
    const service = createDesktopGuestShellService({ store, transport: { execute, inspect, cancel }, authority, packageAuthority })
    return { service, records, execute, inspect, cancel, packageAuthority, authority }
}

describe('desktop guest shell service', () => {
    it('reserves before launch and reconciles duplicate invocation without a second execution', async () => {
        const f = fixture()
        const first = await f.service.execute(identity, input, new AbortController().signal)
        const second = await f.service.execute(identity, input, new AbortController().signal)
        expect(first).toEqual(second)
        expect(f.execute).toHaveBeenCalledTimes(1)
        expect(f.packageAuthority).toHaveBeenCalledWith(identity.guest, input.packages, expect.any(AbortSignal))
    })

    it('refuses changed command under the same request identity', async () => {
        const f = fixture()
        await f.service.execute(identity, input, new AbortController().signal)
        await expect(f.service.execute(identity, { ...input, command: 'printf different' }, new AbortController().signal)).rejects.toThrow('different command')
        expect(f.execute).toHaveBeenCalledTimes(1)
    })

    it('requires exact reviewed package evidence before reservation', async () => {
        const f = fixture()
        f.packageAuthority.mockResolvedValueOnce([])
        await expect(f.service.execute(identity, input, new AbortController().signal)).rejects.toThrow('required reviewed package')
        expect(f.execute).not.toHaveBeenCalled()
    })

    it('cancels the exact process and preserves cancellation receipt', async () => {
        const controller = new AbortController()
        controller.abort()
        const f = fixture({ execute: async () => { throw new Error('cancelled') } })
        const result = await f.service.execute(identity, input, controller.signal)
        expect(result.status).toBe('cancelled')
        expect(f.cancel).toHaveBeenCalledWith(identity, controller.signal)
    })

    it('returns interrupted rather than executing uncertain work twice', async () => {
        const f = fixture({ execute: async () => { throw new Error('response lost') } })
        const result = await f.service.execute(identity, input, new AbortController().signal)
        expect(result.status).toBe('interrupted')
        expect(f.execute).toHaveBeenCalledTimes(1)
        expect(await f.service.inspect(identity, new AbortController().signal)).toMatchObject({ status: 'interrupted' })
        expect(f.inspect).not.toHaveBeenCalled()
    })

    it('stops only the exact current request', async () => {
        const f = fixture()
        const result = await f.service.stop(identity, new AbortController().signal)
        expect(result.status).toBe('done')
        expect(f.cancel).toHaveBeenCalledWith(identity, expect.any(AbortSignal))
        expect(f.inspect).toHaveBeenCalledWith(identity, expect.any(AbortSignal))
    })
})
