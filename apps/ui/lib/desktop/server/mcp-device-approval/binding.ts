import 'server-only'
import type { Client } from '@libsql/client'
import { desktopMcpSignInSourceSchema, type DesktopMcpSignInSource } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import type { McpDeviceAuthorization } from '../../mcp-device-review'
import { desktopMcpSignInPorts } from '../mcp-sign-in/binding'
import { credentialGenerationToken } from '../mcp/credential-generation'
import { abortable } from '../mcp/remote'
import type { RemoteMcpStore } from '../mcp/store'
import type { DesktopRuntime } from '../runtime'
import { digest, parsePrivate } from '../mcp-device-custody/model'
import { createEncryptedDeviceCustodyStore } from '../mcp-device-custody/store'
import { createTrustedMcpDeviceMethodReview, type DeviceMethodReviewPorts, type DeviceReviewAuthority, type TrustedDeviceMethodLease } from './service'
import { trustedDeviceMethodSchema } from './model'
import { createDeviceReviewStore } from './store'

export type CanonicalDeviceMethodReviewBinding = {
    runtime: DesktopRuntime
    db: Client
    key(): Buffer
    store: RemoteMcpStore
    shutdown: AbortSignal
    /** Trusted broker metadata plus canonical credential-generation lease; no default implementation. */
    method(target: DeviceReviewAuthority & { registrationId: string }, signal: AbortSignal): Promise<TrustedDeviceMethodLease>
    stopCustody: DeviceMethodReviewPorts['stopCustody']
    now?: () => number
}

export function bindTrustedMcpDeviceMethodReview(ports: CanonicalDeviceMethodReviewBinding) {
    const custody = createEncryptedDeviceCustodyStore(ports.db, ports.key)
    const reviews = createDeviceReviewStore(ports.db, ports.key)
    const workspaceId = String(ports.runtime.workspaceId)
    const now = ports.now ?? Date.now
    const authority: DeviceMethodReviewPorts['authority'] = async (source, stop, mode) => {
        const signal = AbortSignal.any([stop, ports.shutdown])
        return (await abortable(desktopMcpSignInPorts(ports.runtime, source.sessionId), signal)).deviceMethodAuthority(source, signal, mode)
    }
    const service = createTrustedMcpDeviceMethodReview({
        workspaceId, store: reviews, shutdown: ports.shutdown, now,
        authority,
        method: async (owner, stop) => {
            const signal = AbortSignal.any([stop, ports.shutdown, owner.signal])
            const registration = ports.store.lifecycle.watch(owner.owner, owner.name)
            const check = () => { signal.throwIfAborted(); owner.check(); registration() }
            check()
            const row = await abortable(ports.store.read(owner.owner, owner.name), signal)
            check()
            if (!row.id || row.name !== owner.name || row.revision !== owner.revision || row.url !== owner.url || row.transport !== 'http' || row.bearer) throw new Error('Device method registration changed')
            const lease = await abortable(ports.method({ ...owner, registrationId: row.id }, signal), signal)
            check(); lease.check(); lease.signal.throwIfAborted()
            const value = parsePrivate(trustedDeviceMethodSchema, lease.value)
            if (value.registrationId !== row.id) throw new Error('Device method registration changed')
            return { value, signal: AbortSignal.any([signal, lease.signal]), check: () => { check(); lease.check() } }
        },
        stopCustody: async approval => {
            const saved = await custody.read(approval)
            if (saved && digest(saved.value.approval) === digest(approval)) await ports.stopCustody(approval)
        },
    })
    return { ...service,
        async readAuthorization(source: DesktopMcpSignInSource, reviewId: string, revision: string, stop: AbortSignal): Promise<McpDeviceAuthorization | null> {
            const owner = await authority(source, stop, 'use')
            const signal = AbortSignal.any([stop, owner.signal, ports.shutdown])
            const check = () => { signal.throwIfAborted(); owner.check() }
            check()
            if (owner.workspaceId !== workspaceId || owner.owner !== source.agentId || owner.name !== source.server.name
                || owner.revision !== source.server.revision || owner.url !== source.server.url) return null
            const query = await ports.db.transaction('read')
            try {
                const review = (await reviews.read(workspaceId, owner.owner, reviewId, query))?.value
                if (!review || review.revision !== revision || review.state !== 'approved' || review.decision?.operation !== 'approve-device-method'
                    || digest(review.source) !== digest(parsePrivate(desktopMcpSignInSourceSchema, source))) return null
                const { approval } = review
                if (approval.method.kind !== 'device-code-rfc8628-v1' || approval.engineAgentId !== owner.engineAgentId
                    || approval.sessionId !== owner.sessionId || approval.approvedUntil <= now()) return null
                const registration = await ports.store.credentialState(owner.owner, owner.name, query)
                if (!registration || registration.registrationId !== approval.registrationId || registration.revision !== owner.revision
                    || registration.resource !== owner.url
                    || credentialGenerationToken(ports.key(), owner.owner, owner.name, registration, registration.sealed) !== approval.credentialGeneration) return null
                const attempt = (await custody.read(approval, query))?.value
                check()
                if (!attempt || attempt.phase !== 'waiting' || !attempt.userCode || attempt.expiresAt <= now()
                    || digest(attempt.approval) !== digest(approval)) return null
                return { reviewId, revision, userCode: attempt.userCode, verificationUri: approval.method.verificationUri, expiresAt: attempt.expiresAt }
            } finally { query.close() }
        },
    }
}
