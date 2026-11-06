import { describe, expect, it, vi } from 'vitest'
import type { DesktopToolInstallGuestIdentity, DesktopToolInstallPorts, DesktopToolInstallRunIdentity, DesktopToolInstallSnapshot } from '@rerun/contracts'
import { createDesktopToolInstallService } from './service'

const guest: DesktopToolInstallGuestIdentity = { engineAgentId: 'engine', launchNonce: 'launch', sessionGeneration: 'a'.repeat(32), workspaceFingerprint: 'b'.repeat(64) }
const base = { agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'tool', proposalRevision: '1' }
const packages = ['left-pad@1.2.3']
const evidence = { manifestSha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64) }
const now = () => '2026-11-05T10:00:00.000Z'

function fixture(patch: {
    authority?: DesktopToolInstallPorts['authority']
    execute?: DesktopToolInstallPorts['guest']['execute']
    inspect?: DesktopToolInstallPorts['guest']['inspect']
    begin?: DesktopToolInstallPorts['outcomes']['begin']
    complete?: DesktopToolInstallPorts['outcomes']['complete']
} = {}) {
    const snapshots = new Map<string, DesktopToolInstallSnapshot>()
    const execute = patch.execute ?? vi.fn(async () => ({ status: 'installed' as const, packages: [{ package: packages[0], status: 'installed' as const, ...evidence }] }))
    const inspect = patch.inspect ?? vi.fn(async () => ({ status: 'installed' as const, packages: [{ package: packages[0], status: 'installed' as const, ...evidence }] }))
    const ports: DesktopToolInstallPorts = {
        authority: patch.authority ?? vi.fn(async () => guest),
        guest: { execute, inspect },
        outcomes: {
            begin: patch.begin ?? vi.fn(async () => 'execute'),
            complete: patch.complete ?? vi.fn(async (_identity, snapshot) => { snapshots.set(snapshot.operationId, snapshot) }),
            read: vi.fn(async operationId => snapshots.get(operationId) ?? null),
            list: vi.fn(async () => [...snapshots.values()]),
        },
    }
    return { ports, execute, inspect, snapshots }
}

async function proposed(ports: DesktopToolInstallPorts) {
    const service = createDesktopToolInstallService(ports, { now })
    const snapshot = await service.propose(base, { packages })
    return { service, snapshot }
}

function decision(snapshot: DesktopToolInstallSnapshot, value: 'approved' | 'declined' = 'approved') {
    return { operation: 'decide' as const, requestId: crypto.randomUUID(), operationId: snapshot.operationId, expectedRevision: snapshot.revision, decision: value }
}

describe('reviewed desktop tool installation', () => {
    it('reserves review without executing and installs only after approval with exact evidence', async () => {
        const { ports, execute } = fixture()
        const { service, snapshot } = await proposed(ports)
        expect(snapshot.status).toBe('pending-approval')
        expect(execute).not.toHaveBeenCalled()
        const installed = await service.decide(base, decision(snapshot))
        expect(installed.status).toBe('installed')
        expect(installed.packages[0]).toMatchObject({ status: 'installed', ...evidence })
        expect(execute).toHaveBeenCalledTimes(1)
    })

    it('declines without executing the guest', async () => {
        const { ports, execute } = fixture()
        const { service, snapshot } = await proposed(ports)
        await expect(service.decide(base, decision(snapshot, 'declined'))).resolves.toMatchObject({ status: 'declined' })
        expect(execute).not.toHaveBeenCalled()
    })

    it('rejects a stale approval revision and a changed guest before execution', async () => {
        const { ports, execute } = fixture()
        const { service, snapshot } = await proposed(ports)
        await expect(service.decide(base, decision({ ...snapshot, revision: '99' }))).rejects.toThrow('changed')
        ports.authority = vi.fn(async () => ({ ...guest, sessionGeneration: 'b'.repeat(32) }))
        await expect(service.decide(base, decision(snapshot))).rejects.toThrow()
        expect(execute).not.toHaveBeenCalled()
    })

    it('does not call a partial or evidence-poor install complete', async () => {
        const { ports } = fixture({ execute: vi.fn(async () => ({ status: 'partial' as const, packages: [{ package: packages[0], status: 'installed' as const }] })) })
        const { service, snapshot } = await proposed(ports)
        const result = await service.decide(base, decision(snapshot))
        expect(result.status).not.toBe('installed')
        expect(result.packages[0].status).not.toBe('installed')
    })

    it('coalesces the exact decision and refuses a conflicting concurrent decision', async () => {
        const { ports, execute } = fixture()
        let finish!: (value: { status: 'installed'; packages: { package: string; status: 'installed'; manifestSha256: string; lockSha256: string }[] }) => void
        ports.guest.execute = vi.fn(() => new Promise(resolve => { finish = resolve }))
        const { service, snapshot } = await proposed(ports)
        const first = service.decide(base, decision(snapshot))
        const second = service.decide(base, decision(snapshot))
        await expect(service.decide(base, decision(snapshot, 'declined'))).rejects.toThrow('different decision')
        finish({ status: 'installed', packages: [{ package: packages[0], status: 'installed', ...evidence }] })
        await expect(first).resolves.toMatchObject({ status: 'installed' })
        await expect(second).resolves.toMatchObject({ status: 'installed' })
        expect(execute).toHaveBeenCalledTimes(1)
    })

    it('keeps uncertain acknowledgement without reinstalling and uses explicit inspect for recovery', async () => {
        const retained = new Map<string, DesktopToolInstallSnapshot>()
        let failFinal = true
        const complete = vi.fn(async (_identity: DesktopToolInstallRunIdentity, snapshot: DesktopToolInstallSnapshot) => {
            if (snapshot.status === 'installed' && failFinal) {
                failFinal = false
                throw new Error('ack lost')
            }
            retained.set(snapshot.operationId, snapshot)
        })
        const { ports, execute, inspect } = fixture({ complete })
        const { service, snapshot } = await proposed(ports)
        await expect(service.decide(base, decision(snapshot))).resolves.toMatchObject({ status: 'uncertain' })
        await expect(service.decide(base, decision(snapshot))).rejects.toThrow()
        expect(execute).toHaveBeenCalledTimes(1)
        const current = (await ports.outcomes.read(snapshot.operationId))!
        const recovered = await service.inspect(base, { operation: 'inspect', requestId: crypto.randomUUID(), operationId: snapshot.operationId, expectedRevision: current.revision })
        expect(recovered.status).toBe('installed')
        expect(inspect).toHaveBeenCalledTimes(1)
    })

    it('does not automatically execute after restart or history read', async () => {
        const { ports, execute } = fixture()
        const { service, snapshot } = await proposed(ports)
        const history = await service.read(snapshot.operationId)
        expect(history?.status).toBe('pending-approval')
        expect(execute).not.toHaveBeenCalled()
    })

    it('marks guest loss and cancelled execution honestly', async () => {
        const { ports } = fixture({ execute: vi.fn(async () => { throw new Error('guest stopped') }) })
        const { service, snapshot } = await proposed(ports)
        await expect(service.decide(base, decision(snapshot))).resolves.toMatchObject({ status: 'uncertain' })
        const controller = new AbortController()
        controller.abort()
        const cancelled = fixture({ execute: vi.fn(() => new Promise(() => {})) })
        const next = await proposed(cancelled.ports)
        await expect(next.service.decide(base, decision(next.snapshot), controller.signal)).resolves.toMatchObject({ status: 'cancelled' })
    })
})
