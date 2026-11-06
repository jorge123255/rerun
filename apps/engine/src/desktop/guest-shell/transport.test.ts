import { describe, expect, it, vi } from 'vitest'
import { createDesktopGuestShellTransport } from './transport.js'
import { guestShellRequestId } from './tools.js'
import type { DesktopGuestShellIdentity, DesktopGuestShellRequest } from './types.js'
const identity: DesktopGuestShellRequest = { agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'provider-call', requestId: '11111111-1111-4111-8111-111111111111', guest: { engineAgentId: 'agent', launchNonce: 'launch', sessionGeneration: 'a'.repeat(32), workspaceFingerprint: 'b'.repeat(64) }, fingerprint: 'c'.repeat(64), command: 'printf ok', timeoutMs: 120000, cwd: '' }
const commandId = identity.requestId.replaceAll('-', '')
const response = { ok: true, requestId: commandId, status: 'done', stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 }
describe('guest command transport', () => {
    it('separates immutable command identity from fresh native RPC envelope identities', async () => {
        const rpc = vi.fn(async (_identity: DesktopGuestShellIdentity, _body: Record<string, unknown>, _signal: AbortSignal) => response), transport = createDesktopGuestShellTransport(rpc)
        expect(await transport.execute(identity, new AbortController().signal)).toEqual({ requestId: identity.requestId, status: 'done', stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 })
        expect(rpc).toHaveBeenCalledWith(identity, expect.objectContaining({ op: 'guest-shell', commandId, fingerprint: identity.fingerprint }), expect.any(AbortSignal))
        expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty('requestId')
        await transport.inspect(identity, new AbortController().signal)
        expect(rpc.mock.calls[1]?.[1]).toMatchObject({ op: 'guest-shell-inspect', commandId })
    })
    it.each([{ ...response, requestId: 'e'.repeat(32) }, { ...response, ok: false }, { ...response, exitCode: -9 }, { ...response, extra: true }])('rejects a mismatched or malformed ACK before normalization', async reply => {
        await expect(createDesktopGuestShellTransport(async () => reply).execute(identity, new AbortController().signal)).rejects.toThrow()
    })
    it('requires both exact positive drain acknowledgement and a validated final saved outcome', async () => {
        for (const reply of [{ ok: true }, { ok: true, requestId: 'e'.repeat(32), drained: true }, { ok: true, requestId: commandId, drained: false }, { ok: true, requestId: commandId, drained: true }, { ...response, drained: true, status: 'interrupted' }, { ...response, drained: true, stdout: 42 }]) await expect(createDesktopGuestShellTransport(async () => reply).cancel(identity, new AbortController().signal)).rejects.toThrow()
        await expect(createDesktopGuestShellTransport(async () => ({ ...response, drained: true })).cancel(identity, new AbortController().signal)).resolves.toEqual({ requestId: identity.requestId, status: 'done', stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 })
    })
    it('derives a stable UUID from the complete invocation without requiring provider UUIDs', () => {
        const id = guestShellRequestId('agent', 'session', 'run', 'functions.call-17')
        expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/)
        expect(id).toBe(guestShellRequestId('agent', 'session', 'run', 'functions.call-17'))
        expect(id).not.toBe(guestShellRequestId('agent', 'other', 'run', 'functions.call-17'))
    })
})
