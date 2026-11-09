import 'server-only'
import type { ApprovedDeviceFallback } from '../../../../../engine/src/desktop/mcp-login-tools/backend'
import type { DeviceView } from '../../../../../engine/src/desktop/mcp-login-tools/contract'
import { abortable } from '../mcp/remote'
import type { OAuthTokenBundle } from '../mcp/store'
import {
    DEVICE_CUSTODY_LIMITS, deviceApprovalSchema, deviceStartSchema, devicePollSchema, digest,
    parsePrivate, requestFingerprint, requestKey, slotOf,
    type ApprovedDeviceMethod, type DeviceApproval, type DeviceAuthorityTarget, type DeviceRecord, type DeviceTarget,
} from './model'
import type { DeviceCustodyStore, SavedDeviceRecord } from './store'

export type DeviceApprovalLease = { approval: unknown; check(): void; signal: AbortSignal }
export type DeviceCustodyPorts = {
    store: DeviceCustodyStore
    shutdown: AbortSignal
    approval(target: DeviceAuthorityTarget, signal: AbortSignal): Promise<DeviceApprovalLease | null>
    lifecycle(target: DeviceAuthorityTarget, controller: AbortController): { assertCurrent(): void; release(): void }
    broker?: {
        start(method: ApprovedDeviceMethod, signal: AbortSignal): Promise<unknown>
        poll(method: ApprovedDeviceMethod, deviceCode: string, signal: AbortSignal): Promise<unknown>
    }
    writeCredential(approval: DeviceApproval, token: OAuthTokenBundle, signal: AbortSignal): Promise<void>
    now?: () => number
}

type Admitted = { approval: DeviceApproval; signal: AbortSignal; check(): void; recheck(): Promise<void> }
type ReceiptResult = NonNullable<DeviceRecord['requests'][string]['result']>
const inFlight = (phase: DeviceRecord['phase']) => phase === 'starting' || phase === 'polling' || phase === 'committing'

/** A factory owned by the existing MCP runtime. Construction/reads never start a broker effect. */
export function createApprovedMcpDeviceCustody(ports: DeviceCustodyPorts) {
    const now = ports.now ?? Date.now
    const active = new Map<string, AbortController>()
    let disposed = false
    async function admit(target: DeviceAuthorityTarget, stop: AbortSignal): Promise<Admitted | null> {
        const signal = AbortSignal.any([stop, ports.shutdown, AbortSignal.timeout(DEVICE_CUSTODY_LIMITS.operationMs)])
        signal.throwIfAborted()
        if (disposed) throw new Error('MCP device custody is stopped')
        const lease = await abortable(ports.approval(target, signal), signal)
        if (!lease) return null
        const approval = parsePrivate(deviceApprovalSchema, lease.approval)
        const bound = AbortSignal.any([signal, lease.signal])
        const check = () => {
            bound.throwIfAborted(); lease.check()
            if (disposed || approval.approvedUntil <= now()
                || approval.owner !== target.owner || approval.name !== target.name || approval.revision !== target.revision
                || approval.engineAgentId !== target.identity.engineAgentId || approval.sessionId !== target.identity.sessionId
                || approval.method.resource !== target.url) throw new Error('MCP device approval is no longer current')
        }
        check()
        return { approval, signal: bound, check, async recheck() {
            check()
            const current = await abortable(ports.approval(target, bound), bound)
            check(); current?.check()
            if (!current || current.signal.aborted || digest(parsePrivate(deviceApprovalSchema, current.approval)) !== digest(approval)) throw new Error('MCP device approval changed')
            check()
        } }
    }
    function waiting(value: DeviceRecord): DeviceView {
        const seconds = Math.ceil((value.expiresAt - now()) / 1000)
        return seconds > 0 ? { state: 'waiting', verificationUri: value.approval.method.verificationUri, expiresIn: Math.min(1800, seconds) } : { state: 'failed' }
    }
    function view(value: DeviceRecord): DeviceView {
        if (value.phase === 'waiting') return waiting(value)
        if (value.phase === 'connected') return { state: 'connected', tools: [] }
        return { state: inFlight(value.phase) || value.phase === 'unknown' ? 'unknown' : 'failed' }
    }
    async function expire(admitted: Admitted, saved: SavedDeviceRecord): Promise<SavedDeviceRecord> {
        if (saved.value.expiresAt > now() || ['connected', 'unknown', 'expired', 'cancelled', 'failed'].includes(saved.value.phase)) return saved
        await admitted.recheck()
        return ports.store.replace(admitted.approval, saved, {
            ...saved.value, phase: inFlight(saved.value.phase) ? 'unknown' : 'expired', deviceCode: undefined,
        }, admitted.check)
    }
    function receiptView(value: DeviceRecord, result?: ReceiptResult): DeviceView {
        if (result === 'waiting') return waiting(value)
        if (result === 'connected') return { state: 'connected', tools: [] }
        return { state: result ?? 'unknown' }
    }
    async function settle(admitted: Admitted, saved: SavedDeviceRecord, key: string, phase: DeviceRecord['phase'], result: ReceiptResult, fields: Partial<DeviceRecord> = {}) {
        await admitted.recheck()
        const next: DeviceRecord = { ...saved.value, ...fields, phase,
            requests: { ...saved.value.requests, [key]: { ...saved.value.requests[key]!, state: 'settled', result } },
        }
        return ports.store.replace(admitted.approval, saved, next, admitted.check)
    }
    async function operate(action: 'start' | 'complete', target: DeviceTarget, stop: AbortSignal): Promise<DeviceView> {
        const admitted = await admit(target, stop)
        if (!admitted || admitted.approval.approvalId !== target.approvalId) return { state: 'approval_required' }
        if (!ports.broker) return { state: 'unsupported' }
        const { approval } = admitted, slot = slotOf(approval), key = requestKey(target), fingerprint = requestFingerprint(action, target)
        let saved = await ports.store.read(approval)
        await admitted.recheck()
        if (saved && digest(saved.value.approval) !== digest(approval)) return { state: 'unknown' }
        if (saved) saved = await expire(admitted, saved)
        const existing = saved?.value.requests[key]
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw new Error('MCP device request identity changed')
            if (['unknown', 'expired', 'cancelled', 'failed'].includes(saved!.value.phase)) return view(saved!.value)
            return existing.state === 'settled' ? receiptView(saved!.value, existing.result) : { state: 'unknown' }
        }
        if (saved && saved.value.phase !== 'waiting') return view(saved.value)
        if (saved && action === 'start') return waiting(saved.value)
        if (!saved && action === 'complete') return { state: 'no_pending' }
        if (saved && now() < saved.value.nextPollAt) return { state: 'pending' }
        if (active.size >= DEVICE_CUSTODY_LIMITS.registrations || active.has(slot)) return { state: 'unknown' }
        const controller = new AbortController(), ticket = ports.lifecycle(target, controller)
        const signal = AbortSignal.any([admitted.signal, controller.signal])
        active.set(slot, controller)
        let effectReserved = false
        const check = () => { signal.throwIfAborted(); admitted.check(); ticket.assertCurrent() }
        try {
            check()
            if (!saved) {
                const value: DeviceRecord = { approval, phase: 'starting', startedAt: now(), expiresAt: Math.min(approval.approvedUntil, now() + DEVICE_CUSTODY_LIMITS.lifetimeMs), nextPollAt: 0, interval: 0,
                    requests: { [key]: { fingerprint, state: 'reserved' } } }
                if (!await ports.store.create(approval, value, check)) return { state: 'unknown' }
                saved = { version: 1, value }
            } else {
                if (Object.keys(saved.value.requests).length >= DEVICE_CUSTODY_LIMITS.requests) return { state: 'unknown' }
                saved = await ports.store.replace(approval, saved, { ...saved.value, phase: 'polling',
                    requests: { ...saved.value.requests, [key]: { fingerprint, state: 'reserved' } },
                }, check)
            }
            effectReserved = true
            await admitted.recheck(); check()
            if (action === 'start') {
                const start = parsePrivate(deviceStartSchema, await abortable(ports.broker.start(approval.method, signal), signal))
                await admitted.recheck(); check()
                if (start.verificationUri !== approval.method.verificationUri) throw new Error('Unsupported verification destination')
                const expiresAt = Math.min(saved.value.expiresAt, saved.value.startedAt + start.expiresIn * 1000)
                if (expiresAt <= now()) throw new Error('MCP device attempt expired')
                saved = await settle(admitted, saved, key, 'waiting', 'waiting', { deviceCode: start.deviceCode, expiresAt, interval: start.interval, nextPollAt: now() + start.interval * 1000 })
                check()
                return waiting(saved.value)
            }
            if (!saved.value.deviceCode || saved.value.expiresAt <= now()) throw new Error('MCP device attempt expired')
            const result = parsePrivate(devicePollSchema, await abortable(ports.broker.poll(approval.method, saved.value.deviceCode, signal), signal))
            await admitted.recheck(); check()
            if (saved.value.expiresAt <= now()) throw new Error('MCP device attempt expired')
            if (result.state === 'pending' || result.state === 'slow_down') {
                const interval = Math.min(60, saved.value.interval + (result.state === 'slow_down' ? 5 : 0))
                await settle(admitted, saved, key, 'waiting', 'pending', { interval, nextPollAt: now() + interval * 1000 })
                check(); return { state: 'pending' }
            }
            if (result.state === 'denied' || result.state === 'expired') {
                await settle(admitted, saved, key, result.state === 'expired' ? 'expired' : 'failed', 'failed', { deviceCode: undefined })
                check(); return { state: 'failed' }
            }
            if (result.state !== 'authorized') throw new Error('Unsupported device response')
            if (result.token.scope !== undefined && result.token.scope !== approval.method.scope) throw new Error('Device token scope changed')
            saved = await ports.store.replace(approval, saved, { ...saved.value, phase: 'committing', deviceCode: undefined }, check)
            await admitted.recheck(); check()
            const method = approval.method
            await abortable(ports.writeCredential(approval, {
                accessToken: result.token.accessToken, refreshToken: result.token.refreshToken,
                expiresAt: now() + result.token.expiresIn * 1000, scope: approval.method.scope,
                resource: method.resource, issuer: method.issuer, tokenEndpoint: method.tokenEndpoint, clientId: method.clientId,
            }, signal), signal)
            await admitted.recheck(); check()
            await settle(admitted, saved, key, 'connected', 'connected')
            check(); return { state: 'connected', tools: [] }
        } catch {
            // A reserved effect may have reached the provider or credential store. Never poll/start it again.
            if (saved && effectReserved) {
                await ports.store.replace(approval, saved, { ...saved.value, phase: 'unknown', deviceCode: undefined }, () => {}).catch(() => undefined)
                return { state: 'unknown' }
            }
            throw new Error('MCP device custody unavailable; reconcile the existing attempt')
        } finally { ticket.release(); if (active.get(slot) === controller) active.delete(slot) }
    }
    const fallback: ApprovedDeviceFallback = {
        async authorize(target, signal) {
            const admitted = await admit(target, signal)
            return admitted ? { approvalId: admitted.approval.approvalId } : null
        },
        start: (target, signal) => operate('start', target, signal),
        complete: (target, signal) => operate('complete', target, signal),
    }
    return { fallback,
        async inspect(target: DeviceAuthorityTarget, stop: AbortSignal): Promise<DeviceView> {
            const admitted = await admit(target, stop)
            if (!admitted) return { state: 'approval_required' }
            const saved = await ports.store.read(admitted.approval)
            await admitted.recheck()
            if (!saved) return { state: 'no_pending' }
            if (digest(saved.value.approval) !== digest(admitted.approval)) return { state: 'unknown' }
            // Observational: expiry is projected without writes, polling or consuming a token.
            if (saved.value.phase === 'waiting' && saved.value.expiresAt <= now()) return { state: 'failed' }
            // Only the existing login backend's live probe may announce connected/tools.
            if (saved.value.phase === 'connected') return { state: 'pending' }
            return view(saved.value)
        },
        async stop(approval: DeviceApproval): Promise<void> {
            active.get(slotOf(approval))?.abort()
            for (let retry = 0; retry < 3; retry++) {
                const saved = await ports.store.read(approval)
                if (!saved || ['connected', 'cancelled', 'expired', 'failed', 'unknown'].includes(saved.value.phase)) return
                try {
                    await ports.store.replace(approval, saved, { ...saved.value,
                        phase: inFlight(saved.value.phase) ? 'unknown' : 'cancelled', deviceCode: undefined,
                    }, () => {})
                    return
                } catch { /* A concurrent settlement must be inspected before declaring cleanup. */ }
            }
            throw new Error('MCP device cancellation is not acknowledged; reconcile the existing attempt')
        },
        dispose() { disposed = true; for (const controller of active.values()) controller.abort() },
    }
}
