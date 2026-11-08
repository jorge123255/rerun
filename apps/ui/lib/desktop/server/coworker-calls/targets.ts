import 'server-only'
import { desktopRerunGrantsOf, FOREMAN_AGENT_ID, type DesktopForemanChatRef } from '@rerun/contracts'
import { z } from 'zod'
import type { Client } from '@libsql/client'
import { getAgent } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { openDesktopDatabase } from '../database'
import { withRosterWrite } from '../roster-writes'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { findDesktopAgent } from '../store'
import { listDesktopCoworkerCallTargets, replaceDesktopCoworkerCallAllows, replaceDesktopForemanCallAllows } from './authority'
import { ownedForemanChat } from '../foreman/chat-store'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'

const ids = z.array(z.string().uuid()).max(100)
const patchSchema = z.strictObject({ targetAgentIds: ids, expectedTargetAgentIds: ids })

export async function desktopCoworkerCallTargets(runtime: DesktopRuntime, agentId: string, patch?: unknown, signal?: AbortSignal) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const owner = await findDesktopAgent(db, agentId)
    if (!owner) throw new DesktopHttpError(404, 'Coworker not found.')
    await assertCoworkerNotDeleting(db, agentId)
    signal?.throwIfAborted()
    const detail = await getAgent(engineOf(runtime), owner.engineAgentId)
    if (detail.id !== owner.engineAgentId) throw new DesktopHttpError(409, 'Coworker identity changed.')
    if (patch !== undefined) {
        const input = patchSchema.safeParse(patch)
        if (!input.success) throw new DesktopHttpError(400, 'Choose the allowed coworkers.')
        await withRosterWrite(async () => {
            signal?.throwIfAborted()
            await assertCoworkerNotDeleting(db, agentId)
            const current = await findDesktopAgent(db, agentId)
            if (current?.engineAgentId !== owner.engineAgentId) throw new DesktopHttpError(409, 'Coworker identity changed.')
            await replaceDesktopCoworkerCallAllows(db, agentId, input.data.targetAgentIds, input.data.expectedTargetAgentIds)
        })
    }
    return readTargets(db, agentId, desktopRerunGrantsOf(detail.config.tools).callAgent, signal)
}

export async function desktopForemanCallTargets(runtime: DesktopRuntime, chat: DesktopForemanChatRef, launchNonce: string, patch?: unknown, signal?: AbortSignal) {
    if (chat.workspaceId !== String(runtime.workspaceId) || launchNonce !== runtime.launchNonce) throw new DesktopHttpError(409, 'The Foreman workspace or app launch changed.')
    const db = await openDesktopDatabase(runtime.dataRoot)
    await ownedForemanChat(db, chat)
    signal?.throwIfAborted()
    const detail = await getAgent(engineOf(runtime), FOREMAN_AGENT_ID)
    if (detail.id !== FOREMAN_AGENT_ID || detail.config.kind !== 'foreman' || !detail.config.enabled) throw new DesktopHttpError(409, 'Foreman is unavailable.')
    const grant = desktopRerunGrantsOf(detail.config.tools).callAgent
    if (patch !== undefined) {
        if (!grant) throw new DesktopHttpError(409, 'Turn on Call coworkers for Foreman first.')
        const input = patchSchema.safeParse(patch)
        if (!input.success) throw new DesktopHttpError(400, 'Choose the allowed coworkers.')
        await withRosterWrite(async () => {
            signal?.throwIfAborted()
            assertDesktopWorkspaceAdmission(runtime)
            await replaceDesktopForemanCallAllows(db, chat, input.data.targetAgentIds, input.data.expectedTargetAgentIds)
        })
    }
    return readTargets(db, FOREMAN_AGENT_ID, grant, signal)
}

async function readTargets(db: Client, agentId: string, grant: boolean, signal?: AbortSignal) {
    const targets = await listDesktopCoworkerCallTargets(db, agentId, grant)
    const allowed = await db.execute({ sql: 'SELECT target_agent_id FROM desktop_coworker_call_allows WHERE caller_agent_id=? ORDER BY target_agent_id', args: [agentId] })
    signal?.throwIfAborted()
    return { targets, allowedTargetIds: allowed.rows.map(row => String(row.target_agent_id)) }
}
