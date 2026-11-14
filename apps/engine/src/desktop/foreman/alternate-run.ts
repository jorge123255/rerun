import { FOREMAN_AGENT_ID, foremanAlternateRunSchema, type ForemanAlternateRequest } from '@rerun/contracts'
import { withAgentLock } from '../../agents/lock.js'
import { getAgent } from '../../agents/registry.js'
import { resolveRunModel } from '../../agents/availability.js'
import { lookupForemanAlternate, reserveForemanAlternateRun } from '../../db/repos/foreman-alternate-sessions.js'
import { extractText, storedContent } from '../../db/repos/messages.js'
import { cancelRun, getRun } from '../../db/repos/runs.js'
import { getSystemDb } from '../../db/systemDb.js'
import { HttpError } from '../../lib/errors.js'
import { nowIso } from '../../lib/ids.js'
import { runAgent } from '../../runtime/loop.js'
import { mergeRunStream } from '../../runtime/run-stream-merge.js'
import { releaseSession } from '../../runtime/run-control.js'
import { registerRun } from '../../runtime/stream.js'
import { cancelOwnedRun } from '../../runtime/cancel-run.js'
import { assertDesktopProvider } from '../policy.js'
import { assertDesktopRunAdmission } from '../workspace-admission.js'
import type { createDesktopForemanBridge } from './bridge.js'

type Bridge = ReturnType<typeof createDesktopForemanBridge>

export async function runForemanAlternate(
    action: 'start' | 'stop' | 'status', target: ForemanAlternateRequest,
    bridge: Bridge, current: () => Bridge | undefined, signal: AbortSignal,
) {
    const assertCurrent = () => {
        signal.throwIfAborted()
        if (current() !== bridge || target.workspaceId !== bridge.workspaceId) throw new HttpError(409, 'Foreman app launch changed.')
        if (action === 'start') assertDesktopRunAdmission()
    }
    return withAgentLock(FOREMAN_AGENT_ID, async () => {
        assertCurrent()
        const saved = await lookupForemanAlternate(target)
        if (!saved) throw new HttpError(404, 'Chief of Staff alternate not found.')
        const { sessionId, runId } = saved
        const result = (status: string) => foremanAlternateRunSchema.parse({ sessionId, runId, status })
        const existing = await getRun(FOREMAN_AGENT_ID, runId)
        if (existing && (existing.agentId !== FOREMAN_AGENT_ID || existing.sessionId !== sessionId)) {
            throw new HttpError(409, 'Chief of Staff alternate ownership changed.')
        }
        if (action === 'status' || (action === 'start' && existing)) {
            await bridge.authorizeAlternate('lookup', target, signal)
            assertCurrent()
            return result(existing?.status ?? 'prepared')
        }
        const authority = await bridge.alternateRunAuthority(action, target, signal)
        assertCurrent()
        if (authority.sessionId !== sessionId || authority.runId !== runId) {
            throw new HttpError(409, 'Chief of Staff alternate ownership changed.')
        }
        if (action === 'stop') {
            if (!existing) {
                // A terminal row consumes the reserved run ID even when Stop arrives before Start.
                const { client } = await getSystemDb(FOREMAN_AGENT_ID)
                const now = nowIso()
                assertCurrent()
                await client.execute({
                    sql: "INSERT INTO runs (id,agent_id,session_id,started_at,finished_at,status) VALUES (?,?,?,?,?,'cancelled')",
                    args: [runId, FOREMAN_AGENT_ID, sessionId, now, now],
                })
                return result('cancelled')
            }
            if (existing.status !== 'running') return result(existing.status)
            const stopped = await cancelOwnedRun(existing)
            if (stopped.state === 'waiting') throw new HttpError(503, 'Wait for this retry to stop, then try again.')
            const settled = await getRun(FOREMAN_AGENT_ID, runId)
            if (!settled) throw new HttpError(409, 'Chief of Staff alternate ownership changed.')
            return result(settled.status)
        }

        const model = authority.model
        if (!model) throw new HttpError(409, 'The original reply model is unavailable.')
        const agent = await getAgent(FOREMAN_AGENT_ID)
        if (agent.id !== FOREMAN_AGENT_ID || agent.config.kind !== 'foreman' || !agent.config.enabled) {
            throw new HttpError(409, 'The managed Chief of Staff is unavailable.')
        }
        const resolved = await resolveRunModel(agent, model)
        if (resolved.connection?.id !== model.connectionId || resolved.model !== model.model) {
            throw new HttpError(409, 'The original reply model is unavailable.')
        }
        assertDesktopProvider(resolved.provider, resolved.connection?.id)
        const { user } = await reserveForemanAlternateRun(target, assertCurrent)
        registerRun(runId, async writer => {
            try {
                const run = await runAgent(agent, sessionId, extractText(storedContent(user.contentJson)), model, writer, runId,
                    { source: 'chat', savedUser: user, foremanAlternate: true })
                mergeRunStream(writer, run, { provider: resolved.provider, model: resolved.model })
            } catch (error) {
                await cancelRun(FOREMAN_AGENT_ID, runId)
                releaseSession(runId)
                throw error
            }
        })
        return result('running')
    })
}
