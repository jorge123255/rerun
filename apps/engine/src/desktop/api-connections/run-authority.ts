import { desktopApiConnectionIdSchema, type DesktopApiPendingRun } from '@rerun/contracts'
import { HttpError } from '../../lib/errors.js'
import { findConnection } from '../../connections/registry.js'
import { listRunsByAgent } from '../../db/repos/runs.js'
import { abortRun, waitForRunCancellation } from '../../runtime/run-control.js'
import { initializeDesktopApiConnections } from './runtime.js'
import { listAgentIdsOnDisk } from '../../agents/loader.js'
import type { LoadedConnection } from '../../connections/types.js'
import { beginDesktopApiConnectionWork } from './admission.js'
import { withDesktopApiConnectionMutationLock } from './mutation-lock.js'

const UNCAPTURED_REVISION = 'rev_uncaptured'
type Admission = { runId: string; sessionId: string; agentId: string; connectionId: string; connectionRevision: string }

const admissions = new Map<string, Admission>()
const draining = new Set<string>()

function workspaceId(): number | null {
    const id = Number(process.env.RERUN_DESKTOP_WORKSPACE_ID)
    return Number.isSafeInteger(id) && id > 0 ? id : null
}

export async function admitDesktopApiConnectionRun(input: { connectionId: string | undefined; runId: string; sessionId: string; agentId: string; expectedConnection?: LoadedConnection }): Promise<() => void> {
    if (!input.connectionId || !desktopApiConnectionIdSchema.safeParse(input.connectionId).success) return () => {}
    const connectionId = input.connectionId
    const workspace = workspaceId()
    if (!workspace) throw new HttpError(503, 'This connection cannot start until the workspace identity is confirmed.')
    const releaseWork = beginDesktopApiConnectionWork()
    if (!releaseWork) throw new HttpError(409, 'This connection is being removed. Nothing new was started.')
    try {
        return await withDesktopApiConnectionMutationLock(workspace, async () => {
            if (draining.has(connectionId)) throw new HttpError(409, 'This connection is draining pending runs. Nothing new was started.')
            const existing = await findConnection(connectionId)
            if (!existing || input.expectedConnection && existing !== input.expectedConnection) throw new HttpError(409, 'This connection changed during preparation. Nothing new was started.')
            const store = await initializeDesktopApiConnections()
            const connectionRevision = await store.revision(workspace, connectionId)
            // Refuse drift even from a noncanonical replacement during capture.
            if (await findConnection(connectionId) !== existing) throw new HttpError(409, 'This connection changed during preparation. Nothing new was started.')
            if (draining.has(connectionId)) throw new HttpError(409, 'This connection is draining pending runs. Nothing new was started.')
            const admitted: Admission = { runId: input.runId, sessionId: input.sessionId, agentId: input.agentId, connectionId, connectionRevision }
            admissions.set(input.runId, admitted)
            return () => { if (admissions.get(input.runId) === admitted) admissions.delete(input.runId) }
        })
    } finally { releaseWork() }
}

export async function pendingDesktopApiConnectionRuns(connectionId: string): Promise<DesktopApiPendingRun[]> {
    const parsed = desktopApiConnectionIdSchema.parse(connectionId)
    // A workspace default or a headless task can use this connection without a
    // current agent-config pin. Enumerate the workspace and keep unproven work
    // protected instead of interpreting an empty chat-admission map as idle.
    const agentIds = new Set(await listAgentIdsOnDisk())
    for (const row of admissions.values()) {
        if (!agentIds.has(row.agentId)) admissions.delete(row.runId)
    }
    const found = new Map<string, DesktopApiPendingRun>()
    for (const agentId of agentIds) {
        const runs = await listRunsByAgent(agentId, { status: 'running', limit: 50 })
        if (runs.length >= 50) throw new HttpError(409, 'There are too many active runs to confirm safe connection removal. Wait for them to finish.')
        for (const run of runs) {
            if (run.status !== 'running' || run.agentId !== agentId) continue
            const admitted = admissions.get(run.id)
            if (admitted && admitted.connectionId !== parsed) continue
            // A saved pin/default is not proof of an already-running turn's
            // original connection, so all unclassified rows remain unknown.
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
        if (pending.some(run => run.status === 'unknown')) throw new HttpError(409, 'A run’s connection is unconfirmed. Stop it in its own conversation before removing this connection.')
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
