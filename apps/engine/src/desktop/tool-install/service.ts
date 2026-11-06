import {
    DESKTOP_TOOL_INSTALL_DEADLINE_MS,
    desktopToolInstallGuestId,
    desktopToolInstallOperationId,
    type DesktopToolInstallDecision,
    type DesktopToolInstallGuestResult,
    type DesktopToolInstallInspect,
    type DesktopToolInstallPackage,
    type DesktopToolInstallPackageOutcome,
    type DesktopToolInstallPorts,
    type DesktopToolInstallRunIdentity,
    type DesktopToolInstallSnapshot,
} from '@rerun/contracts'
import { abortable } from '../web-fetch/transport.js'

type BaseIdentity = Omit<DesktopToolInstallRunIdentity, 'guest'>
type Options = { deadlineMs?: number; now?: () => string }

function sanitize(value: string, max: number): string {
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max)
}

function next(snapshot: DesktopToolInstallSnapshot, patch: Partial<DesktopToolInstallSnapshot>, now: () => string): DesktopToolInstallSnapshot {
    return { ...snapshot, ...patch, revision: String(Number(snapshot.revision) + 1), updatedAt: now() }
}

function resultOf(result: DesktopToolInstallGuestResult, previous: DesktopToolInstallSnapshot, now: () => string): DesktopToolInstallSnapshot {
    const packages: DesktopToolInstallPackageOutcome[] = previous.packages.map(target => {
        const outcome = result.packages.find(item => item.package === target.package)
        if (!outcome) return { ...target, status: 'uncertain', message: 'No outcome was returned for this package.' }
        if (outcome.status === 'installed' && (!outcome.manifestSha256 || !outcome.lockSha256) return { ...outcome, status: 'uncertain', message: 'Installation evidence is incomplete.' }
        return outcome
    })
    const installed = packages.filter(item => item.status === 'installed').length
    const failed = packages.filter(item => item.status === 'failed').length
    const uncertain = packages.length - installed - failed
    const status = result.status === 'cancelled' ? 'cancelled'
        : installed === packages.length && result.status === 'installed' ? 'installed'
        : installed > 0 ? 'partial'
        : result.status === 'failed' && failed === packages.length ? 'failed'
        : uncertain === packages.length && result.status === 'uncertain' ? 'uncertain'
        : 'partial'
    return next(previous, {
        status,
        packages,
        ...(result.output === undefined ? {} : { output: sanitize(result.output, 20_000) }),
        ...(result.message === undefined ? {} : { message: sanitize(result.message, 1_000) }),
    }, now)
}

export function createDesktopToolInstallService(ports: DesktopToolInstallPorts, options: Options = {}) {
    const deadlineMs = options.deadlineMs ?? DESKTOP_TOOL_INSTALL_DEADLINE_MS
    const now = options.now ?? (() => new Date().toISOString())
    const active = new Map<string, { key: string; work: Promise<DesktopToolInstallSnapshot> }>()

    function signalFor(parent: AbortSignal | undefined): { signal: AbortSignal; close: () => void } {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new Error('Deadline exceeded')), deadlineMs)
        const cancel = () => controller.abort(parent?.reason ?? new Error('Cancelled'))
        parent?.addEventListener('abort', cancel, { once: true })
        if (parent?.aborted) cancel()
        return { signal: controller.signal, close: () => { clearTimeout(timer); parent?.removeEventListener('abort', cancel) } }
    }

    function complete(identity: DesktopToolInstallRunIdentity, snapshot: DesktopToolInstallSnapshot, signal: AbortSignal): Promise<void> {
        return abortable(ports.outcomes.complete(identity, snapshot), signal)
    }

    function readOutcome(operationId: string, signal: AbortSignal): Promise<DesktopToolInstallSnapshot | null> {
        return abortable(ports.outcomes.read(operationId), signal)
    }

    function executeGuest(identity: DesktopToolInstallRunIdentity, signal: AbortSignal): Promise<DesktopToolInstallGuestResult> {
        return abortable(ports.guest.execute(identity, signal), signal)
    }

    function inspectGuest(identity: DesktopToolInstallRunIdentity, signal: AbortSignal): Promise<DesktopToolInstallGuestResult> {
        return abortable(ports.guest.inspect(identity, signal), signal)
    }

    async function identify(base: BaseIdentity, signal: AbortSignal): Promise<DesktopToolInstallRunIdentity> {
        const guest = await abortable(ports.authority(base, signal), signal)
        return { ...base, guest }
    }

    function assertSource(snapshot: DesktopToolInstallSnapshot, identity: DesktopToolInstallRunIdentity, operationId: string, packages: DesktopToolInstallPackage[]): void {
        if (snapshot.operationId !== operationId || snapshot.agentId !== identity.agentId || snapshot.sessionId !== identity.sessionId || snapshot.runId !== identity.runId || snapshot.toolCallId !== identity.toolCallId) throw new Error('This installation belongs to another coworker, chat or proposal.')
        if (snapshot.packages.length !== packages.length || snapshot.packages.some((item, index) => item.package !== packages[index])) throw new Error('The reviewed package targets changed.')
    }

    async function propose(base: BaseIdentity, input: { packages: DesktopToolInstallPackage[] }, parentSignal?: AbortSignal): Promise<DesktopToolInstallSnapshot> {
        const { signal, close } = signalFor(parentSignal)
        try {
            const identity = await identify(base, signal)
            const operationId = await desktopToolInstallOperationId(identity, input.packages)
            const existing = await abortable(ports.outcomes.begin(identity, operationId, input.packages), signal)
            if (existing !== 'execute') return existing
            const snapshot: DesktopToolInstallSnapshot = {
                operationId,
                agentId: identity.agentId,
                sessionId: identity.sessionId,
                runId: identity.runId,
                toolCallId: identity.toolCallId,
                proposalRevision: identity.proposalRevision,
                revision: '1',
                status: 'pending-approval',
                packages: input.packages.map(packageTarget => ({ package: packageTarget, status: 'pending' })),
                guestId: await desktopToolInstallGuestId(identity.guest),
                availability: 'isolated-guest-only',
                createdAt: now(),
                updatedAt: now(),
            }
            await complete(identity, snapshot, signal)
            return snapshot
        } finally { close() }
    }

    async function decide(base: BaseIdentity, input: DesktopToolInstallDecision, parentSignal?: AbortSignal): Promise<DesktopToolInstallSnapshot> {
        const key = JSON.stringify([input.decision, input.note ?? ''])
        const pending = active.get(input.operationId)
        if (pending) {
            if (pending.key !== key) throw new Error('A different decision is already in progress for this installation.')
            return pending.work
        }
        const work = (async () => {
            const { signal, close } = signalFor(parentSignal)
            try {
                const current = await readOutcome(input.operationId, signal)
                if (!current || current.revision !== input.expectedRevision) throw new Error('This installation changed. Refresh the review and try again.')
                if (current.status !== 'pending-approval') return current
                const identity = await identify(base, signal)
                const packages = current.packages.map(item => item.package)
                const operationId = await desktopToolInstallOperationId(identity, packages)
                assertSource(current, identity, operationId, packages)
                if (input.decision === 'declined') {
                    const declined = next(current, { status: 'declined', ...(input.note ? { message: sanitize(input.note, 1_000) } : {}) }, now)
                    await complete(identity, declined, signal)
                    return declined
                }
                const approved = next(current, { status: 'approved' }, now)
                await complete(identity, approved, signal)
                return executeApproved(identity, approved, signal)
            } finally { close() }
        })()
        active.set(input.operationId, { key, work })
        try { return await work } finally { active.delete(input.operationId) }
    }

    async function executeApproved(identity: DesktopToolInstallRunIdentity, approved: DesktopToolInstallSnapshot, signal: AbortSignal): Promise<DesktopToolInstallSnapshot> {
        const installing = next(approved, { status: 'installing', packages: approved.packages.map(item => ({ ...item, status: 'installing' })) }, now)
        try {
            await complete(identity, installing, signal)
            const guest = await abortable(ports.authority(identity, signal), signal)
            if (JSON.stringify(guest) !== JSON.stringify(identity.guest)) throw new Error('The isolated computer changed before installation.')
            const result = await executeGuest(identity, signal)
            const completed = resultOf(result, installing, now)
            await complete(identity, completed, signal)
            return completed
        } catch (error) {
            if (signal.aborted) {
                const cancelled = next(installing, { status: 'cancelled', message: 'Installation was cancelled.' }, now)
                await complete(identity, cancelled, signal).catch(() => undefined)
                return cancelled
            }
            const uncertain = next(installing, {
                status: 'uncertain',
                message: error instanceof Error && error.message === 'Deadline exceeded'
                    ? 'Installation timed out. Inspect it before trying again.'
                    : 'Installation outcome is uncertain. Inspect it in the same isolated computer; do not reinstall automatically.',
            }, now)
            await complete(identity, uncertain, signal).catch(() => undefined)
            return uncertain
        }
    }

    async function inspect(base: BaseIdentity, input: DesktopToolInstallInspect, parentSignal?: AbortSignal): Promise<DesktopToolInstallSnapshot> {
        const { signal, close } = signalFor(parentSignal)
        try {
            const current = await readOutcome(input.operationId, signal)
            if (!current || current.revision !== input.expectedRevision) throw new Error('This installation changed. Refresh its state and try again.')
            if (!['installing', 'uncertain', 'interrupted'].includes(current.status)) return current
            const identity = await identify(base, signal)
            const packages = current.packages.map(item => item.package)
            const operationId = await desktopToolInstallOperationId(identity, packages)
            assertSource(current, identity, operationId, packages)
            const result = await inspectGuest(identity, signal)
            const completed = resultOf(result, current, now)
            await complete(identity, completed, signal)
            return completed
        } finally { close() }
    }

    const read = (operationId: string) => ports.outcomes.read(operationId)
    return { propose, decide, inspect, read }
}

export type DesktopToolInstallService = ReturnType<typeof createDesktopToolInstallService>
