import { desktopApiConnectionIdSchema, type DesktopApiPendingRun } from '@rerun/contracts'
import { HttpError } from '../../lib/errors.js'
import { findConnection } from '../../connections/registry.js'
import { connectionUsage } from '../../connections/release.js'
import { listRunsByAgent } from '../../db/repos/runs.js'
import { abortRun, waitForRunCancellation } from '../../runtime/run-control.js'
import { initializeDesktopApiConnections } from './runtime.js'

const UNCAPTURED_REVISION = 'rev_uncaptured'
type Admission = { runId: string; sessionId: string; agentId: string; connectionId: string; connectionRevision: string }

const admissions = new Map<string, Admission>()
const draining = new Set<string>()

function workspaceId(): number | null {
    const id = Number(process.env.RERUN_DESKTOP_WORKSPACE_ID)
    return Number.isSafeInteger(id) && id > 0 ? id : null
}

export async function admitDesktopApiConnectionRun(input: { connectionId: string | undefined; runId: string; sessionId: string; agentId: string }): Promise<void> {
    if (!input.connectionId || !desktopApiConnectionIdSchema.safeParse(input.connectionId).success) return
    if (draining.has(input.connectionId)) throw new HttpError(409, 'This connection is draining pending runs. Nothing new was started.')
    const existing = await findConnection(input.connectionId)
    if (!existing) return
    const workspace = workspaceId()
    let connectionRevision = UNCAPTURED_REVISION
    if (workspace) {
        const store = await initializeDesktopApiConnections()
        connectionRevision = await store.revision(workspace, input.connectionId)
    }
    admissions.set(input.runId, { ...input, connectionId: input.connectionId, connectionRevision })
}

export async function pendingDesktopApiConnectionRuns(connectionId: string): Promise<DesktopApiPendingRun[]> {
    const parsed = desktopApiConnectionIdSchema.parse(connectionId)
    const usage = await connectionUsage(parsed)
    const agentIds = new Set(usage.agents.map(agent => agent.id))
    for (const row of admissions.values()) if (row.connectionId === parsed) agentIds.add(row.agentId)
    const found = new Map<string, DesktopApiPendingRun>()
    for (const agentId of agentIds) {
        const runs = await listRunsByAgent(agentId, { status: 'running', limit: 50 })
        for (const run of runs) {
            if (run.status !== 'running' || run.agentId !== agentId) continue
            const admitted = admissions.get(run.id)
            if (admitted && admitted.connectionId !== parsed) continue
            const pinned = usage.agents.some(agent => agent.id === agentId)
            if (!admitted && !pinned) continue
            found.set(run.id, {
                runId: run.id,
                sessionId: run.sessionId,
                connectionId: parsed,
                connectionRevision: admitted?.connectionRevision ?? UNCAPTURED_REVISION,
                status: admitted ? (draining.has(parsed) ? 'stopping' : 'running') : 'unknown',
            })
        }
    }
    return [...found.values()]
}

export async function stopAndDrainDesktopApiConnectionRuns(connectionId: string): Promise<void> {
    const parsed = desktopApiConnectionIdSchema.parse(connectionId)
    draining.add(parsed)
    try {
        const pending = await pendingDesktopApiConnectionRuns(parsed)
        for (const run of pending) {
            abortRun(run.runId)
            await waitForRunCancellation(run.runId)
            admissions.delete(run.runId)
        }
        const left = await pendingDesktopApiConnectionRuns(parsed)
        if (left.length) throw new HttpError(409, 'Pending runs are still attached to this connection.')
    } finally {
        if ((await pendingDesktopApiConnectionRuns(parsed).catch(() => [{ runId: 'still' }])).length === 0) draining.delete(parsed)
    }
}
