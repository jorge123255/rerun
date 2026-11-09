import 'server-only'
import type { Client } from '@libsql/client'
import { createDesktopMcpLoginBackend, type RemoteLoginService } from '../../../../../engine/src/desktop/mcp-login-tools/backend'
import type { RemoteMcpStore } from '../mcp/store'
import { abortable } from '../mcp/remote'
import { createApprovedMcpDeviceCustody, type DeviceApprovalLease, type DeviceCustodyPorts } from './custody'
import { createEncryptedDeviceCustodyStore } from './store'
import { deviceApprovalSchema, parsePrivate, type DeviceAuthorityTarget } from './model'

export type CanonicalDeviceCustodyBinding = {
    db: Client
    key(): Buffer
    workspaceId: string
    service: RemoteLoginService & { store: RemoteMcpStore }
    watchOwner(owner: string): () => void
    /** Must read an explicit human-approved device method, not infer one from Connect/browser OAuth. */
    approvedMethod(target: DeviceAuthorityTarget, signal: AbortSignal): Promise<DeviceApprovalLease | null>
    broker?: DeviceCustodyPorts['broker']
    now?: () => number
}

/** Concrete canonical SQLite/encryption/MCP credential/lifecycle binding; no ambient accounts or fetch. */
export function bindApprovedMcpDeviceCustody(ports: CanonicalDeviceCustodyBinding) {
    const store = createEncryptedDeviceCustodyStore(ports.db, ports.key)
    const approval: DeviceCustodyPorts['approval'] = async (target, stop) => {
        const signal = AbortSignal.any([stop, ports.service.shutdownSignal])
        const ownerCheck = ports.watchOwner(target.owner)
        const serverCheck = ports.service.store.lifecycle.watch(target.owner, target.name)
        const check = () => { signal.throwIfAborted(); ownerCheck(); serverCheck() }
        check()
        const owner = await abortable(ports.service.authorizeRun(target.identity, signal, 'mcp'), signal)
        check()
        const row = (await abortable(ports.service.store.list(owner), signal)).find(item => item.name === target.name)
        check()
        if (owner !== target.owner || !row?.id || row.revision !== target.revision || row.url !== target.url || row.transport !== 'http' || row.hasBearer) throw new Error('MCP device registration is unavailable')
        const lease = await abortable(ports.approvedMethod(target, signal), signal)
        check()
        if (!lease) return null
        lease.check(); lease.signal.throwIfAborted()
        const approved = parsePrivate(deviceApprovalSchema, lease.approval)
        if (approved.workspaceId !== ports.workspaceId || approved.registrationId !== row.id) throw new Error('MCP device workspace or registration changed')
        if (await abortable(ports.service.authorizeRun(target.identity, signal, 'mcp'), signal) !== owner) throw new Error('MCP device owner changed')
        check(); lease.check()
        return { approval: approved, signal: AbortSignal.any([signal, lease.signal]), check: () => { check(); lease.check() } }
    }
    const custody = createApprovedMcpDeviceCustody({
        store, approval, broker: ports.broker, shutdown: ports.service.shutdownSignal, now: ports.now,
        lifecycle: (target, controller) => ports.service.store.lifecycle.admit(target.owner, target.name, controller),
        writeCredential: (approved, token, signal) => ports.service.store.writeOAuth(approved.owner, approved.name, approved.revision, token, signal),
    })
    const shutdown = () => custody.dispose()
    ports.service.shutdownSignal.addEventListener('abort', shutdown, { once: true })
    return { ...custody,
        dispatch: createDesktopMcpLoginBackend(ports.service, ports.watchOwner, custody.fallback),
        dispose() { ports.service.shutdownSignal.removeEventListener('abort', shutdown); custody.dispose() },
    }
}
