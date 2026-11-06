import { createHash } from 'node:crypto'
import {
    desktopGuestShellInputSchema,
    desktopGuestShellReceiptSchema,
    desktopGuestShellResultSchema,
    type DesktopGuestShellIdentity,
    type DesktopGuestShellInput,
    type DesktopGuestShellReceipt,
    type DesktopGuestShellResult,
} from '@rerun/contracts'
import type { DesktopGuestShellAuthority, DesktopGuestShellPackageAuthority, DesktopGuestShellStore, DesktopGuestShellTransport } from './types.js'

type BaseIdentity = Omit<DesktopGuestShellIdentity, 'guest'>
type Dependencies = {
    authority: DesktopGuestShellAuthority
    transport: DesktopGuestShellTransport
    store: DesktopGuestShellStore
    packageAuthority?: DesktopGuestShellPackageAuthority
    publicText?: (text: string) => string
}

function projectResult(deps: Dependencies, result: DesktopGuestShellResult): DesktopGuestShellResult {
    const project = deps.publicText ?? (text => text.replace(/(bearer|token|key|secret|password)([=: ]+)\S+/gi, '$1$2***')
    return {
        ...result,
        stdout: project(result.stdout).slice(0, 50_000),
        stderr: project(result.stderr).slice(0, 50_000),
        ...(result.message === undefined ? {} : { message: project(result.message).slice(0, 1000) }),
    }
}

function receiptOf(result: DesktopGuestShellResult, identity: DesktopGuestShellIdentity, fingerprint = createHash('sha256').update(JSON.stringify([identity.agentId, identity.sessionId, identity.runId, identity.toolCallId, identity.requestId, identity.guest])).digest('hex')): DesktopGuestShellReceipt {
    return desktopGuestShellReceiptSchema.parse({ ...result, identity, fingerprint })
}

export function createDesktopGuestShellService(deps: Dependencies) {
    const active = new Map<string, { key: string; work: Promise<DesktopGuestShellReceipt> }>()

    async function identify(base: BaseIdentity, signal: AbortSignal): Promise<DesktopGuestShellIdentity> {
        const guest = await deps.authority(base, signal)
        return { ...base, guest }
    }

    function assertSource(receipt: DesktopGuestShellReceipt, identity: DesktopGuestShellIdentity): void {
        if (receipt.identity.agentId !== identity.agentId || receipt.identity.sessionId !== identity.sessionId || receipt.identity.runId !== identity.runId || receipt.identity.toolCallId !== identity.toolCallId || receipt.identity.requestId !== identity.requestId) throw new Error('This command belongs to another coworker, chat or invocation.')
        if (JSON.stringify(receipt.identity.guest) !== JSON.stringify(identity.guest)) throw new Error('The isolated computer changed before command reconciliation.')
    }

    async function execute(base: BaseIdentity, raw: DesktopGuestShellInput, parentSignal: AbortSignal): Promise<DesktopGuestShellReceipt> {
        const input = desktopGuestShellInputSchema.parse(raw)
        const key = JSON.stringify(input)
        const pending = active.get(base.requestId)
        if (pending) {
            if (pending.key !== key) throw new Error('A different command is already using this request identity.')
            return pending.work
        }
        const work = (async () => {
            const identity = await identify(base, parentSignal)
            const request = { ...identity, ...input }
            let packageEvidence: DesktopGuestShellResult['packageEvidence']
            if (input.packages) {
                if (!deps.packageAuthority) throw new Error('Reviewed package evidence is unavailable for this command.')
                const evidence = await deps.packageAuthority(identity.guest, input.packages, parentSignal)
                if (evidence.length !== input.packages.length || input.packages.some((target, index) => evidence[index]?.package !== target)) throw new Error('A required reviewed package is not installed in this guest.')
                packageEvidence = [...evidence]
            }
            const fingerprint = createHash('sha256').update(JSON.stringify([identity.agentId, identity.sessionId, identity.runId, identity.toolCallId, identity.requestId, identity.guest, input])).digest('hex')
            const initial = receiptOf({ requestId: base.requestId, status: 'interrupted', stdout: '', stderr: '', exitCode: null, durationMs: 0, message: 'Command was interrupted before execution.' }, identity, fingerprint)
            const existing = await deps.store.begin(request, initial)
            if (existing !== 'execute') {
                if (existing.fingerprint !== fingerprint) throw new Error('This request identity belongs to a different command.')
                return existing
            }
            try {
                const result = desktopGuestShellResultSchema.parse(projectResult(deps, await deps.transport.execute(request, parentSignal)))
                const receipt = receiptOf({ ...result, ...(packageEvidence ? { packageEvidence } : {}) }, identity, fingerprint)
                await deps.store.complete(identity, receipt)
                return receipt
            } catch (error) {
                if (parentSignal.aborted) {
                    await deps.transport.cancel(identity, parentSignal).catch(() => undefined)
                    const cancelled = receiptOf({ requestId: base.requestId, status: 'cancelled', stdout: '', stderr: '', exitCode: null, durationMs: 0, message: 'Command was cancelled.' }, identity, fingerprint)
                    await deps.store.complete(identity, cancelled).catch(() => undefined)
                    return cancelled
                }
                const interrupted = receiptOf({ requestId: base.requestId, status: 'interrupted', stdout: '', stderr: '', exitCode: null, durationMs: 0, message: 'Command outcome is uncertain. Inspect the same guest request; do not execute it again.' }, identity, fingerprint)
                await deps.store.complete(identity, interrupted).catch(() => undefined)
                return interrupted
            }
        })()
        active.set(base.requestId, { key, work })
        try { return await work } finally { active.delete(base.requestId) }
    }

    async function inspect(base: BaseIdentity, parentSignal: AbortSignal): Promise<DesktopGuestShellReceipt> {
        const identity = await identify(base, parentSignal)
        const existing = await deps.store.read(base.requestId)
        if (existing) {
            assertSource(existing, identity)
            return existing
        }
        const result = projectResult(deps, await deps.transport.inspect(identity, parentSignal)
        const receipt = receiptOf(result, identity)
        await deps.store.complete(identity, receipt)
        return receipt
    }

    async function stop(base: BaseIdentity, parentSignal: AbortSignal): Promise<DesktopGuestShellReceipt> {
        const identity = await identify(base, parentSignal)
        await deps.transport.cancel(identity, parentSignal)
        const result = projectResult(deps, await deps.transport.inspect(identity, parentSignal)
        const receipt = receiptOf(result, identity)
        await deps.store.complete(identity, receipt)
        return receipt
    }

    return { execute, inspect, stop, read: (requestId: string) => deps.store.read(requestId) }
}

export type DesktopGuestShellService = ReturnType<typeof createDesktopGuestShellService>
