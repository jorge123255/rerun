import 'server-only'
import { desktopServiceConnectionSchema, type DesktopServiceConnection, type DesktopServiceHealth, type DesktopServiceRequest, type DesktopServiceRequestCatalog } from '@rerun/contracts'
import { findDesktopServiceRequest } from '@rerun/contracts'
import { EngineRequestError, chat, getSessionMessages } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'
import { engineOf } from '../settings'
import { openDesktopDatabase } from '../database'
import { getDesktopRemoteMcpService } from '../mcp-binding'
import type { DesktopRuntime } from '../runtime'
import type { DesktopAgent, DesktopSession } from '../store'
import { getDesktopServiceManifest, getDesktopServiceMethodAvailability } from '../services/catalog/index'
import { desktopServiceConnectionUsable } from './usable'
import type { FollowUpResponse, SealedReceipt } from './service'

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
        const [db, service] = await Promise.all([openDesktopDatabase(runtime.dataRoot), getDesktopRemoteMcpService(runtime)])
        const authority = await service.services.current(ownerId, 'manage', undefined, signal)
        const rows = await db.execute({ sql: 'SELECT key, revision, slug, state, engine_id, health, health_launch FROM desktop_service_installs WHERE owner = ? ORDER BY installed_at DESC LIMIT 65', args: [ownerId] })
        if (rows.rows.length > 64) return 'unavailable'
        const now = Date.now()
        const connections = rows.rows.map(row => {
            const state = String(row.state)
            const health = JSON.parse(String(row.health)) as DesktopServiceHealth
            if (!installStates.includes(state as typeof installStates[number]) || !health || typeof health.state !== 'string' || !healthStates.includes(health.state as typeof healthStates[number])) throw new Error('Unreadable service installation')
            const usable = desktopServiceConnectionUsable({
                engineId: String(row.engine_id), state, health, healthLaunch: row.health_launch == null ? null : String(row.health_launch),
                authority: { engineAgentId: authority.engineAgentId, enabled: authority.enabled, granted: authority.granted, launchNonce: authority.runtime.launchNonce }, now,
            })
            return desktopServiceConnectionSchema.safeParse({ key: String(row.key), revision: String(row.revision), slug: String(row.slug), state, usable, healthState: health.state })
        })
        if (connections.some(item => !item.success)) return 'unavailable'
        return connections.flatMap(item => item.success ? [item.data] : [])
    } catch {
        return 'unavailable'
    }
}

export async function readDesktopServiceSource(runtime: DesktopRuntime, agent: DesktopAgent, session: DesktopSession, signal: AbortSignal): Promise<DesktopServiceRequest | null> {
    try {
        const messages = await getSessionMessages(engineOf(runtime), agent.engineAgentId, session.engineSessionId, { requireSuccess: true, signal })
        if (messages.some(message => message.sessionId !== session.engineSessionId)) throw new Error('Foreign conversation history')
        return findDesktopServiceRequest(messages)
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
