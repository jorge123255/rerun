import { createHash } from 'node:crypto'
import { desktopGuestShellInputSchema, desktopGuestShellIdentitySchema, desktopGuestShellReceiptSchema, desktopGuestShellResultSchema, type DesktopGuestShellIdentity, type DesktopGuestShellInput, type DesktopGuestShellReceipt, type DesktopGuestShellResult } from '@rerun/contracts'
import type { DesktopGuestShellAuthority, DesktopGuestShellPackageAuthority, DesktopGuestShellStore, DesktopGuestShellTransport } from './types.js'
type BaseIdentity = Omit<DesktopGuestShellIdentity, 'guest'>
export type DesktopGuestShellDependencies = { authority: DesktopGuestShellAuthority; transport: DesktopGuestShellTransport; store: DesktopGuestShellStore; packageAuthority?: DesktopGuestShellPackageAuthority; publicText?: (text: string) => string }
export const isFinalGuestShellReceipt = (value: DesktopGuestShellReceipt) => !['interrupted', 'unavailable'].includes(value.status)
const baseKey = (base: BaseIdentity) => JSON.stringify([base.agentId, base.sessionId, base.runId, base.toolCallId, base.requestId])
const sameGuest = (a: DesktopGuestShellIdentity['guest'], b: DesktopGuestShellIdentity['guest']) => a.engineAgentId === b.engineAgentId && a.launchNonce === b.launchNonce && a.sessionGeneration === b.sessionGeneration && a.workspaceFingerprint === b.workspaceFingerprint
export function createDesktopGuestShellService(deps: DesktopGuestShellDependencies) {
    const active = new Map<string, { key: string; work: Promise<DesktopGuestShellReceipt> }>()
    const publicText = deps.publicText ?? ((text: string) => text.replace(/(bearer|token|key|secret|password)([=: ]+)\S+/gi, '$1$2***'))
    function result(raw: unknown, identity: DesktopGuestShellIdentity, fingerprint: string) {
        const value = desktopGuestShellResultSchema.parse(raw)
        if (value.requestId !== identity.requestId) throw new Error('Guest command acknowledgement changed')
        return desktopGuestShellReceiptSchema.parse({ ...value, stdout: publicText(value.stdout).slice(0, 50000), stderr: publicText(value.stderr).slice(0, 50000), ...(value.message ? { message: publicText(value.message).slice(0, 1000) } : {}), identity, fingerprint })
    }
    function assertBase(receipt: DesktopGuestShellReceipt, base: BaseIdentity) { if (baseKey(receipt.identity) !== baseKey(base)) throw new Error('This command belongs to another invocation.') }
    async function authorize(identity: DesktopGuestShellIdentity, signal: AbortSignal, phase: 'execute' | 'inspect') {
        signal.throwIfAborted(); const guest = await deps.authority(identity, signal, phase); signal.throwIfAborted()
        if (!sameGuest(guest, identity.guest)) throw new Error('The isolated computer changed.')
    }
    async function reconcile(existing: DesktopGuestShellReceipt, signal: AbortSignal) {
        if (isFinalGuestShellReceipt(existing)) return existing
        await authorize(existing.identity, signal, 'inspect')
        const recovered = result(await deps.transport.inspect(existing.identity, signal), existing.identity, existing.fingerprint)
        await authorize(existing.identity, signal, 'inspect')
        await deps.store.complete(existing.identity, recovered)
        return recovered
    }
    async function execute(base: BaseIdentity, raw: DesktopGuestShellInput, signal: AbortSignal): Promise<DesktopGuestShellReceipt> {
        signal.throwIfAborted()
        const input = desktopGuestShellInputSchema.parse(raw), key = JSON.stringify([baseKey(base), input])
        const pending = active.get(base.requestId)
        if (pending) { if (pending.key !== key) throw new Error('Another invocation owns this command request.'); return pending.work }
        const work = (async () => {
            const existing = await deps.store.read(base.requestId)
            signal.throwIfAborted()
            if (existing) {
                assertBase(existing, base)
                const fingerprint = createHash('sha256').update(JSON.stringify([baseKey(base), existing.identity.guest, input])).digest('hex')
                if (existing.fingerprint !== fingerprint) throw new Error('This request belongs to a different command.')
                return reconcile(existing, signal)
            }
            const identity = desktopGuestShellIdentitySchema.parse({ agentId: base.agentId, sessionId: base.sessionId, runId: base.runId, toolCallId: base.toolCallId, requestId: base.requestId, guest: await deps.authority(base, signal, 'execute') })
            signal.throwIfAborted()
            const fingerprint = createHash('sha256').update(JSON.stringify([baseKey(base), identity.guest, input])).digest('hex')
            const evidence = input.packages?.length ? await deps.packageAuthority?.(identity.guest, input.packages, signal) : undefined
            if (input.packages?.length && (!evidence || evidence.length !== input.packages.length || input.packages.some((item, i) => evidence[i]?.package !== item))) throw new Error('A required reviewed package is unavailable in this guest.')
            const initial = result({ requestId: base.requestId, status: 'interrupted', stdout: '', stderr: '', exitCode: null, durationMs: 0, message: 'Command was reserved. Inspect this request before retrying.' }, identity, fingerprint)
            const request = { ...identity, ...input, fingerprint, ...(evidence ? { expectedPackageEvidence: [...evidence] } : {}) }
            const reserved = await deps.store.begin(request, initial)
            if (reserved !== 'execute') { assertBase(reserved, base); if (reserved.fingerprint !== fingerprint) throw new Error('This request belongs to a different command.'); return reconcile(reserved, signal) }
            let dispatched = false
            try {
                await authorize(identity, signal, 'execute')
                dispatched = true
                const completed = result(await deps.transport.execute(request, signal), identity, fingerprint)
                await authorize(identity, signal, 'execute')
                await deps.store.complete(identity, completed)
                return completed
            } catch (error) {
                if (!dispatched) throw error
                let receipt = initial
                if (signal.aborted) {
                    try {
                        await deps.transport.cancel(identity, AbortSignal.timeout(25000))
                        receipt = result({ requestId: base.requestId, status: 'cancelled', stdout: '', stderr: '', exitCode: null, durationMs: 0, message: 'The isolated command was stopped.' }, identity, fingerprint)
                    } catch { /* Unknown drain is never represented as cancelled. Native transport quarantines its exact guest. */ }
                }
                await deps.store.complete(identity, receipt)
                return receipt
            }
        })()
        active.set(base.requestId, { key, work })
        try { return await work } finally { if (active.get(base.requestId)?.work === work) active.delete(base.requestId) }
    }
    async function inspect(base: BaseIdentity, signal: AbortSignal) {
        signal.throwIfAborted()
        const existing = await deps.store.read(base.requestId)
        if (!existing) throw new Error('No original command receipt exists.')
        assertBase(existing, base)
        return reconcile(existing, signal)
    }
    async function stop(base: BaseIdentity, signal: AbortSignal) {
        signal.throwIfAborted()
        const existing = await deps.store.read(base.requestId)
        if (!existing) throw new Error('No original command receipt exists.')
        assertBase(existing, base)
        if (isFinalGuestShellReceipt(existing)) return existing
        await deps.transport.cancel(existing.identity, signal)
        const settled = await deps.store.read(base.requestId)
        if (settled && isFinalGuestShellReceipt(settled)) { assertBase(settled, base); return settled }
        const cancelled = result({ requestId: base.requestId, status: 'cancelled', stdout: '', stderr: '', exitCode: null, durationMs: 0, message: 'The isolated command was stopped.' }, existing.identity, existing.fingerprint)
        await deps.store.complete(existing.identity, cancelled)
        return cancelled
    }
    return { execute, inspect, stop, read: (requestId: string) => deps.store.read(requestId) }
}
export type DesktopGuestShellService = ReturnType<typeof createDesktopGuestShellService>
