import 'server-only'
import { z } from 'zod'
import { request as engineRequest, EngineRequestError, getAgent, listRuns } from '@/lib/engine/client'
import { desktopScheduleRecordSchema, type DesktopWorkspaceRoutineMutation, type DesktopWorkspaceRoutineMutationResult } from '../../../../../../packages/contracts/src/desktop-workspace-routines'
import { openDesktopDatabase } from '../database'
import { findDesktopAgent, listDesktopAgents } from '../store'
import { engineOf } from '../settings'
import type { DesktopRuntime } from '../runtime'
import { DesktopHttpError } from '../auth'
import { authorizeDesktopSchedules } from '../schedules-binding'
import { adoptDesktopScheduledSession } from '../schedules/adoption'
import { createDesktopWorkspaceRoutinesReader, type DesktopWorkspaceRoutinesAuthority } from './reader'
import type { DesktopWorkspaceRoutinesMutationAuthority } from './mutations'

const wire = z.object({ fingerprint: z.string(), reserved: z.boolean().optional(), result: z.object({ schedule: z.object({ slug: z.string() }).passthrough(), revision: z.string(), run: z.object({ runId: z.string(), sessionId: z.string() }).optional() }).nullable() })
export async function desktopWorkspaceRoutinesAuthority(runtime: DesktopRuntime): Promise<DesktopWorkspaceRoutinesAuthority & DesktopWorkspaceRoutinesMutationAuthority> {
    const db = await openDesktopDatabase(runtime.dataRoot), engine = engineOf(runtime)
    async function owner(id: string) { const row = await findDesktopAgent(db, id); if (!row) throw new DesktopHttpError(404, 'Coworker not found'); return row }
    async function records(id: string, signal?: AbortSignal) {
        const o = await owner(id)
        const rows = await engineRequest(engine, `/desktop/workspace-routines/${encodeURIComponent(o.engineAgentId)}`, { method: 'GET', signal, cache: 'no-store' }, value => z.object({ schedules: z.array(z.object({}).passthrough()) }).parse(value).schedules)
        signal?.throwIfAborted()
        if ((await owner(id)).engineAgentId !== o.engineAgentId) throw new DesktopHttpError(409, 'Coworker changed')
        return rows.map(row => desktopScheduleRecordSchema.parse({ agentId: o.id, slug: row.slug, name: row.name, description: row.description, body: row.body, cron: row.cron, runAt: row.runAt, timezone: row.timezone ?? 'UTC', enabled: row.enabled, revision: row.revision, lastRunAt: row.lastRunAt }))
    }
    const read: DesktopWorkspaceRoutinesAuthority = {
        async listOwners(signal) {
            const rows = await listDesktopAgents(db)
            const settled = await Promise.allSettled(rows.filter(row => row.enabled).map(async row => {
                const current = await getAgent(engine, row.engineAgentId)
                signal?.throwIfAborted()
                return { agentId: row.id, engineAgentId: row.engineAgentId, name: row.name, enabled: row.enabled && current.config.enabled, setupPending: current.config.setup?.required === true && !current.config.setup?.completedAt }
            }))
            signal?.throwIfAborted()
            const failed = settled.filter((value): value is PromiseRejectedResult => value.status === 'rejected')
            if (failed.length) throw new DesktopHttpError(503, 'Some coworkers could not be read. Refresh routines before making changes.')
            return settled.flatMap(value => value.status === 'fulfilled' ? [value.value] : [])
        },
        listSchedules: (owner, signal) => records(owner.agentId, signal),
        async listRuns(owner, signal) { return (await listRuns(engine, owner.engineAgentId, { limit: 100 }, { signal })).map(run => ({ id: run.id, agentId: owner.agentId, sessionId: run.sessionId, triggerSource: run.triggerSource ?? 'chat', triggerSlug: run.triggerSlug ?? null, status: run.status, startedAt: run.startedAt })) },
        adopt: (owner, run, signal) => adoptDesktopScheduledSession(db, engine, { agentId: owner.agentId, engineAgentId: owner.engineAgentId, engineSessionId: run.sessionId, runId: run.id }, { signal }),
        canRename: async () => true,
    }
    async function command(input: DesktopWorkspaceRoutineMutation, operation: 'read' | 'mutate', signal?: AbortSignal) {
        const o = await owner(input.agentId)
        let result: z.infer<typeof wire>
        try {
            result = await engineRequest(engine, `/desktop/workspace-routines/${encodeURIComponent(o.engineAgentId)}`, { method: 'POST', body: JSON.stringify({ operation, input }), signal, cache: 'no-store' }, value => wire.parse(value))
        } catch (error) {
            if (error instanceof EngineRequestError) {
                const messages: Record<number, string> = {
                    400: 'Check the routine fields before trying again.',
                    403: 'Enable this coworker and its Schedules permission before running it.',
                    404: 'This routine is no longer available. Refresh the list.',
                    409: 'This routine or its setup changed. Refresh it before starting another test.',
                    503: 'The routine acknowledgement is unknown. Retry this same request.',
                }
                if (messages[error.status]) throw new DesktopHttpError(error.status, messages[error.status])
            }
            throw error
        }
        signal?.throwIfAborted()
        if ((await owner(input.agentId)).engineAgentId !== o.engineAgentId) throw new DesktopHttpError(409, 'Coworker changed')
        if (!result.result) return result.reserved ? { fingerprint: result.fingerprint, result: null, reserved: true } : null
        const current = (await createDesktopWorkspaceRoutinesReader(read).list(signal)).routines.find(row => row.agentId === input.agentId && row.slug === input.slug)
        if (!current) throw new DesktopHttpError(409, 'Routine is no longer available')
        const response: DesktopWorkspaceRoutineMutationResult = { routine: current }
        if (result.result.run) response.chat = await adoptDesktopScheduledSession(db, engine, { agentId: o.id, engineAgentId: o.engineAgentId, engineSessionId: result.result.run.sessionId, runId: result.result.run.runId }, { signal })
        return { fingerprint: result.fingerprint, result: response }
    }
    return { ...read,
        async current(id, slug, signal) { const current = (await records(id, signal)).find(row => row.slug === slug); if (!current) throw new DesktopHttpError(404, 'Routine not found'); return current },
        async authorize(id, signal) { await authorizeDesktopSchedules(runtime, db, (await owner(id)).engineAgentId, signal) },
        receipt: (input, signal) => command(input, 'read', signal),
        async mutate(input, signal) { const result = await command(input, 'mutate', signal); if (!result?.result) throw new DesktopHttpError(503, 'Routine acknowledgement is unknown. Retry the same request.'); return result.result },
    }
}
