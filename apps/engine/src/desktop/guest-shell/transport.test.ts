import { describe, expect, it, vi } from 'vitest'
import { createDesktopGuestShellTransport } from './transport'
import { encodeFrame } from '../isolated-screen/frame'
import { containerName } from '../isolated-screen/identity'
import type { DesktopGuestShellIdentity, DesktopGuestShellRequest } from './types'

const identity: DesktopGuestShellRequest = {
    agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'tool', requestId: '11111111-1111-4111-8111-111111111111',
    guest: { engineAgentId: 'engine', launchNonce: 'launch', sessionGeneration: 'a'.repeat(32), workspaceFingerprint: 'b'.repeat(64) },
    command: 'printf ok', timeoutMs: 120_000, cwd: '', packages: ['is-number@7.0.0'],
}

describe('desktop guest shell transport', () => {
    it('uses the isolated RPC operation with exact request identity and validated result', async () => {
        const exec = vi.fn(async (_name, _command, input) => {
            const request = JSON.parse(input.subarray(8).toString())
            expect(request).toMatchObject({ op: 'guest-shell', requestId: identity.requestId.replaceAll('-', ''), command: identity.command, cwd: '', packages: ['is-number@7.0.0'] })
            return encodeFrame({ ok: true, requestId: identity.requestId, status: 'done', stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 })
        })
        const transport = createDesktopGuestShellTransport({ exec } as never)
        const result = await transport.execute(identity, new AbortController().signal)
        expect(result).toMatchObject({ status: 'done', stdout: 'ok', requestId: identity.requestId })
        expect(exec).toHaveBeenCalledWith(containerName(identity.guest.engineAgentId), ['rerun-rpc'], expect.any(Buffer), expect.any(AbortSignal))
    })

    it('inspects and cancels without a second launch', async () => {
        const exec = vi.fn(async (_name, _command, input) => {
            const request = JSON.parse(input.subarray(8).toString())
            if (request.op === 'cancel') return encodeFrame({ ok: true })
            expect(request.op).toBe('guest-shell-inspect')
            return encodeFrame({ ok: true, requestId: identity.requestId, status: 'unavailable', stdout: '', stderr: '', exitCode: null, durationMs: 0 })
        })
        const transport = createDesktopGuestShellTransport({ exec } as never)
        expect((await transport.inspect(identity, new AbortController().signal)).status).toBe('unavailable')
        await transport.cancel(identity, new AbortController().signal)
        expect(exec).toHaveBeenCalledTimes(2)
    })
})
