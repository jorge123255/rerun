import { withoutStoppedWebhookForms } from '../trigger-requests/stopped'
import 'server-only'
import { desktopServiceConnectionSchema, type DesktopServiceChoice, type DesktopServiceConnection, type DesktopServiceHealth, type DesktopServiceRequest, type DesktopServiceRequestCatalog } from '@rerun/contracts'
import { findDesktopServiceRequest } from '@rerun/contracts'
import { EngineRequestError, chat, getSessionMessages } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'
import { engineOf } from '../settings'
import { openDesktopDatabase } from '../database'
import { getDesktopRemoteMcpService } from '../mcp-binding'
import type { DesktopRuntime } from '../runtime'
import type { DesktopAgent, DesktopSession } from '../store'
import { getDesktopServiceManifest, getDesktopServiceMethodAvailability } from '../services/catalog/index'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'
import { attachServiceVaultAccounts, readServiceVaultAccounts, vaultConnection } from './vault'
import { desktopServiceConnectionUsable } from './usable'
import type { FollowUpResponse, SealedReceipt, ServiceRequestDatabase, ServiceRequestSealAuthority } from './service'

const installStates = ['preparing', 'ready', 'error', 'disconnected', 'removing'] as const
const healthStates = ['unchecked', 'healthy', 'error', 'disconnected'] as const

function bounded(value: string, max: number): string | null {
    const text = value.trim()
    return text.length > 0 && text.length <= max ? text : null
}

export async function describeDesktopServiceRequestCatalog(slug: string): Promise<DesktopServiceRequestCatalog> {
    try {
        const record = getDesktopServiceManifest(slug)
        const name = bounded(record.name, 200)
        const category = bounded(record.category, 100)
        if (!name || !category || record.summary.length > 4_000) return { status: 'unavailable' }
        const methods = record.manifest.authMethods.slice(0, 20).map(method => {
            const availability = getDesktopServiceMethodAvailability(record.slug, method.id)
            return { id: availability.id, supported: availability.supported, ...(availability.reason ? { reason: availability.reason.slice(0, 300) } : {}) }
        })
        const supported = methods.some(method => method.supported)
        const unsupportedReason = methods.find(method => !method.supported && method.reason)?.reason
        return {
            status: supported ? 'available' : 'unsupported-auth',
            name, category, summary: record.summary, icon: record.icon && record.icon.length <= 2_000 ? record.icon : null,
            verified: record.verified === true, connected: false, authentication: supported ? 'supported' : 'unsupported',
            ...(unsupportedReason ? { unsupportedReason } : {}), methods,
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (message.startsWith('Service not found:')) return { status: 'not-found' }
        return { status: 'unavailable' }
    }
}

export async function readDesktopServiceConnections(runtime: DesktopRuntime, ownerId: string, signal: AbortSignal): Promise<DesktopServiceConnection[] | 'unavailable'> {
    try {
        const db = await openDesktopDatabase(runtime.dataRoot)
        const snapshot = await prepareDesktopServiceSeal(runtime, ownerId, signal)
        const connections = await snapshot.installations(db)
        snapshot.check()
        return connections
    } catch {
        return 'unavailable'
    }
}

export async function readDesktopServiceVaultOffers(runtime: DesktopRuntime, ownerId: string, signal: AbortSignal) {
    const [db, service] = await Promise.all([openDesktopDatabase(runtime.dataRoot), getDesktopRemoteMcpService(runtime)])
    const authority = await service.services.current(ownerId, 'manage', undefined, signal)
    if (!authority.enabled || !authority.granted || !authority.check) return []
    const accounts = await readServiceVaultAccounts(db, ownerId, runtime.launchNonce)
    authority.check()
    signal.throwIfAborted()
    return accounts.filter(account => !account.attached && Date.now() < account.expires).map(account => account.view)
}

/** Network/config reads happen before the write transaction. Exact installation rows
 * are then read on that transaction; synchronous lifecycle guards fence local changes. */
export async function prepareDesktopServiceSeal(runtime: DesktopRuntime, ownerId: string, signal: AbortSignal): Promise<ServiceRequestSealAuthority> {
    const [db, service] = await Promise.all([openDesktopDatabase(runtime.dataRoot), getDesktopRemoteMcpService(runtime)])
    const authority = await service.services.current(ownerId, 'manage', undefined, signal)
    if (!authority.check) throw new DesktopHttpError(502, 'Current app permission could not be confirmed.')
    const initial = await db.execute({ sql: 'SELECT id FROM desktop_service_installs WHERE owner = ? ORDER BY id LIMIT 65', args: [ownerId] })
    if (initial.rows.length > 64) throw new DesktopHttpError(502, 'App connections could not be read.')
    const ids = initial.rows.map(row => String(row.id))
    const guards = [service.services.lifecycle.watch(ownerId, ''), ...ids.map(id => service.services.lifecycle.watch(ownerId, `svc-${id.replaceAll('-', '')}`))]
    let freshUntil = Infinity
    const check = () => {
        signal.throwIfAborted()
        assertDesktopWorkspaceAdmission(runtime)
        try { authority.check!(); for (const guard of guards) guard() } catch {
            throw new DesktopHttpError(409, 'App permission or a connection changed. Refresh the card before finishing.')
        }
        if (Date.now() >= freshUntil) throw new DesktopHttpError(409, 'App connection health expired. Refresh the connection before finishing.')
    }
    check()
    return { check, async installations(query: ServiceRequestDatabase, choices?: DesktopServiceChoice[]) {
        check()
        const owner = (await query.execute({ sql: 'SELECT engine_agent_id, enabled FROM desktop_agents WHERE id = ?', args: [ownerId] })).rows[0]
        if (!owner || owner.engine_agent_id !== authority.engineAgentId || Boolean(Number(owner.enabled)) !== authority.enabled) throw new DesktopHttpError(409, 'Coworker identity or permission changed. Refresh the conversation.')
        const rows = await query.execute({ sql: 'SELECT id, key, revision, slug, state, engine_id, health, health_launch FROM desktop_service_installs WHERE owner = ? ORDER BY id LIMIT 65', args: [ownerId] })
        if (JSON.stringify(rows.rows.map(row => String(row.id))) !== JSON.stringify(ids)) throw new DesktopHttpError(409, 'App connections changed. Refresh the card before finishing.')
        const now = Date.now()
        const connections = rows.rows.map(row => {
            const state = String(row.state)
            const health = JSON.parse(String(row.health)) as DesktopServiceHealth
            if (!installStates.includes(state as typeof installStates[number]) || !health || typeof health.state !== 'string' || !healthStates.includes(health.state as typeof healthStates[number])) throw new Error('Unreadable service installation')
            const usable = desktopServiceConnectionUsable({
                engineId: String(row.engine_id), state, health, healthLaunch: row.health_launch == null ? null : String(row.health_launch),
                authority: { engineAgentId: authority.engineAgentId, enabled: authority.enabled, granted: authority.granted, launchNonce: authority.runtime.launchNonce }, now,
            })
            if (usable) freshUntil = Math.min(freshUntil, Date.parse(health.checkedAt ?? '') + 60_000)
            return desktopServiceConnectionSchema.safeParse({ key: String(row.key), revision: String(row.revision), slug: String(row.slug), state, usable, healthState: health.state })
        })
        if (connections.some(item => !item.success)) return 'unavailable'
        const installed = connections.flatMap(item => item.success ? [item.data] : [])
        const accounts = authority.enabled && authority.granted ? await readServiceVaultAccounts(query, ownerId, runtime.launchNonce) : []
        const selected = choices ? await attachServiceVaultAccounts(query, ownerId, accounts, choices) : []
        const vault = accounts.filter(account => account.attached || selected.includes(account))
        for (const account of vault) {
            if (!choices || selected.includes(account)) freshUntil = Math.min(freshUntil, account.expires)
        }
        check()
        return [...installed, ...vault.map(vaultConnection)]
    } }
}

export async function readDesktopServiceSource(runtime: DesktopRuntime, agent: DesktopAgent, session: DesktopSession, signal: AbortSignal): Promise<DesktopServiceRequest | null> {
    try {
        const messages = await getSessionMessages(engineOf(runtime), agent.engineAgentId, session.engineSessionId, { requireSuccess: true, signal })
        if (messages.some(message => message.sessionId !== session.engineSessionId)) throw new Error('Foreign conversation history')
        return findDesktopServiceRequest(await withoutStoppedWebhookForms(await openDesktopDatabase(runtime.dataRoot),agent.id,session.id,messages))
    } catch (cause) {
        if (cause instanceof EngineRequestError && cause.status === 404) throw new DesktopHttpError(404, 'Conversation not found')
        if (cause instanceof DesktopHttpError) throw cause
        throw new DesktopHttpError(502, 'Could not read this coworker’s app setup. Try again.')
    }
}

// Root must accept `service` on desktopQueuedTurn before this send can be admitted. Until then the engine refuses the field.
export async function sendDesktopServiceFollowUp(runtime: DesktopRuntime, agent: DesktopAgent, session: DesktopSession, receipt: SealedReceipt, mode: 'send' | 'replay'): Promise<FollowUpResponse> {
    const response = await chat(engineOf(runtime), agent.engineAgentId, {
        sessionId: session.engineSessionId, message: receipt.text, source: 'dashboard', author: { id: 'local-profile-1', name: 'Local User' },
        desktopQueuedTurn: { runId: receipt.requestId, ...(mode === 'replay' ? { replayOnly: true } : {}), service: receipt.guard },
    } as Parameters<typeof chat>[2])
    const engineSessionId = response.headers.get('x-session-id')
    const failure = response.ok ? null : await response.clone().json().catch(() => null) as { code?: string } | null
    return {
        status: response.status, code: failure?.code, contentType: response.headers.get('content-type'),
        sessionId: engineSessionId === session.engineSessionId ? session.id : engineSessionId,
        runId: response.headers.get('x-run-id'), body: response.ok ? response.body : null,
    }
}
