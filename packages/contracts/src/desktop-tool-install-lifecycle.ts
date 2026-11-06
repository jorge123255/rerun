import {
    DESKTOP_TOOL_INSTALL_DEADLINE_MS, desktopToolInstallGuestId, desktopToolInstallOperationId,
    desktopToolInstallInputSchema, desktopToolInstallGuestResultSchema, desktopToolInstallSnapshotSchema,
    type DesktopToolInstallAction, type DesktopToolInstallDecision, type DesktopToolInstallInspect,
    type DesktopToolInstallOperation, type DesktopToolInstallPackage, type DesktopToolInstallPorts,
    type DesktopToolInstallRunIdentity, type DesktopToolInstallSnapshot,
} from './desktop-tool-install.js'

type BaseIdentity = Omit<DesktopToolInstallRunIdentity, 'guest'>
const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
const sameSource = (a: BaseIdentity, b: BaseIdentity) => a.agentId === b.agentId && a.sessionId === b.sessionId && a.runId === b.runId && a.toolCallId === b.toolCallId && a.proposalRevision === b.proposalRevision
const next = (row: DesktopToolInstallSnapshot, patch: Partial<DesktopToolInstallSnapshot>, now: () => string): DesktopToolInstallSnapshot => desktopToolInstallSnapshotSchema.parse({ ...row, ...patch, revision: String(BigInt(row.revision) + 1n), updatedAt: now() })

export function createDesktopToolInstallService(ports: DesktopToolInstallPorts, options: { deadlineMs?: number; now?: () => string } = {}) {
    const now = options.now ?? (() => new Date().toISOString())
    function signalFor(parent?: AbortSignal) { return AbortSignal.any([AbortSignal.timeout(options.deadlineMs ?? DESKTOP_TOOL_INSTALL_DEADLINE_MS), ...(parent ? [parent] : [])]) }
    async function operation(base: BaseIdentity, id: string, signal: AbortSignal, phase: 'review' | 'inspect'): Promise<DesktopToolInstallOperation> {
        signal.throwIfAborted()
        const saved = await ports.outcomes.reservation(id)
        if (!saved || !sameSource(saved.identity, base)) throw new Error('This installation belongs to another proposal.')
        const guest = await ports.authority(base, signal, phase)
        signal.throwIfAborted()
        if (await desktopToolInstallGuestId(guest) !== await desktopToolInstallGuestId(saved.identity.guest)) throw new Error('The isolated computer changed. This proposal cannot install into its replacement.')
        return saved
    }
    function resultOf(raw: unknown, previous: DesktopToolInstallSnapshot): DesktopToolInstallSnapshot {
        const result = desktopToolInstallGuestResultSchema.parse(raw)
        const targets = previous.packages.map(item => item.package)
        if (result.packages.length !== targets.length || new Set(result.packages.map(item => item.package)).size !== targets.length || result.packages.some(item => !targets.includes(item.package))) throw new Error('Guest package evidence did not match the reviewed targets.')
        const packages = targets.map(target => {
            const item = result.packages.find(row => row.package === target)!
            if (item.status === 'installed' && (!item.manifestSha256 || !item.lockSha256)) return { package: target, status: 'uncertain' as const, message: 'Installation evidence is incomplete.' }
            return { ...item, ...(item.message === undefined ? {} : { message: clean(item.message) }) }
        })
        const all = (status: string) => packages.every(item => item.status === status)
        const status = result.status === 'installed' && all('installed') ? 'installed'
            : result.status === 'failed' && all('failed') ? 'failed'
            : result.status === 'cancelled' && !packages.some(item => item.status === 'installed') ? 'cancelled'
            : packages.some(item => item.status === 'installed') ? 'partial' : 'uncertain'
        return next(previous, { status, packages, ...(result.output === undefined ? {} : { output: clean(result.output) }), ...(result.message === undefined ? {} : { message: clean(result.message) }) }, now)
    }
    async function propose(base: BaseIdentity, raw: { packages: DesktopToolInstallPackage[] }, parent?: AbortSignal) {
        const input = desktopToolInstallInputSchema.parse(raw), signal = signalFor(parent)
        signal.throwIfAborted()
        const guest = await ports.authority(base, signal, 'propose'); signal.throwIfAborted()
        const identity = { ...base, guest }, operationId = await desktopToolInstallOperationId(identity, input.packages)
        const prior = await ports.outcomes.begin(identity, operationId, input.packages)
        if (prior !== 'execute') return prior
        const snapshot: DesktopToolInstallSnapshot = { ...base, operationId, revision: '1', status: 'pending-approval', packages: input.packages.map(packageTarget => ({ package: packageTarget, status: 'pending' })), guestId: await desktopToolInstallGuestId(guest), availability: 'isolated-guest-only', createdAt: now(), updatedAt: now() }
        await ports.outcomes.complete(identity, snapshot)
        return snapshot
    }
    async function settle(op: DesktopToolInstallOperation, current: DesktopToolInstallSnapshot, action: DesktopToolInstallAction, signal: AbortSignal, execute: boolean) {
        let completed: DesktopToolInstallSnapshot
        try {
            signal.throwIfAborted()
            const fresh = await ports.authority(op.identity, signal, execute ? 'review' : 'inspect')
            if (await desktopToolInstallGuestId(fresh) !== await desktopToolInstallGuestId(op.identity.guest)) throw new Error('The isolated computer changed.')
            signal.throwIfAborted()
            // Guest adapters resolve/reject only after cancellation has drained. Never race that promise.
            const result = await (execute ? ports.guest.execute(op, signal) : ports.guest.inspect(op, signal))
            completed = resultOf(result, current)
        } catch {
            completed = next(current, { status: 'uncertain', packages: current.packages.map(item => item.status === 'installed' ? item : { package: item.package, status: 'uncertain' }), message: 'The installation result is not confirmed. Inspect it before trying anything else.' }, now)
        }
        try { await ports.outcomes.complete(op.identity, completed) }
        catch {
            // Another explicit inspection may have sealed a newer result. Never report an unacknowledged local outcome.
            const saved = await ports.outcomes.read(op.operationId)
            if (!saved) throw new Error('The installation receipt could not be confirmed.')
            completed = saved
        }
        await ports.outcomes.finishRequest(op.identity, action, completed)
        return completed
    }
    async function replay(base: BaseIdentity, action: DesktopToolInstallAction) {
        const saved = await ports.outcomes.reservation(action.operationId)
        if (!saved || !sameSource(saved.identity, base)) throw new Error('This installation belongs to another proposal.')
        return ports.outcomes.replay(saved.identity, action)
    }
    async function decide(base: BaseIdentity, action: DesktopToolInstallDecision, parent?: AbortSignal) {
        parent?.throwIfAborted()
        const prior = await replay(base, action); if (prior) return prior
        if (action.decision === 'declined') {
            const saved = await ports.outcomes.reservation(action.operationId)
            if (!saved || !sameSource(saved.identity, base)) throw new Error('This installation belongs to another proposal.')
            return (await ports.outcomes.claim(saved.identity, action)).snapshot
        }
        const signal = signalFor(parent), op = await operation(base, action.operationId, signal, 'review')
        const claim = await ports.outcomes.claim(op.identity, action)
        if (!claim.claimed) return claim.snapshot
        const installing = next(claim.snapshot, { status: 'installing', packages: claim.snapshot.packages.map(item => ({ ...item, status: 'installing' })) }, now)
        await ports.outcomes.complete(op.identity, installing)
        return settle(op, installing, action, signal, true)
    }
    async function inspect(base: BaseIdentity, action: DesktopToolInstallInspect, parent?: AbortSignal) {
        const prior = await replay(base, action); if (prior) return prior
        const signal = signalFor(parent), op = await operation(base, action.operationId, signal, 'inspect')
        const claim = await ports.outcomes.claim(op.identity, action)
        if (!claim.claimed) return claim.snapshot
        return settle(op, claim.snapshot, action, signal, false)
    }
    return { propose, decide, inspect, read: (id: string) => ports.outcomes.read(id) }
}
export type DesktopToolInstallService = ReturnType<typeof createDesktopToolInstallService>
