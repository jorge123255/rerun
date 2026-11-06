import { findDesktopMcpSignInCall } from '../mcp-sign-in/source.js'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { InStatement } from '@libsql/client'
import { findDesktopQuestion, findDesktopApproval, findDesktopTakeover, findDesktopServiceRequest, findDesktopSecretRequest, hitlKindOf } from '@rerun/contracts'
import { getSystemDb } from '../../db/systemDb.js'
import { getSession } from '../../db/repos/sessions.js'
import { getRun, cancelRun } from '../../db/repos/runs.js'
import { listMessages } from '../../db/repos/messages.js'
import type { MessageRow } from '../../db/schema.js'
import type { QueuedTurn } from '../../db/repos/desktop-queued-turns.js'
import { withAgentLock } from '../../agents/lock.js'
import { getAgent } from '../../agents/registry.js'
import { abortRun, waitForRunCancellation } from '../../runtime/run-control.js'
import { HttpError } from '../../lib/errors.js'
import { hasDesktopToolGrant } from '../tool-grants.js'
import { desktopTriggerDefinitionRevision } from './lifecycle.js'
import { readDesktopTriggerRuntime } from './runtime.js'

export { DESKTOP_TRIGGER_HUMAN_SQL } from './human-schema.js'

const id = z.string().min(1).max(256)
export const triggerHumanSourceSchema = z.strictObject({ eventId: id, sessionId: id, sourceRunId: id, sourceMessageId: id, toolCallId: id, kind: z.enum(['question','approval','takeover','service','secret','signin']) })
type Source = z.infer<typeof triggerHumanSourceSchema>
const keyOf = (source: Source) => createHash('sha256').update(JSON.stringify([source.eventId,source.sessionId,source.sourceRunId,source.sourceMessageId,source.toolCallId,source.kind])).digest('hex')
function binding() { const value = readDesktopTriggerRuntime(); if (!value) throw new HttpError(503, 'Webhook authority is unavailable.'); value.authority.assertActive(); return value }

export async function readTriggerEventForSession(agentId: string, sessionId: string) {
    const session = await getSession(agentId, sessionId)
    if (!session || session.agentId !== agentId) throw new HttpError(404, 'Conversation not found.')
    if (session.source !== 'trigger') return null
    const source = binding(), { client } = await getSystemDb(agentId)
    const rows = (await client.execute({ sql: 'SELECT event_id FROM desktop_trigger_events WHERE engine_session_id=? LIMIT 2', args: [sessionId] })).rows
    if (rows.length !== 1) throw new HttpError(409, 'Webhook conversation source is ambiguous.')
    const event = await source.store.getEvent(agentId, String(rows[0].event_id))
    if (!event || event.engineSessionId !== sessionId || !event.runId) throw new HttpError(409, 'Webhook source receipt is unavailable.')
    return event
}
async function exactSource(agentId: string, source: Source, current = true) {
    const event = await readTriggerEventForSession(agentId, source.sessionId)
    if (!event || event.eventId !== source.eventId) throw new HttpError(409, 'Webhook source changed.')
    const { client } = await getSystemDb(agentId)
    const run = await getRun(agentId, source.sourceRunId)
    if (!run || run.agentId !== agentId || run.sessionId !== source.sessionId) throw new HttpError(409, 'Webhook request run changed.')
    if (source.sourceRunId !== event.runId) {
        const owned = (await client.execute({ sql: 'SELECT 1 FROM desktop_trigger_human_admissions WHERE event_id=? AND session_id=? AND run_id=?', args: [source.eventId,source.sessionId,source.sourceRunId] })).rows
        if (owned.length !== 1) throw new HttpError(409, 'The request is not from an admitted webhook continuation.')
    } else if (run.triggerSource !== 'trigger' || run.triggerSlug !== event.slug) throw new HttpError(409, 'Webhook source run changed.')
    const calls = (await client.execute({ sql: 'SELECT tool_name,is_error FROM tool_calls WHERE agent_id=? AND session_id=? AND run_id=? AND tool_call_id=? LIMIT 2', args: [agentId,source.sessionId,source.sourceRunId,source.toolCallId] })).rows
    if (calls.length !== 1 || Number(calls[0].is_error) !== 0 || hitlKindOf(String(calls[0].tool_name)) !== (source.kind === 'signin' ? 'mcp' : source.kind)) throw new HttpError(409, 'Webhook human tool source changed.')
    if (current) {
        const rows = await listMessages(agentId,source.sessionId)
        const found = source.kind === 'question' ? findDesktopQuestion(rows) : source.kind === 'approval' ? findDesktopApproval(rows) : source.kind === 'takeover' ? findDesktopTakeover(rows) : source.kind === 'service' ? findDesktopServiceRequest(rows) : source.kind === 'secret' ? findDesktopSecretRequest(rows) : findDesktopMcpSignInCall(rows)
        if (!found || found.sourceMessageId !== source.sourceMessageId || found.toolCallId !== source.toolCallId) throw new HttpError(409, 'Webhook human request is no longer current.')
    }
    return { event, run, client }
}
export async function assertTriggerHumanPermission(agentId: string, source: Source) {
    const { event, run, client } = await exactSource(agentId,source)
    const runtime = binding(), owner = await runtime.authority.resolveOwnerByEngineId(agentId)
    if (!owner.enabled || owner.deleting || event.stopRequestId || event.status === 'cancelled' || run.status !== 'done') throw new HttpError(409, 'Webhook request is stopped or unavailable.')
    if ((await client.execute({ sql: 'SELECT 1 FROM desktop_trigger_human_stops WHERE source_key=?', args: [keyOf(source)] })).rows.length) throw new HttpError(409, 'Webhook request was stopped.')
    await runtime.authority.assertTriggerGrant(agentId)
    await runtime.authority.assertSetupClear(agentId)
    const definition = await runtime.authority.readTrigger(agentId,event.slug)
    if (!definition || !definition.enabled || desktopTriggerDefinitionRevision(definition) !== event.revision) throw new HttpError(409, 'Webhook definition changed since this request.')
    const agent = await getAgent(agentId)
    const grants = { question:'askUser',approval:'requestApproval',takeover:'browser',service:'suggestService',secret:'requestSecret',signin:'mcp' } as const
    if (!agent.config.enabled || !hasDesktopToolGrant(agent.config,grants[source.kind])) throw new HttpError(403, 'The permission for this webhook request is off.')
    runtime.authority.assertActive()
}
/** Called under the config lock and session claim. Its row commits with the actual queued turn. */
export async function prepareTriggerHumanAdmission(agentId: string, turn: QueuedTurn): Promise<InStatement[]> {
    const guards = (['question','approval','takeover','service','secret','mcpSignIn'] as const).flatMap(kind => turn[kind] ? [{ kind,guard: turn[kind]! }] : [])
    const event = await readTriggerEventForSession(agentId,turn.sessionId)
    if (!event || !guards.length) return []
    if (guards.length !== 1) throw new HttpError(409, 'Answer exactly one webhook request.')
    const { kind,guard } = guards[0], { client } = await getSystemDb(agentId)
    const calls = (await client.execute({ sql:'SELECT run_id FROM tool_calls WHERE agent_id=? AND session_id=? AND tool_call_id=? LIMIT 2',args:[agentId,turn.sessionId,guard.toolCallId] })).rows
    if (calls.length !== 1) throw new HttpError(409,'Webhook source run is ambiguous.')
    const source: Source = { eventId:event.eventId, sessionId:turn.sessionId, sourceRunId:String(calls[0].run_id),sourceMessageId:guard.sourceMessageId,toolCallId:guard.toolCallId,kind:kind === 'mcpSignIn' ? 'signin' : kind }
    await assertTriggerHumanPermission(agentId,source)
    return [{ sql: 'INSERT INTO desktop_trigger_human_admissions(source_key,event_id,session_id,source_run_id,source_message_id,tool_call_id,kind,run_id) VALUES(?,?,?,?,?,?,?,?)', args: [keyOf(source),source.eventId,source.sessionId,source.sourceRunId,source.sourceMessageId,source.toolCallId,source.kind,turn.runId] }]
}
export async function stopTriggerHumanRequest(agentId: string, raw: unknown, receiptOnly = false) {
    const input = z.strictObject({ source:triggerHumanSourceSchema,requestId:z.uuid() }).parse(raw)
    const source = input.source, key = keyOf(source)
    return withAgentLock(agentId,async () => {
        const { event,run,client } = await exactSource(agentId,source,false)
        let saved = (await client.execute({sql:'SELECT * FROM desktop_trigger_human_stops WHERE source_key=?',args:[key]})).rows[0]
        if (saved && saved.request_id !== input.requestId) throw new HttpError(409,'This webhook Stop belongs to another request.')
        if (receiptOnly) return { status:saved?.state === 'stopped' ? 'stopped' : 'unknown' }
        if (saved?.state === 'stopped') return {status:'stopped'}
        if (!saved) {
            await exactSource(agentId,source)
            if ((await client.execute({sql:'SELECT 1 FROM desktop_trigger_human_admissions WHERE source_key=?',args:[key]})).rows.length) throw new HttpError(409,'The webhook answer was already admitted.')
            await client.batch([
                {sql:'INSERT INTO desktop_trigger_human_stops(source_key,request_id,event_id,session_id,source_run_id,source_message_id,tool_call_id,kind,state) VALUES(?,?,?,?,?,?,?,?,\'pending\')',args:[key,input.requestId,source.eventId,source.sessionId,source.sourceRunId,source.sourceMessageId,source.toolCallId,source.kind]},
                {sql:'UPDATE desktop_trigger_events SET stop_request_id=? WHERE event_id=?',args:[input.requestId,event.eventId]},
            ],'write')
        }
        if (run.status === 'running') { abortRun(run.id); if (!await waitForRunCancellation(run.id)) throw new HttpError(409,'Webhook reply is still stopping. Retry this Stop.'); if ((await getRun(agentId,run.id))?.status === 'running') await cancelRun(agentId,run.id) }
        await client.batch([
            {sql:"UPDATE desktop_trigger_human_stops SET state='stopped' WHERE source_key=? AND request_id=?",args:[key,input.requestId]},
            {sql:"UPDATE desktop_trigger_events SET status='cancelled',finished_at=? WHERE event_id=? AND stop_request_id=?",args:[new Date().toISOString(),event.eventId,input.requestId]},
        ],'write')
        return {status:'stopped'}
    })
}
/** Pending-form checks ignore a stopped call, while the displayed transcript stays unchanged. */
export async function withoutStoppedTriggerRequests(agentId: string, sessionId: string, rows: MessageRow[]): Promise<MessageRow[]> {
    if ((await getSession(agentId,sessionId))?.source !== 'trigger') return rows
    const {client} = await getSystemDb(agentId)
    const stopped = (await client.execute({sql:'SELECT source_message_id FROM desktop_trigger_human_stops WHERE session_id=?',args:[sessionId]})).rows
    const ids = new Set(stopped.map(row=>String(row.source_message_id)))
    return ids.size ? rows.filter(row=>!ids.has(row.id)) : rows
}
