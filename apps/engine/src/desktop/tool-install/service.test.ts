import { expect, it, vi } from 'vitest'
import { createDesktopToolInstallService, type DesktopToolInstallPorts, type DesktopToolInstallSnapshot } from '@rerun/contracts'
const base = { agentId: 'public-agent', sessionId: 'public-chat', runId: 'run', toolCallId: 'call', proposalRevision: '1' }
const guest = { engineAgentId: 'engine-agent', launchNonce: 'launch', sessionGeneration: 'a'.repeat(32), workspaceFingerprint: 'b'.repeat(64) }
function fixture() {
 let snapshot: DesktopToolInstallSnapshot | null = null
 const ports: DesktopToolInstallPorts = {
  authority: vi.fn(async () => guest), guest: { execute: vi.fn(), inspect: vi.fn() },
  outcomes: { begin: vi.fn(async () => snapshot ?? 'execute'), complete: vi.fn(async (_identity, row) => { snapshot = row }), read: vi.fn(async () => snapshot), list: vi.fn(async () => snapshot ? [snapshot] : []), reservation: vi.fn(), replay: vi.fn(), claim: vi.fn(), finishRequest: vi.fn() },
 }
 return { ports, service: createDesktopToolInstallService(ports) }
}
it('reserves a public proposal and never invokes installation during reads or repeated proposal delivery', async () => {
 const { ports, service } = fixture(), input = { packages: ['left-pad@1.2.3'] }
 const snapshot = await service.propose(base, input)
 expect(snapshot).toMatchObject({ agentId: base.agentId, sessionId: base.sessionId, status: 'pending-approval' })
 expect(snapshot).not.toHaveProperty('guest')
 await expect(service.propose(base, input)).resolves.toEqual(snapshot)
 await expect(service.read(snapshot.operationId)).resolves.toEqual(snapshot)
 expect(ports.guest.execute).not.toHaveBeenCalled(); expect(ports.guest.inspect).not.toHaveBeenCalled()
})
it('rejects malformed package targets before owner or guest admission', async () => {
 const { ports, service } = fixture()
 await expect(service.propose(base, { packages: ['--prefix=/tmp'] })).rejects.toThrow()
 expect(ports.authority).not.toHaveBeenCalled(); expect(ports.outcomes.begin).not.toHaveBeenCalled()
})
it('does not admit an already cancelled proposal', async () => {
 const { ports, service } = fixture(), abort = new AbortController(); abort.abort()
 await expect(service.propose(base, { packages: ['left-pad@1.2.3'] }, abort.signal)).rejects.toThrow()
 expect(ports.authority).not.toHaveBeenCalled()
})
