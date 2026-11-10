import 'server-only'
import type { Client } from '@libsql/client'
import { desktopMcpSignInPorts } from '../mcp-sign-in/binding'
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
    return createTrustedMcpDeviceMethodReview({
        workspaceId: String(ports.runtime.workspaceId), store: createDeviceReviewStore(ports.db, ports.key), shutdown: ports.shutdown, now: ports.now,
        authority: async (source, stop, mode) => {
            const signal = AbortSignal.any([stop, ports.shutdown])
            return (await abortable(desktopMcpSignInPorts(ports.runtime, source.sessionId), signal)).deviceMethodAuthority(source, signal, mode)
        },
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
}
