import 'server-only'
import { createHash } from 'node:crypto'
import { serviceTransportControlSchema, serviceTransportRefSchema, serviceTransportReceiptSchema, SERVICE_TRANSPORT_LIMITS as L, type ServiceTransportControl, type ServiceTransportRef, type ServiceTransportReceipt, type ServiceTransportSnapshot } from '@rerun/contracts'
import { boundedJson, validateSseResult, validateSseTools } from '../../mcp-sse/validation'
import { wait } from '../../mcp-sse/errors'
import { TransportFailure } from './compiler'
import { resolveTransportMaterial } from './resolve'
import type { TransportDependencies, TransportAuthority, TransportReceiptKey, TrustedRun, Invocation, DriverContext } from './types'
const same = (a: ServiceTransportRef, b: ServiceTransportRef) => a.agentId === b.agentId && a.key === b.key && a.installationId === b.installationId && a.revision === b.revision
const failure = (error: unknown): TransportFailure['code'] => error instanceof TransportFailure ? error.code : 'unavailable'
function ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ordered)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, ordered(v)]))
    return value
}
export function createServiceTransports(deps: TransportDependencies) {
    async function authorize(ref: ServiceTransportRef, action: 'read' | 'discover' | 'call' | 'close', signal: AbortSignal, run?: TrustedRun) {
        signal.throwIfAborted()
        const a = await wait(deps.authority(ref, action, run, signal), signal)
        a.check(); signal.throwIfAborted()
        if (!same(a.ref, ref) || !same(a.plan.ref, ref) || a.plan.methodId !== a.methodId || !a.configurationGeneration || !a.credentialGeneration || run && run.engineAgentId !== a.engineOwnerId) throw new TransportFailure('changed')
        if (action === 'discover' || action === 'call') {
            if (!a.enabled || !a.appsGranted || (a.plan.transport === 'sse' ? !a.remoteGranted : !a.programGranted)) throw new TransportFailure('grant')
        }
        return a
    }
    async function current(a: TransportAuthority, action: 'read' | 'discover' | 'call' | 'close', signal: AbortSignal, run?: TrustedRun) {
        const next = await authorize(a.ref, action, signal, run)
        a.check()
        if (next.configurationGeneration !== a.configurationGeneration || next.credentialGeneration !== a.credentialGeneration || next.engineOwnerId !== a.engineOwnerId || next.methodId !== a.methodId) throw new TransportFailure('changed')
    }
    function snapshot(a: TransportAuthority, state: ServiceTransportSnapshot['state'], tools: ServiceTransportSnapshot['tools'] = [], observation: ServiceTransportSnapshot['observation'] = 'saved', receipt?: ServiceTransportReceipt): ServiceTransportSnapshot {
        return { ref: a.ref, methodId: a.methodId, transport: a.plan.transport, state, tools, observation, ...(receipt ? { receipt, ...(receipt.failure ? { failure: receipt.failure } : {}) } : {}) }
    }
    function receipt(key: TransportReceiptKey, outcome: ServiceTransportReceipt['outcome'], state: ServiceTransportReceipt['state'], code?: TransportFailure['code']): ServiceTransportReceipt {
        return { ref: key.ref, requestId: key.requestId, action: key.action, outcome, state, ...(code ? { failure: code } : {}) }
    }
    function fingerprint(key: TransportReceiptKey, extra: unknown = null) {
        return createHash('sha256').update(JSON.stringify(ordered([key, extra]))).digest('hex')
    }
    async function claim(key: TransportReceiptKey, digest: string, signal: AbortSignal) {
        try { return await wait(deps.receipts.claim(key, digest, signal), signal) }
        catch { throw new TransportFailure('unknown') }
    }
    async function settle(key: TransportReceiptKey, digest: string, result: ServiceTransportReceipt) {
        try { await wait(deps.receipts.settle(key, digest, result), AbortSignal.timeout(L.closeMs)); return result }
        catch { return receipt(key, 'uncertain', 'uncertain', 'unknown') }
    }
    async function previous(key: TransportReceiptKey, signal: AbortSignal) {
        try {
            const value = await wait(deps.receipts.read(key, signal), signal)
            if (value) {
                const r = serviceTransportReceiptSchema.parse(value)
                if (!same(r.ref, key.ref) || r.requestId !== key.requestId || r.action !== key.action) throw new TransportFailure('changed')
                return r
            }
        } catch { /* An unreadable receipt never authorizes another effect. */ }
        return receipt(key, 'uncertain', 'uncertain', 'unknown')
    }
    async function operation<T>(a: TransportAuthority, key: TransportReceiptKey, signal: AbortSignal, run: TrustedRun | undefined, work: (context: DriverContext) => Promise<T>) {
        const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal, deps.shutdownSignal, AbortSignal.timeout(L.operationMs)])
        const ticket = deps.operations.admit(key, controller)
        const guard = async () => {
            ticket.check(); a.check(); combined.throwIfAborted()
            const current = await authorize(a.ref, key.action === 'call' ? 'call' : 'discover', combined, run)
            if (current.methodId !== a.methodId || current.configurationGeneration !== a.configurationGeneration || current.credentialGeneration !== a.credentialGeneration || current.engineOwnerId !== a.engineOwnerId) throw new TransportFailure('changed')
            ticket.check(); a.check(); combined.throwIfAborted()
        }
        const workTask = (async () => {
            await guard()
            const material = await resolveTransportMaterial(a, deps.values, deps.programs, guard, combined)
            await guard()
            const result = await work({ authority: a, material, signal: combined, guard })
            await guard(); return result
        })()
        // Admission remains held until late work settles; root mutations cannot overtake it.
        void workTask.finally(() => ticket.release()).catch(() => {})
        try { return await wait(workTask, combined) }
        catch (error) { controller.abort(); throw error }
    }
    const boundedSignal = (signal: AbortSignal) => AbortSignal.any([signal, deps.shutdownSignal, AbortSignal.timeout(L.operationMs)])
    async function status(ref: ServiceTransportRef, signal: AbortSignal) {
        signal = boundedSignal(signal)
        const a = await authorize(serviceTransportRefSchema.parse(ref), 'read', signal)
        if (!a.enabled || !a.appsGranted || (a.plan.transport === 'sse' ? !a.remoteGranted : !a.programGranted)) return { ...snapshot(a, 'unavailable'), failure: 'grant' as const }
        const observed = await wait(deps.drivers[a.plan.transport].status(a, signal), signal)
        await current(a, 'read', signal)
        // Status is an observation only. It cannot unseal, resolve DNS, or start a process.
        const listed = observed.state === 'healthy' ? await tools(a, observed.tools) : []
        await current(a, 'read', signal)
        return { ...snapshot(a, observed.state, listed, 'saved'), ...(observed.failure ? { failure: observed.failure } : {}) }
    }
    async function tools(a: TransportAuthority, raw: unknown[]) {
        const safe = deps.protect(raw, a)
        if (!Array.isArray(safe)) throw new TransportFailure('invalid')
        const checked = validateSseTools(safe, [], a.plan.serverName, deps.normalizeTool)
        await deps.assertToolNames(checked.map(t => `${a.plan.serverName}_${t.name}`), a.ref)
        return checked
    }
    async function discover(ref: ServiceTransportRef, requestId: string, mode: 'probe' | 'reconnect' | 'run', signal: AbortSignal, run?: TrustedRun) {
        signal = boundedSignal(signal); serviceTransportControlSchema.shape.requestId.parse(requestId); serviceTransportRefSchema.parse(ref)
        const a = await authorize(ref, run ? 'call' : 'discover', signal, run)
        const key: TransportReceiptKey = { ref, requestId, action: mode === 'probe' ? 'probe' : 'reconnect', ...(run ? { run } : {}) }, digest = fingerprint(key)
        if (await claim(key, digest, signal) !== 'new') {
            const old = await previous(key, signal)
            return snapshot(a, old.state === 'healthy' ? 'unchecked' : old.state, [], 'saved', old)
        }
        let result: ServiceTransportReceipt, listed: ServiceTransportSnapshot['tools'] = [], observation: 'live' | 'probe' = mode === 'probe' ? 'probe' : 'live'
        try {
            if (mode === 'reconnect') { await deps.operations.cancel(ref, undefined, signal); await deps.drivers[a.plan.transport].drain(a, signal); await current(a, run ? 'call' : 'discover', signal, run) }
            const found = await operation(a, key, signal, run, async context => {
                const d = deps.drivers[a.plan.transport]
                return d.discover(context, requestId, mode, run)
            })
            listed = await tools(a, found.tools); observation = found.observation
            await current(a, run ? 'call' : 'discover', signal, run)
            result = receipt(key, 'completed', 'healthy')
        } catch (error) { result = receipt(key, 'uncertain', 'unavailable', signal.aborted ? 'cancelled' : failure(error)) }
        result = await settle(key, digest, result)
        if (result.outcome !== 'completed') listed = []
        try { await current(a, run ? 'call' : 'discover', signal, run) } catch { return snapshot(a, 'uncertain', [], 'saved', receipt(key, 'uncertain', 'uncertain', 'changed')) }
        return snapshot(a, result.state, listed, observation, result)
    }
    async function drain(ref: ServiceTransportRef, signal: AbortSignal, run?: TrustedRun) {
        const a = await authorize(ref, 'close', signal, run)
        await deps.operations.cancel(ref, run, signal)
        if (run) await deps.drivers[a.plan.transport].releaseRun(a, run, signal)
        else await deps.drivers[a.plan.transport].drain(a, signal)
        await authorize(ref, 'close', signal, run)
        return a
    }
    async function control(input: ServiceTransportControl, signal: AbortSignal): Promise<ServiceTransportSnapshot> {
        signal = boundedSignal(signal)
        const request = serviceTransportControlSchema.parse(input), ref = serviceTransportRefSchema.parse({ agentId: request.agentId, key: request.key, installationId: request.installationId, revision: request.revision })
        if (request.action === 'status') return status(ref, signal)
        if (request.action === 'probe' || request.action === 'reconnect') return discover(ref, request.requestId, request.action, signal)
        const a = await authorize(ref, 'close', signal), key: TransportReceiptKey = { ref, requestId: request.requestId, action: request.action }, digest = fingerprint(key)
        if (await claim(key, digest, signal) !== 'new') {
            const old = await previous(key, signal)
            if (old.outcome === 'completed') return snapshot(a, old.state, [], 'saved', old)
            // Drain is idempotent and recoverable; calls and process starts are never resumed.
        }
        let result: ServiceTransportReceipt
        try { await drain(ref, AbortSignal.any([signal, AbortSignal.timeout(L.closeMs)])); result = receipt(key, 'completed', 'disconnected') }
        catch { result = receipt(key, 'uncertain', 'closing', 'close-unconfirmed') }
        result = await settle(key, digest, result)
        return snapshot(a, result.state, [], 'saved', result)
    }
    async function call(ref: ServiceTransportRef, invocation: Invocation, signal: AbortSignal) {
        signal = boundedSignal(signal)
        serviceTransportRefSchema.parse(ref)
        const a = await authorize(ref, 'call', signal, invocation.run)
        if (!/^[\w.-]{1,128}$/.test(invocation.tool) || !invocation.toolCallId || invocation.toolCallId.length > 200) throw new TransportFailure('invalid')
        boundedJson(invocation.arguments, L.argumentBytes)
        const key: TransportReceiptKey = { ref, requestId: invocation.requestId, action: 'call', run: invocation.run, toolCallId: invocation.toolCallId }
        serviceTransportControlSchema.shape.requestId.parse(invocation.requestId)
        const digest = fingerprint(key, [invocation.tool, invocation.arguments])
        const unknown = () => ({ receipt: receipt(key, 'uncertain', 'uncertain', 'unknown') })
        try { if (await claim(key, digest, signal) !== 'new') return unknown() } catch { return unknown() }
        let result: unknown
        try {
            result = await operation(a, key, signal, invocation.run, context => deps.drivers[a.plan.transport].call(context, invocation))
            result = validateSseResult(deps.protect(result, a))
            const settled = await settle(key, digest, receipt(key, 'completed', 'healthy'))
            await current(a, 'call', signal, invocation.run)
            if (settled.outcome !== 'completed') return unknown()
            return { receipt: settled, result }
        } catch (error) {
            const r = await settle(key, digest, receipt(key, 'uncertain', 'uncertain', signal.aborted ? 'cancelled' : failure(error)))
            return { receipt: r }
        }
    }
    async function reconcile(input: ServiceTransportControl, signal: AbortSignal) {
        signal = boundedSignal(signal)
        const request = serviceTransportControlSchema.parse(input), ref = serviceTransportRefSchema.parse({ agentId: request.agentId, key: request.key, installationId: request.installationId, revision: request.revision })
        if (request.action === 'status') return status(ref, signal)
        const a = await authorize(ref, 'read', signal), old = await previous({ ref, requestId: request.requestId, action: request.action }, signal)
        await current(a, 'read', signal)
        return snapshot(a, old.state === 'healthy' ? 'unchecked' : old.state, [], 'saved', old)
    }
    return { status, control, reconcile, serverName: async (ref: ServiceTransportRef, run: TrustedRun, signal: AbortSignal) => (await authorize(ref, 'call', signal, run)).plan.serverName, discoverForRun: (ref: ServiceTransportRef, requestId: string, run: TrustedRun, signal: AbortSignal) => discover(ref, requestId, 'run', signal, run), call,
        stopRun: (ref: ServiceTransportRef, run: TrustedRun, signal: AbortSignal) => drain(ref, signal, run),
        // Root calls this under its mutation reservation, before changing/removing an account.
        async beforeChange(prior: TransportAuthority, signal: AbortSignal) {
            await deps.operations.cancel(prior.ref, undefined, signal)
            await deps.drivers[prior.plan.transport].drain(prior, signal)
        },
    }
}
