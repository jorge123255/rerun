import 'server-only'
import { z, ZodError } from 'zod'
import {
    DESKTOP_COWORKER_CALL_INTERRUPTED_REASON,
    desktopCoworkerCallListSchema,
    desktopCoworkerCallProgressSchema,
    desktopCoworkerCallSnapshotOf,
    desktopCoworkerCallStatuses,
    desktopCoworkerCallStopSchema,
} from '../../../../../../packages/contracts/src/desktop-coworker-calls.ts'
import { DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { createDesktopSession, findDesktopSession, findDesktopAgent } from '../store'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { assertDesktopSetupChatAllowed } from '../setup/service'
import { resolveDesktopChatModel } from '../chat-model'
import { readDesktopQuestion } from '../questions'
import { readDesktopApproval } from '../approvals'
import { readDesktopTakeover } from '../takeover'
import { readPendingDesktopServiceToolCallView } from '../service-requests/view'
import { getSession } from '@/lib/engine/client'
import { engineOf } from '../settings'
import { withRosterWrite } from '../roster-writes'
import { authorizeDesktopCoworkerCall } from './authority'
import {
    adoptDesktopCoworkerCallEpoch,
    claimDesktopCoworkerCall,
    DESKTOP_COWORKER_CALL_ACTIVE,
    getDesktopCoworkerCall,
    getDesktopCoworkerCallBySource,
    inboundDesktopCoworkerCall,
    initializeDesktopCoworkerCalls,
    insertDesktopCoworkerCall,
    listDesktopCoworkerCallRows,
    patchDesktopCoworkerCall,
    readDesktopCoworkerCallStop,
    reserveDesktopCoworkerCallStop,
    saveDesktopCoworkerCallStop,
    coworkerCallRowSchema,
    type CoworkerCallExpect,
    type CoworkerCallPatch,
    type CoworkerCallRecord,
} from './db'

const serverId = z.string().trim().min(1).max(256)
const bridgePatchSchema = z.strictObject({
    targetSessionId: serverId.nullable().optional(),
    status: z.enum(desktopCoworkerCallStatuses).optional(),
    phase: z.enum(['reserved', 'session-open', 'launched', 'terminal']).optional(),
    engineTargetSessionId: serverId.nullable().optional(),
    engineChildRunId: serverId.nullable().optional(),
    progress: desktopCoworkerCallProgressSchema.optional(),
    pendingToolCallId: serverId.nullable().optional(),
    resultText: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    stopRequestId: z.string().uuid().nullable().optional(),
    launchClaimed: z.boolean().optional(),
})
const bridgeExpectSchema = z.strictObject({
    revision: z.number().int().positive().optional(),
    statuses: z.array(z.enum(desktopCoworkerCallStatuses)).optional(),
    engineChildRunId: serverId.nullable().optional(),
    stopUnclaimed: z.boolean().optional(),
    stopRequestId: z.string().uuid().nullable().optional(),
})

// The strict snapshot schema rejects every server field that is not part of the public contract.
function snapshot(row: CoworkerCallRecord) {
    return desktopCoworkerCallSnapshotOf({
        callId: row.callId,
        revision: row.revision,
        parentAgentId: row.parentAgentId,
        parentSessionId: row.parentSessionId,
        parentRunId: row.parentRunId,
        toolCallId: row.toolCallId,
        targetAgentId: row.targetAgentId,
        targetSessionId: row.targetSessionId,
        targetName: row.targetName,
        wait: row.wait,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        progress: row.progress,
    })
}

async function recoverCalledChat(runtime: DesktopRuntime, row: CoworkerCallRecord): Promise<CoworkerCallRecord> {
    if (row.phase !== 'terminal' || row.targetSessionId || !row.engineTargetSessionId) return row
    const db = await openDesktopDatabase(runtime.dataRoot)
    try {
        const session = await getSession(engineOf(runtime), row.engineTargetAgentId, row.engineTargetSessionId, { signal: AbortSignal.timeout(5000) })
        if (!session || session.id !== row.engineTargetSessionId || session.agentId !== row.engineTargetAgentId || session.source !== 'agent' || session.originAgentId !== row.engineParentAgentId || session.originSessionId !== row.engineParentSessionId) return row
        return await withRosterWrite(async () => {
            const current = await getDesktopCoworkerCall(db, row.callId)
            const owner = await findDesktopAgent(db, row.targetAgentId)
            if (!current || current.phase !== 'terminal' || current.targetSessionId || current.engineTargetSessionId !== session.id || current.engineTargetAgentId !== row.engineTargetAgentId || owner?.engineAgentId !== row.engineTargetAgentId) return current ?? row
            await assertCoworkerNotDeleting(db, owner.id)
            const chat = await createDesktopSession(db, { agentId: owner.id, engineSessionId: session.id, title: session.title })
            // Retired epochs cannot update execution state. Recover only this verified local link.
            await db.execute({
                sql: `UPDATE desktop_coworker_calls SET target_session_id=?, revision=revision+1, updated_at=?
                    WHERE call_id=? AND revision=? AND phase='terminal' AND target_session_id IS NULL
                        AND target_agent_id=? AND engine_target_agent_id=? AND engine_target_session_id=?`,
                args: [chat.id, new Date().toISOString(), current.callId, current.revision, owner.id, session.agentId, session.id],
            })
            return await getDesktopCoworkerCall(db, current.callId) ?? current
        })
    } catch { return row } // A failed read never creates or replays an engine run.
}

async function currentSnapshot(runtime: DesktopRuntime, row: CoworkerCallRecord) {
    const result = snapshot(row)
    if (row.status !== 'waiting-human' || row.phase !== 'terminal' || !row.pendingToolCallId || !row.targetSessionId) return result
    const db = await openDesktopDatabase(runtime.dataRoot)
    const session = await findDesktopSession(db, row.targetSessionId)
    const owner = await findDesktopAgent(db, row.targetAgentId)
    if (!session || session.agentId !== row.targetAgentId || session.engineSessionId !== row.engineTargetSessionId || owner?.engineAgentId !== row.engineTargetAgentId) throw new DesktopHttpError(409, 'The called conversation is no longer available.')
    await assertCoworkerNotDeleting(db, row.targetAgentId)
    const signal = AbortSignal.timeout(5_000)
    const options = { signal }
    if ((await readDesktopQuestion(runtime, session.id, options)).question?.toolCallId === row.pendingToolCallId) return result
    if ((await readDesktopApproval(runtime, session.id, options)).approval?.toolCallId === row.pendingToolCallId) return result
    if ((await readDesktopTakeover(runtime, session.id, options)).takeover?.toolCallId === row.pendingToolCallId) return result
    if (await readPendingDesktopServiceToolCallView(runtime, session.id, options) === row.pendingToolCallId) return result
    return { ...result, status: 'completed' as const }
}

export async function readDesktopCoworkerCalls(runtime: DesktopRuntime, sessionId: string) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    await initializeDesktopCoworkerCalls(db)
    const session = await findDesktopSession(db, sessionId)
    if (!session || session.agentId == null) throw new DesktopHttpError(404, 'Conversation not found.')
    const calls = []
    for (const row of await listDesktopCoworkerCallRows(db, session.id)) calls.push(await currentSnapshot(runtime, await recoverCalledChat(runtime, row)))
    return desktopCoworkerCallListSchema.parse({ calls })
}

const NO_STORE = { 'cache-control': 'no-store' }

async function cancelChild(runtime: DesktopRuntime, engineAgentId: string, engineRunId: string, fetchImpl: typeof fetch): Promise<'cancelled' | 'missing' | 'unavailable'> {
    const stop = AbortSignal.timeout(10_000)
    let response: Response
    try {
        response = await fetchImpl(`${runtime.engine.origin}/agents/${encodeURIComponent(engineAgentId)}/runs/${encodeURIComponent(engineRunId)}/cancel`, {
            method: 'POST', headers: { Authorization: `Bearer ${runtime.engine.apiKey}` }, signal: stop, redirect: 'error',
        })
    } catch { return 'unavailable' }
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 404) return 'missing'
    if (response.status === 503) return 'unavailable'
    return response.ok ? 'cancelled' : 'unavailable'
}

const stopRequests = new Map<string, Promise<Response>>()

export async function stopDesktopCoworkerCall(runtime: DesktopRuntime, sessionId: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<Response> {
    const parsed = desktopCoworkerCallStopSchema.safeParse(body)
    if (!parsed.success) throw new DesktopHttpError(400, 'Stop one coworker call by its current revision.')
    const input = parsed.data
    const db = await openDesktopDatabase(runtime.dataRoot)
    await initializeDesktopCoworkerCalls(db)
    const session = await findDesktopSession(db, sessionId)
    if (!session) throw new DesktopHttpError(404, 'Conversation not found.')
    const ownerSessionId = session.id
    await reserveDesktopCoworkerCallStop(db, { ...input, parentSessionId: ownerSessionId })
    const key = JSON.stringify([runtime.dataRoot, input.requestId])
    const pending = stopRequests.get(key)
    if (pending) return (await pending).clone()
    const work = finishStop()
    stopRequests.set(key, work)
    try { return (await work).clone() } finally { if (stopRequests.get(key) === work) stopRequests.delete(key) }

    async function finishStop(): Promise<Response> {
        const prior = await readDesktopCoworkerCallStop(db, input.requestId)
        if (prior) {
            if (prior.callId !== input.callId || prior.expectedRevision !== input.expectedRevision) throw new DesktopHttpError(409, 'That stop belongs to a different coworker call.')
            return Response.json(prior.body, { status: prior.httpStatus, headers: NO_STORE })
        }
        const finish = async (status: number, payload: unknown) => {
            await saveDesktopCoworkerCallStop(db, { requestId: input.requestId, callId: input.callId, expectedRevision: input.expectedRevision, httpStatus: status, body: payload })
            const saved = await readDesktopCoworkerCallStop(db, input.requestId)
            return Response.json(saved?.body ?? payload, { status: saved?.httpStatus ?? status, headers: NO_STORE })
        }
        const owned = async (callId: string) => {
            const row = await getDesktopCoworkerCall(db, callId)
            if (!row || row.parentSessionId !== ownerSessionId) throw new DesktopHttpError(404, 'Coworker call not found.')
            return row
        }
        const current = await owned(input.callId)
        const seen = await currentSnapshot(runtime, current)
        if (current.phase === 'terminal' && current.status === 'waiting-human') return finish(200, { call: seen })
        if (current.stopRequestId === input.requestId && !DESKTOP_COWORKER_CALL_ACTIVE.includes(current.status)) return finish(200, { call: seen })
        if (String(current.revision) !== input.expectedRevision) return finish(409, { error: 'This coworker call changed. Refresh it and try Stop again.', call: seen })
        if (!DESKTOP_COWORKER_CALL_ACTIVE.includes(current.status)) return finish(200, { call: seen })
        const claimed = current.stopRequestId === input.requestId ? current : await patchDesktopCoworkerCall(db, current.callId, { revision: current.revision, statuses: DESKTOP_COWORKER_CALL_ACTIVE, stopUnclaimed: true }, { stopRequestId: input.requestId }, new Date().toISOString())
        if (!claimed) {
            const latest = await owned(current.callId)
            if (!DESKTOP_COWORKER_CALL_ACTIVE.includes(latest.status)) return finish(200, { call: snapshot(latest) })
            return Response.json({ error: 'This coworker call is already stopping. Retry the same request.', call: snapshot(latest) }, { status: 503, headers: NO_STORE })
        }
        const unavailable = async () => {
            await patchDesktopCoworkerCall(db, claimed.callId, { stopRequestId: input.requestId }, { stopRequestId: null }, new Date().toISOString())
            const fresh = await owned(claimed.callId)
            if (!DESKTOP_COWORKER_CALL_ACTIVE.includes(fresh.status)) return finish(200, { call: snapshot(fresh) })
            return Response.json({ error: 'This coworker call has not finished stopping. Try Stop again.', call: snapshot(fresh) }, { status: 503, headers: NO_STORE })
        }
        const targetRunId = claimed.engineChildRunId
        if (!targetRunId && claimed.engineTargetSessionId) {
            return Response.json({ error: 'The exact coworker run is still being recorded. Retry the same Stop request.', call: snapshot(claimed) }, { status: 503, headers: NO_STORE })
        }
        let outcome: 'cancelled' | 'interrupted' = 'cancelled'
        if (targetRunId) {
            const cancelled = await cancelChild(runtime, claimed.engineTargetAgentId, targetRunId, fetchImpl)
            if (cancelled === 'unavailable') return unavailable()
            if (cancelled === 'missing') outcome = 'interrupted'
        }
        const terminalPatch = (kind: 'cancelled' | 'interrupted') => ({
            status: kind, phase: 'terminal' as const, error: kind === 'interrupted' ? DESKTOP_COWORKER_CALL_INTERRUPTED_REASON : 'stopped by the user',
        })
        const done = await patchDesktopCoworkerCall(db, claimed.callId, { statuses: DESKTOP_COWORKER_CALL_ACTIVE, engineChildRunId: claimed.engineChildRunId }, {
            ...terminalPatch(outcome), ...(targetRunId && !claimed.engineChildRunId ? { engineChildRunId: targetRunId } : {}),
        }, new Date().toISOString())
        if (done) return finish(200, { call: snapshot(done) })
        const latest = await owned(claimed.callId)
        if (!DESKTOP_COWORKER_CALL_ACTIVE.includes(latest.status)) return finish(200, { call: snapshot(latest) })
        if (latest.stopRequestId === input.requestId && latest.engineChildRunId) {
            const cancelled = await cancelChild(runtime, latest.engineTargetAgentId, latest.engineChildRunId, fetchImpl)
            if (cancelled === 'unavailable') return unavailable()
            const recorded = await patchDesktopCoworkerCall(db, latest.callId, { statuses: DESKTOP_COWORKER_CALL_ACTIVE, engineChildRunId: latest.engineChildRunId }, terminalPatch(cancelled === 'missing' ? 'interrupted' : 'cancelled'), new Date().toISOString())
            const finalRow = recorded ?? await owned(latest.callId)
            if (!DESKTOP_COWORKER_CALL_ACTIVE.includes(finalRow.status)) return finish(200, { call: snapshot(finalRow) })
        }
        return finish(409, { error: 'This coworker call changed. Refresh it and try Stop again.', call: snapshot(latest) })
    }
}

export async function handleDesktopCoworkerCallBridge(runtime: DesktopRuntime, body: unknown, fetchImpl: typeof fetch = fetch): Promise<Response | null> {
    if (!body || typeof body !== 'object' || (body as { event?: string }).event !== 'desktop.coworker-call') return null
    const message = body as { op?: string; epoch?: string; launchNonce?: string; payload?: Record<string, unknown> }
    if (message.launchNonce !== runtime.launchNonce) return Response.json({ ok: false, error: 'The coworker call runtime has changed.' }, { status: 409 })
    const db = await openDesktopDatabase(runtime.dataRoot)
    await initializeDesktopCoworkerCalls(db)
    const payload = message.payload ?? {}
    try {
        if (message.op !== 'adopt-epoch') {
            const current = (await db.execute('SELECT epoch FROM desktop_coworker_call_epoch WHERE id=1')).rows[0]
            if (!message.epoch || current?.epoch !== message.epoch) throw new DesktopHttpError(409, 'The coworker call runtime has changed.')
        }
        switch (message.op) {
            case 'adopt-epoch': {
                if (typeof payload.epoch !== 'string' || payload.epoch !== message.epoch || typeof payload.now !== 'string') throw new DesktopHttpError(400, 'Coworker call epoch is invalid.')
                await adoptDesktopCoworkerCallEpoch(db, payload.epoch, payload.now, runtime.launchNonce)
                return Response.json({ ok: true, result: true })
            }
            case 'authorize': {
                const input = payload as { engineAgentId?: string; engineSessionId?: string; engineRunId?: string }
                if (!input.engineAgentId || !input.engineSessionId || !input.engineRunId) throw new DesktopHttpError(400, 'Coworker call authority is invalid.')
                return Response.json({ ok: true, result: await authorizeDesktopCoworkerCall(runtime, db, { engineAgentId: input.engineAgentId, engineSessionId: input.engineSessionId, engineRunId: input.engineRunId }, fetchImpl) })
            }
            case 'prepare-target': {
                const input = z.strictObject({
                    caller: z.strictObject({ engineAgentId: serverId, engineSessionId: serverId, engineRunId: serverId }),
                    target: z.strictObject({ publicAgentId: serverId, engineAgentId: serverId }),
                }).parse(payload)
                const check = async () => {
                    const authorization = await authorizeDesktopCoworkerCall(runtime, db, input.caller, fetchImpl)
                    if (!authorization.ok) throw new DesktopHttpError(409, authorization.reason)
                    const allowed = authorization.caller.targets.some(target => target.publicAgentId === input.target.publicAgentId && target.engineAgentId === input.target.engineAgentId && target.enabled && target.callable)
                    if (!allowed) throw new DesktopHttpError(409, 'This coworker is not available for this call.')
                    const target = await findDesktopAgent(db, input.target.publicAgentId)
                    if (!target || target.engineAgentId !== input.target.engineAgentId || !target.enabled) throw new DesktopHttpError(409, 'This coworker is not available for this call.')
                    await assertCoworkerNotDeleting(db, target.id)
                    await assertDesktopSetupChatAllowed(runtime, target.id)
                    return target
                }
                const target = await check()
                const selected = await resolveDesktopChatModel(runtime, target, null)
                await check()
                return Response.json({ ok: true, result: { publicAgentId: target.id, engineAgentId: target.engineAgentId, connectionId: selected.connectionId, model: selected.model } })
            }
            case 'adopt-session': {
                const input = z.strictObject({ publicAgentId: serverId, engineSessionId: serverId, title: z.string().min(1).max(200) }).parse(payload)
                const rows = await db.execute({ sql: 'SELECT call_id FROM desktop_coworker_calls WHERE target_agent_id=? AND engine_target_session_id=? AND launch_epoch=?', args: [input.publicAgentId, input.engineSessionId, message.epoch!] })
                if (rows.rows.length !== 1) throw new DesktopHttpError(409, 'The coworker call does not own this chat.')
                const row = await getDesktopCoworkerCall(db, String(rows.rows[0].call_id))
                if (!row) throw new DesktopHttpError(409, 'The coworker call no longer exists.')
                const actual = await getSession(engineOf(runtime), row.engineTargetAgentId, input.engineSessionId, { signal: AbortSignal.timeout(5_000) })
                if (!actual || actual.id !== input.engineSessionId || actual.agentId !== row.engineTargetAgentId || actual.source !== 'agent' || actual.originAgentId !== row.engineParentAgentId || actual.originSessionId !== row.engineParentSessionId) throw new DesktopHttpError(409, 'The coworker call does not own this chat.')
                const saved = await withRosterWrite(async () => {
                    const currentEpoch = (await db.execute('SELECT epoch FROM desktop_coworker_call_epoch WHERE id=1')).rows[0]
                    if (currentEpoch?.epoch !== message.epoch) throw new DesktopHttpError(409, 'The coworker call runtime has changed.')
                    const current = await getDesktopCoworkerCall(db, row.callId)
                    if (!current || current.launchEpoch !== message.epoch || current.targetAgentId !== input.publicAgentId || current.engineTargetAgentId !== actual.agentId || current.engineTargetSessionId !== actual.id || current.engineParentAgentId !== actual.originAgentId || current.engineParentSessionId !== actual.originSessionId) throw new DesktopHttpError(409, 'The coworker call does not own this chat.')
                    await assertCoworkerNotDeleting(db, input.publicAgentId)
                    const owner = await findDesktopAgent(db, input.publicAgentId)
                    if (owner?.engineAgentId !== row.engineTargetAgentId) throw new DesktopHttpError(409, 'Coworker identity changed.')
                    return createDesktopSession(db, { agentId: owner.id, engineSessionId: actual.id, title: actual.title })
                })
                return Response.json({ ok: true, result: { publicSessionId: saved.id } })
            }
            case 'get-by-source':
                return Response.json({ ok: true, result: typeof payload.sourceKey === 'string' ? await getDesktopCoworkerCallBySource(db, payload.sourceKey) : null })
            case 'get':
                return Response.json({ ok: true, result: typeof payload.callId === 'string' ? await getDesktopCoworkerCall(db, payload.callId) : null })
            case 'list':
                return Response.json({ ok: true, result: typeof payload.parentSessionId === 'string' ? await listDesktopCoworkerCallRows(db, payload.parentSessionId) : [] })
            case 'inbound':
                return Response.json({ ok: true, result: typeof payload.engineRunId === 'string' ? await inboundDesktopCoworkerCall(db, payload.engineRunId) : null })
            case 'insert':
                return Response.json({ ok: true, result: await insertDesktopCoworkerCall(db, coworkerCallRowSchema.parse(payload.row)) })
            case 'claim': {
                const input = payload as { callId?: string; epoch?: string; now?: string }
                if (!input.callId || !input.epoch || !input.now) throw new DesktopHttpError(400, 'Coworker call claim is invalid.')
                return Response.json({ ok: true, result: await claimDesktopCoworkerCall(db, input.callId, input.epoch, input.now) })
            }
            case 'patch': {
                const input = payload as { callId?: string; expect?: unknown; patch?: unknown; now?: string }
                if (!input.callId || input.expect == null || input.patch == null || !input.now) throw new DesktopHttpError(400, 'Coworker call update is invalid.')
                const expect: CoworkerCallExpect = bridgeExpectSchema.parse(input.expect)
                const patch: CoworkerCallPatch = bridgePatchSchema.parse(input.patch)
                return Response.json({ ok: true, result: await patchDesktopCoworkerCall(db, input.callId, expect, patch, input.now, message.epoch) })
            }
            default:
                throw new DesktopHttpError(400, 'Coworker call operation is invalid.')
        }
    } catch (error) {
        if (error instanceof DesktopHttpError) return Response.json({ ok: false, error: error.message }, { status: error.status })
        if (error instanceof ZodError) return Response.json({ ok: false, error: 'Coworker call payload is invalid.' }, { status: 400 })
        return Response.json({ ok: false, error: 'Coworker call store failed' }, { status: 500 })
    }
}
