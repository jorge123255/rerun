import 'server-only'
import type { Client } from '@libsql/client'
import { desktopMcpSignInSourceSchema, type DesktopMcpSignInSource } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import type { McpDeviceAuthorization, McpDeviceAttemptView } from '../../mcp-device-review'
import { desktopMcpSignInPorts } from '../mcp-sign-in/binding'
import { createDesktopMcpSignInStore } from '../mcp-sign-in/store'
import { credentialGenerationToken, MCP_CREDENTIAL_GENERATION_TTL_MS } from '../mcp/credential-generation'
import { discoverDeviceOAuth } from '../mcp/oauth-network'
import { abortable } from '../mcp/remote'
import type { RemoteMcpStore } from '../mcp/store'
import type { DesktopRuntime } from '../runtime'
import { digest, parsePrivate } from '../mcp-device-custody/model'
import { createEncryptedDeviceCustodyStore } from '../mcp-device-custody/store'
import { bindMcpDeviceStorage } from '../mcp-device-custody/binding'
import { createMcpDeviceBroker } from '../mcp-device-custody/broker'
import type { DeviceCustodyPorts } from '../mcp-device-custody/custody'
import { createTrustedMcpDeviceMethodReview, type DeviceMethodReviewPorts, type DeviceReviewAuthority, type TrustedDeviceMethodLease } from './service'
import { trustedDeviceMethodSchema } from './model'
import { createDeviceReviewStore } from './store'

export type CanonicalDeviceMethodReviewBinding = {
    runtime: DesktopRuntime
    db: Client
    key(): Buffer
    store: RemoteMcpStore
    shutdown: AbortSignal
    /** Optional fixture adapter. The default reads only the saved public client and trusted OAuth metadata. */
    method?(target: DeviceReviewAuthority & { registrationId: string }, signal: AbortSignal): Promise<TrustedDeviceMethodLease>
    stopCustody?: DeviceMethodReviewPorts['stopCustody']
    broker?: DeviceCustodyPorts['broker']
    now?: () => number
}

export function bindTrustedMcpDeviceMethodReview(ports: CanonicalDeviceMethodReviewBinding) {
    const custody = createEncryptedDeviceCustodyStore(ports.db, ports.key)
    const signIn = createDesktopMcpSignInStore(ports.db)
    const device = bindMcpDeviceStorage({ ...ports, broker: ports.broker ?? createMcpDeviceBroker(), approval: async () => null })
    const reviews = createDeviceReviewStore(ports.db, ports.key)
    const workspaceId = String(ports.runtime.workspaceId)
    const now = ports.now ?? Date.now
    const configuredMethod: NonNullable<CanonicalDeviceMethodReviewBinding['method']> = async (target, signal) => {
        const watch = ports.store.lifecycle.watchCredentials(target.owner, target.name)
        const check = () => { signal.throwIfAborted(); target.check(); watch() }
        const configuration = (await abortable(ports.store.listSettings(target.owner), signal))
            .find(row => row.id === target.registrationId && row.name === target.name && row.revision === target.revision && row.url === target.url)
        if (!configuration?.deviceClient) throw new Error('Device sign-in is unavailable for this registration')
        const before = await abortable(ports.store.credentialState(target.owner, target.name), signal)
        check()
        if (!before || before.registrationId !== target.registrationId || before.revision !== target.revision || before.resource !== target.url) throw new Error('Device method registration changed')
        const method = await discoverDeviceOAuth(target.url, configuration.deviceClient, signal)
        const after = await abortable(ports.store.credentialState(target.owner, target.name), signal)
        check()
        if (!after || after.registrationId !== before.registrationId || after.revision !== before.revision || after.resource !== before.resource
            || after.sealed !== before.sealed) throw new Error('Device method credentials changed')
        return { value: {
            registrationId: after.registrationId, method, credentialGeneration: credentialGenerationToken(ports.key(), target.owner, target.name, after, after.sealed),
            validUntil: now() + MCP_CREDENTIAL_GENERATION_TTL_MS,
        }, signal, check }
    }
    const authority: DeviceMethodReviewPorts['authority'] = async (source, stop, mode) => {
        const signal = AbortSignal.any([stop, ports.shutdown])
        return (await abortable(desktopMcpSignInPorts(ports.runtime, source.sessionId), signal)).deviceMethodAuthority(source, signal, mode)
    }
    async function approved(source: DesktopMcpSignInSource, owner: DeviceReviewAuthority, reviewId: string, revision: string, query: Pick<Client, 'execute'>) {
        if (owner.workspaceId !== workspaceId || owner.owner !== source.agentId || owner.name !== source.server.name
            || owner.revision !== source.server.revision || owner.url !== source.server.url) return null
        const request = await signIn.readBySource(source, query)
        if (!request || request.activeAttemptId || request.receipt) return null
        const review = (await reviews.read(workspaceId, owner.owner, reviewId, query))?.value
        if (!review || review.revision !== revision || review.state !== 'approved' || review.decision?.operation !== 'approve-device-method'
            || digest(review.source) !== digest(parsePrivate(desktopMcpSignInSourceSchema, source))) return null
        const { approval } = review
        if (approval.method.kind !== 'device-code-rfc8628-v1' || approval.engineAgentId !== owner.engineAgentId
            || approval.sessionId !== owner.sessionId || approval.approvedUntil <= now()) return null
        return approval
    }
    async function readAuthorization(source: DesktopMcpSignInSource, reviewId: string, revision: string, stop: AbortSignal): Promise<McpDeviceAuthorization | null> {
        const owner = await authority(source, stop, 'use')
        const signal = AbortSignal.any([stop, owner.signal, ports.shutdown])
        signal.throwIfAborted(); owner.check()
        const query = await ports.db.transaction('read')
        try {
            const approval = await approved(source, owner, reviewId, revision, query)
            if (!approval) return null
            const registration = await ports.store.credentialState(owner.owner, owner.name, query)
            if (!registration || registration.registrationId !== approval.registrationId || registration.revision !== owner.revision
                || registration.resource !== owner.url
                || credentialGenerationToken(ports.key(), owner.owner, owner.name, registration, registration.sealed) !== approval.credentialGeneration) return null
            const attempt = (await custody.read(approval, query))?.value
            signal.throwIfAborted(); owner.check()
            if (!attempt || attempt.phase !== 'waiting' || !attempt.userCode || attempt.expiresAt <= now()
                || digest(attempt.approval) !== digest(approval)) return null
            return { reviewId, revision, userCode: attempt.userCode, verificationUri: approval.method.verificationUri, expiresAt: attempt.expiresAt }
        } finally { query.close() }
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
            const lease = await abortable((ports.method ?? configuredMethod)({ ...owner, registrationId: row.id }, signal), signal)
            check(); lease.check(); lease.signal.throwIfAborted()
            const value = parsePrivate(trustedDeviceMethodSchema, lease.value)
            if (value.registrationId !== row.id) throw new Error('Device method registration changed')
            return { value, signal: AbortSignal.any([signal, lease.signal]), check: () => { check(); lease.check() } }
        },
        stopCustody: async approval => {
            const saved = await custody.read(approval)
            if (saved && digest(saved.value.approval) === digest(approval)) await (ports.stopCustody ?? device.stop)(approval)
        },
    })
    return { ...service, readAuthorization,
        async operate(source: DesktopMcpSignInSource, reviewId: string, revision: string, requestId: string, action: 'start' | 'complete', stop: AbortSignal): Promise<McpDeviceAttemptView> {
            const owner = await authority(source, stop, 'use')
            const initial = await approved(source, owner, reviewId, revision, ports.db)
            if (!initial) return { state: 'approval_required', authorization: null }
            const result = await device.operate(action, {
                owner: owner.owner, name: owner.name, revision: owner.revision, url: owner.url, requestId, approvalId: initial.approvalId,
                identity: { engineAgentId: owner.engineAgentId, sessionId: owner.sessionId, runId: source.runId },
            }, stop, async (_target, signal) => {
                const current = await authority(source, signal, 'use')
                const approval = await approved(source, current, reviewId, revision, ports.db)
                if (!approval) return null
                return { approval, signal: current.signal, check: current.check, async assertCommit(query) {
                    signal.throwIfAborted(); current.check()
                    const saved = await approved(source, current, reviewId, revision, query)
                    if (!saved || digest(saved) !== digest(approval)) throw new Error('Device sign-in request changed')
                } }
            })
            const authorization = result.state === 'waiting' || result.state === 'pending'
                ? await readAuthorization(source, reviewId, revision, stop) : null
            return { state: result.state, authorization }
        },
        dispose() { device.dispose(); service.dispose() },
    }
}
