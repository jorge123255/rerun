import 'server-only'
import { z } from 'zod'
import { getAgent, request } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { disabledCoworkerMessage } from '../coworker-enabled'
import { openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { findDesktopAgent, type DesktopAgent } from '../store'

export const ISOLATED_VIEWER_WS_PATH = '/desktop/isolated-viewer-ws'

const screenStatusSchema = z.object({
    state: z.enum(['available', 'unavailable', 'starting', 'taken-over', 'disconnected']),
    reason: z.string().optional(),
    driving: z.boolean().default(false),
    width: z.number().optional(),
    height: z.number().optional(),
})
export type DesktopScreenStatus = z.infer<typeof screenStatusSchema>

const viewTicketSchema = z.object({
    ticket: z.string().min(1),
    expiresAt: z.string(),
    width: z.number(),
    height: z.number(),
})
export type DesktopScreenTicket = z.infer<typeof viewTicketSchema>

const takeoverSchema = z.object({ lease: z.string().min(1).max(500) })
export type DesktopScreenTakeover = z.infer<typeof takeoverSchema>
const takeoverResultSchema = z.object({ url: z.string().nullable(), expired: z.boolean().optional() })

async function screenAgent(runtime: DesktopRuntime, agentId: string, requireEnabled = true): Promise<DesktopAgent> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const agent = await findDesktopAgent(db, agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    if (requireEnabled) {
        await assertCoworkerNotDeleting(db, agentId)
        const current = await getAgent(engineOf(runtime), agent.engineAgentId)
        if (current.id !== agent.engineAgentId) throw new DesktopHttpError(409, 'Coworker identity changed')
        if (!current.config.enabled) throw new DesktopHttpError(409, disabledCoworkerMessage)
    }
    return agent
}

function screenBase(agent: DesktopAgent): string {
    return `/agents/${encodeURIComponent(agent.engineAgentId)}/screen`
}

function viewerSocketUrl(runtime: DesktopRuntime, ticket: string): string {
    const engine = new URL(runtime.engine.origin)
    const scheme = engine.protocol === 'https:' ? 'wss' : 'ws'
    return `${scheme}://${engine.host}${ISOLATED_VIEWER_WS_PATH}?ticket=${encodeURIComponent(ticket)}`
}

export async function desktopScreenStatus(runtime: DesktopRuntime, agentId: string, signal: AbortSignal): Promise<DesktopScreenStatus> {
    const agent = await screenAgent(runtime, agentId)
    const conn = engineOf(runtime)
    try {
        return await request(conn, `${screenBase(agent)}/status?launchNonce=${encodeURIComponent(runtime.launchNonce)}`, { method: 'GET', signal }, d => screenStatusSchema.parse(d))
    } catch (err) {
        if (err instanceof Error && 'status' in err && (err as { status: number }).status === 404) {
            return { state: 'unavailable', driving: false, reason: 'The isolated browser runtime is not installed yet.' }
        }
        throw err
    }
}

export async function desktopScreenTicket(runtime: DesktopRuntime, agentId: string, mode: 'watch' | 'drive', signal: AbortSignal, lease?: string): Promise<{ socketUrl: string; ticket: DesktopScreenTicket }> {
    const agent = await screenAgent(runtime, agentId)
    const conn = engineOf(runtime)
    const ticket = await request(conn, `${screenBase(agent)}/view`, {
        method: 'POST',
        body: JSON.stringify({ mode, launchNonce: runtime.launchNonce, ...(lease && { lease }) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
    }, d => viewTicketSchema.parse(d))
    return { socketUrl: viewerSocketUrl(runtime, ticket.ticket), ticket }
}

export async function desktopScreenTakeover(runtime: DesktopRuntime, agentId: string, signal: AbortSignal, url?: string): Promise<DesktopScreenTakeover> {
    const agent = await screenAgent(runtime, agentId)
    return request(engineOf(runtime), `${screenBase(agent)}/takeover`, {
        method: 'POST',
        body: JSON.stringify({ launchNonce: runtime.launchNonce, ...(url ? { url } : {}) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
    }, d => takeoverSchema.parse(d))
}

export async function desktopScreenFinishTakeover(runtime: DesktopRuntime, agentId: string, lease: string, signal: AbortSignal): Promise<{ url: string | null; expired?: boolean }> {
    const agent = await screenAgent(runtime, agentId, false)
    return request(engineOf(runtime), `${screenBase(agent)}/takeover/finish`, {
        method: 'POST',
        body: JSON.stringify({ launchNonce: runtime.launchNonce, ...(lease ? { lease } : {}) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
    }, d => takeoverResultSchema.parse(d))
}

export async function desktopScreenStop(runtime: DesktopRuntime, agentId: string, signal: AbortSignal): Promise<void> {
    const agent = await screenAgent(runtime, agentId, false)
    await request(engineOf(runtime), `${screenBase(agent)}/stop?launchNonce=${encodeURIComponent(runtime.launchNonce)}`, { method: 'POST', signal }, () => undefined)
}

