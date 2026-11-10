import 'server-only'
import { randomUUID } from 'node:crypto'
import type { DesktopMcpSignInSource } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import type { McpDeviceMethodReview } from '../../mcp-device-review'
import type { DeviceApprovalLease } from '../mcp-device-custody/custody'
import { digest, parsePrivate, type DeviceApproval, type DeviceAuthorityTarget } from '../mcp-device-custody/model'
import { DEVICE_REVIEW_LIMITS, deviceReviewDecisionSchema, reviewedAuthority, sourceScope, trustedDeviceMethodSchema, type DeviceReviewRecord } from './model'
import type { DeviceReviewStore, SavedDeviceReview } from './store'
import { abortable } from '../mcp/remote'

export type DeviceReviewAuthority = {
    workspaceId: string; owner: string; engineAgentId: string; sessionId: string
    name: string; revision: string; url: string
    signal: AbortSignal; check(): void
}
export type TrustedDeviceMethodLease = {
    value: unknown; signal: AbortSignal; check(): void
}
export type DeviceMethodReviewPorts = {
    workspaceId: string
    store: DeviceReviewStore
    shutdown: AbortSignal
    authority(source: DesktopMcpSignInSource, signal: AbortSignal, mode: 'review' | 'use' | 'retire'): Promise<DeviceReviewAuthority>
    /** Reads validated method metadata AND the current canonical credential generation; never renderer/model input. */
    method(authority: DeviceReviewAuthority, signal: AbortSignal): Promise<TrustedDeviceMethodLease>
    stopCustody(approval: DeviceApproval): Promise<void>
    now?: () => number
}

export function createTrustedMcpDeviceMethodReview(ports: DeviceMethodReviewPorts) {
    const now = ports.now ?? Date.now
    const blocked = new Set<string>()
    const active = new Map<string, { version: number; owner: string; controller: AbortController; timer: ReturnType<typeof setTimeout> }>()
    let closed = false
    const unavailable = () => new Error('Device method review is unavailable or changed. Reload the exact request.')
    function checkOpen(signal: AbortSignal) { signal.throwIfAborted(); ports.shutdown.throwIfAborted(); if (closed) throw unavailable() }
    async function safe<T>(work: () => Promise<T>): Promise<T> { try { return await work() } catch { throw unavailable() } }
    function invalidate(id: string) {
        blocked.add(id)
        const lease = active.get(id)
        if (lease) { clearTimeout(lease.timer); lease.controller.abort(); active.delete(id) }
    }
    function project(record: DeviceReviewRecord): McpDeviceMethodReview {
        const expired = (record.state === 'pending' ? record.reviewUntil : record.approval.approvedUntil) <= now()
        return {
            reviewId: record.reviewId, revision: record.revision, workspaceId: record.approval.workspaceId,
            owner: record.approval.owner, localSessionId: record.source.sessionId,
            serverName: record.approval.name, registrationRevision: record.approval.revision,
            method: structuredClone(record.approval.method),
            expiresAt: record.state === 'pending' ? record.reviewUntil : record.approval.approvedUntil,
            state: expired && (record.state === 'pending' || record.state === 'approved') ? 'expired' : record.state,
            ...(record.decision ? { receipt: { decisionId: record.decision.id, outcome: record.decision.operation === 'approve-device-method' ? 'approved' as const : 'declined' as const, recordedAt: record.decision.at } } : {}),
        }
    }
    async function current(source: DesktopMcpSignInSource, stop: AbortSignal, mode: 'review' | 'use' = 'review') {
        const signal = AbortSignal.any([stop, ports.shutdown, AbortSignal.timeout(30_000)])
        checkOpen(signal)
        const owner = await abortable(ports.authority(source, signal, mode), signal)
        const method = await abortable(ports.method(owner, signal), signal)
        const value = parsePrivate(trustedDeviceMethodSchema, method.value)
        const bound = AbortSignal.any([signal, owner.signal, method.signal])
        const check = () => {
            checkOpen(bound); owner.check(); method.check()
            if (owner.workspaceId !== ports.workspaceId || owner.owner !== source.agentId || owner.name !== source.server.name
                || owner.revision !== source.server.revision || owner.url !== source.server.url || value.method.resource !== owner.url
                || value.validUntil <= now()) throw unavailable()
        }
        check()
        const authority = { workspaceId: owner.workspaceId, owner: owner.owner, engineAgentId: owner.engineAgentId, sessionId: owner.sessionId,
            registrationId: value.registrationId, name: owner.name, revision: owner.revision, credentialGeneration: value.credentialGeneration, method: value.method }
        return { authority, validUntil: value.validUntil, signal: bound, check }
    }
    function exact(saved: SavedDeviceReview, source: DesktopMcpSignInSource, authority: Awaited<ReturnType<typeof current>>) {
        authority.check()
        if (blocked.has(saved.value.reviewId) || digest(saved.value.source) !== digest(source)
            || digest(reviewedAuthority(saved.value)) !== digest(authority.authority)) throw unavailable()
    }
    async function retire(saved: SavedDeviceReview, id: string, operation: 'stop-device-method' | 'revoke-device-method', check: () => void) {
        invalidate(saved.value.reviewId)
        const cleanup = async () => {
            if (saved.value.decision?.operation === 'approve-device-method') await ports.stopCustody(saved.value.approval)
        }
        for (let retry = 0; retry < 3; retry++) {
            if (saved.value.retirement) {
                if (operation === 'stop-device-method' && (saved.value.retirement.id !== id || saved.value.retirement.operation !== operation)) throw unavailable()
                await cleanup()
                return saved
            }
            try {
                saved = await ports.store.replace(saved, { ...saved.value, state: operation === 'stop-device-method' ? 'stopped' : 'revoked', retirement: { id, operation, at: now() } }, check)
            } catch {
                check()
                const latest = await ports.store.read(ports.workspaceId, saved.value.approval.owner, saved.value.reviewId)
                if (!latest || digest(latest.value.source) !== digest(saved.value.source)) throw unavailable()
                saved = latest
                continue
            }
            await cleanup()
            return saved
        }
        throw unavailable()
    }
    const api = {
        review: (source: DesktopMcpSignInSource, signal: AbortSignal) => safe(async () => {
            const initial = await current(source, signal)
            const scope = sourceScope(ports.workspaceId, source)
            let saved = await ports.store.bySource(ports.workspaceId, source.agentId, scope)
            if (!saved) {
                const record: DeviceReviewRecord = {
                    reviewId: randomUUID(), revision: randomUUID(), source: structuredClone(source),
                    approval: { ...initial.authority, approvalId: randomUUID(), approvedUntil: Math.min(initial.validUntil, now() + DEVICE_REVIEW_LIMITS.approvalMs) },
                    state: 'pending', createdAt: now(), reviewUntil: Math.min(initial.validUntil, now() + DEVICE_REVIEW_LIMITS.reviewMs),
                }
                await ports.store.create(record, initial.check)
                saved = await ports.store.bySource(ports.workspaceId, source.agentId, scope)
            }
            if (!saved) throw unavailable()
            const latest = await current(source, signal)
            if (saved.value.state === 'pending' || saved.value.state === 'approved') exact(saved, source, latest)
            else if (digest(saved.value.source) !== digest(source)) throw unavailable()
            return project(saved.value)
        }),
        decide: (source: DesktopMcpSignInSource, raw: unknown, signal: AbortSignal) => safe(async () => {
            const input = parsePrivate(deviceReviewDecisionSchema, raw)
            const owner = await ports.authority(source, signal, input.operation === 'stop-device-method' ? 'retire' : 'review')
            checkOpen(signal); owner.check()
            if (owner.workspaceId !== ports.workspaceId || owner.owner !== source.agentId) throw unavailable()
            let saved = await ports.store.read(ports.workspaceId, owner.owner, input.reviewId)
            if (!saved || saved.value.revision !== input.revision || digest(saved.value.source) !== digest(source)) throw unavailable()
            if (input.operation === 'stop-device-method') {
                saved = await retire(saved, input.decisionId, input.operation, () => { checkOpen(signal); owner.check() })
                return project(saved.value)
            }
            const selected = await current(source, signal)
            exact(saved, source, selected)
            if (saved.value.decision) {
                if (saved.value.decision.id !== input.decisionId || saved.value.decision.operation !== input.operation) throw unavailable()
                return project(saved.value)
            }
            if (saved.value.state !== 'pending' || saved.value.reviewUntil <= now()) throw unavailable()
            const latest = await current(source, signal)
            exact(saved, source, latest)
            const state = input.operation === 'approve-device-method' ? 'approved' : 'declined'
            saved = await ports.store.replace(saved, { ...saved.value, state, decision: { id: input.decisionId, operation: input.operation, at: now() } }, () => { latest.check(); if (blocked.has(input.reviewId) || saved!.value.reviewUntil <= now()) throw unavailable() })
            try {
                latest.check()
                const confirmed = await ports.store.read(ports.workspaceId, owner.owner, input.reviewId)
                latest.check()
                if (!confirmed || confirmed.version !== saved.version || blocked.has(input.reviewId)) throw unavailable()
            }
            catch {
                invalidate(input.reviewId)
                await retire(saved, randomUUID(), 'revoke-device-method', () => {})
                throw unavailable()
            }
            return project(saved.value)
        }),
        approvedMethod: (target: DeviceAuthorityTarget, signal: AbortSignal): Promise<DeviceApprovalLease | null> => safe(async () => {
            checkOpen(signal)
            const records = (await ports.store.list(ports.workspaceId, target.owner)).filter(saved => {
                const a = saved.value.approval
                return saved.value.state === 'approved' && a.name === target.name && a.revision === target.revision && a.method.resource === target.url
                    && a.engineAgentId === target.identity.engineAgentId && a.sessionId === target.identity.sessionId && a.approvedUntil > now()
            })
            if (!records.length) return null
            if (records.length !== 1) throw unavailable()
            const saved = records[0]!, selected = await current(saved.value.source, signal, 'use')
            exact(saved, saved.value.source, selected)
            const final = await ports.store.read(ports.workspaceId, target.owner, saved.value.reviewId)
            if (!final || final.version !== saved.version || final.value.state !== 'approved') throw unavailable()
            const id = saved.value.reviewId
            let lease = active.get(id)
            if (lease && lease.version !== saved.version) { invalidate(id); throw unavailable() }
            if (!lease) {
                const controller = new AbortController()
                const timer = setTimeout(() => { controller.abort(); active.delete(id) }, Math.max(1, Math.min(saved.value.approval.approvedUntil, selected.validUntil) - now()))
                timer.unref?.()
                lease = { version: saved.version, owner: target.owner, controller, timer }
                active.set(id, lease)
            }
            const bound = AbortSignal.any([signal, selected.signal, lease.controller.signal])
            const check = () => {
                try { checkOpen(bound); selected.check(); if (blocked.has(id) || saved.value.approval.approvedUntil <= now() || active.get(id) !== lease) throw unavailable() }
                catch { throw unavailable() }
            }
            check()
            return { approval: structuredClone(saved.value.approval), signal: bound, check }
        }),
        /** Trusted lifecycle hook only; never expose this as an engine/model operation. */
        revokeOwner: (owner: string) => safe(async () => {
            for (const [id, lease] of active) if (lease.owner === owner) invalidate(id)
            const records = await ports.store.list(ports.workspaceId, owner)
            for (const saved of records) {
                if (saved.value.state === 'declined') continue
                await retire(saved, randomUUID(), 'revoke-device-method', () => {})
            }
        }),
        dispose(): void {
            closed = true
            for (const [id] of active) invalidate(id)
            ports.shutdown.removeEventListener('abort', api.dispose)
        },
    }
    ports.shutdown.addEventListener('abort', api.dispose, { once: true })
    return api
}
