import { describe, expect, it } from 'vitest'
import type { DesktopGuestShellReceipt } from './types.js'
import { formatDesktopGuestShellResult } from './tools.js'

const requestId = '11111111-1111-4111-8111-111111111111'
const receipt: DesktopGuestShellReceipt = {
    requestId, status: 'done', stdout: '42', stderr: '', exitCode: 0, durationMs: 12, fingerprint: 'c'.repeat(64),
    identity: { agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'call', requestId,
        guest: { engineAgentId: 'agent', launchNonce: 'launch', sessionGeneration: 'a'.repeat(32), workspaceFingerprint: 'b'.repeat(64) } },
}

describe('saved command receipt presentation', () => {
    it('makes a successful inspected receipt explicit even when the command produced no output', () => {
        expect(formatDesktopGuestShellResult({ ...receipt, stdout: '' })).toBe(`Command request: ${requestId}\nStatus: done\n(no output)`)
    })
    it('keeps cancelled status and the output captured before Stop together', () => {
        expect(formatDesktopGuestShellResult({ ...receipt, status: 'cancelled', stdout: 'GUEST34STOP2', exitCode: null })).toBe(`Command request: ${requestId}\nStatus: cancelled\nCommand cancelled\nGUEST34STOP2`)
    })
    it.each(['failed', 'timeout', 'interrupted', 'unavailable'] as const)('does not imply completion for a saved %s receipt', status => {
        const text = formatDesktopGuestShellResult({ ...receipt, status, exitCode: null, stdout: '', message: 'Inspect this same request.' })
        expect(text).toContain(`Command request: ${requestId}\nStatus: ${status}\n`)
        expect(text).not.toContain('Status: done')
        if (status === 'interrupted') expect(text).toContain('instead of executing it again')
    })
})
