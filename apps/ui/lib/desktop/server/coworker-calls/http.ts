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
import { createDesktopSession, findDesktopSession } from '../store'
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

export async function readDesktopCoworkerCalls(runtime: DesktopRuntime, sessionId: string) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    await initializeDesktopCoworkerCalls(db)
    const session = await findDesktopSession(db, sessionId)
    if (!session || session.agentId == null) throw new DesktopHttpError(404, 'Conversation not found.')
    const calls = (await listDesktopCoworkerCallRows(db, session.id)).map(snapshot)
    return desktopCoworkerCallListSchema.parse({ calls })
}

const NO_STORE = { 'cache-control': 'no-store' }

async function readBounded(response: Response, limit: number): Promise<unknown> {
    if (!response.body) return null
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            const item = await reader.read()
            if (item.done) break
            size += item.value.byteLength
            if (size > limit) throw new Error('Coworker call response is too large')
            chunks.push(item.value)
        }
    } finally { await reader.cancel().catch(() => undefined) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

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

// A child session belongs to this call. Its single running run is the child when the run id was not saved yet.
async function runningChild(runtime: DesktopRuntime, engineAgentId: string, engineSessionId: string, fetchImpl: typeof fetch): Promise<string | 'none' | 'ambiguous' | 'unavailable'> {
    const stop = AbortSignal.timeout(10_000)
    let response: Response
    try {
        response = await fetchImpl(`${runtime.engine.origin}/agents/${encodeURIComponent(engineAgentId)}/runs?session=${encodeURIComponent(engineSessionId)}`, {
            headers: { Authorization: `Bearer ${runtime.engine.apiKey}` }, signal: stop, redirect: 'error', cache: 'no-store',
        })
    } catch { return 'unavailable' }
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return 'unavailable'
    }
    let body: unknown
    try { body = await readBounded(response, 256_000) } catch { return 'unavailable' }
    const runs = body && typeof body === 'object' && Array.isArray((body as { runs?: unknown }).runs) ? (body as { runs: unknown[] }).runs : null
    if (!runs) return 'unavailable'
    const matches = runs.filter(run => {
        if (!run || typeof run !== 'object') return false
        const row = run as { id?: unknown; agentId?: unknown; sessionId?: unknown; status?: unknown }
        return typeof row.id === 'string' && row.agentId === engineAgentId && row.sessionId === engineSessionId && row.status === 'running'
    })
    if (matches.length > 1) return 'ambiguous'
    if (matches.length === 0) return 'none'
    return String((matches[0] as { id: string }).id)
}

export async function stopDesktopCoworkerCall(runtime: DesktopRuntime, sessionId: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<Response> {
    const parsed = desktopCoworkerCallStopSchema.safeParse(body)
    if (!parsed.success) throw new DesktopHttpError(400, 'Stop one coworker call by its current revision.')
    const db = await openDesktopDatabase(runtime.dataRoot)
    await initializeDesktopCoworkerCalls(db)
    const session = await findDesktopSession(db, sessionId)
    if (!session) throw new DesktopHttpError(404, 'Conversation not found.')
    const prior = await readDesktopCoworkerCallStop(db, parsed.data.requestId)
    if (prior) {
        if (prior.callId !== parsed.data.callId || prior.expectedRevision !== parsed.data.expectedRevision) throw new DesktopHttpError(409, 'That stop belongs to a different coworker call.')
        return Response.json(prior.body, { status: prior.httpStatus, headers: NO_STORE })
    }
    const finish = async (status: number, payload: unknown) => {
        await saveDesktopCoworkerCallStop(db, { requestId: parsed.data.requestId, callId: parsed.data.callId, expectedRevision: parsed.data.expectedRevision, httpStatus: status, body: payload })
        const saved = await readDesktopCoworkerCallStop(db, parsed.data.requestId)
        return Response.json(saved?.body ?? payload, { status: saved?.httpStatus ?? status, headers: NO_STORE })
    }
    const owned = async (callId: string) => {
        const row = await getDesktopCoworkerCall(db, callId)
        if (!row || row.parentSessionId !== session.id) throw new DesktopHttpError(404, 'Coworker call not found.')
        return row
    }
    const current = await owned(parsed.data.callId)
    const seen = snapshot(current)
    if (String(current.revision) !== parsed.data.expectedRevision) return finish(409, { error: 'This coworker call changed. Refresh it and try Stop again.', call: seen })
    if (!DESKTOP_COWORKER_CALL_ACTIVE.includes(current.status)) return finish(200, { call: seen })
    const claimed = await patchDesktopCoworkerCall(db, current.callId, { revision: current.revision, statuses: DESKTOP_COWORKER_CALL_ACTIVE, stopUnclaimed: true }, { stopRequestId: parsed.data.requestId }, new Date().toISOString())
    if (!claimed) {
        const latest = await owned(current.callId)
        if (!DESKTOP_COWORKER_CALL_ACTIVE.includes(latest.status)) return finish(200, { call: snapshot(latest) })
        return finish(409, { error: 'This coworker call changed. Refresh it and try Stop again.', call: snapshot(latest) })
    }
    const unavailable = async () => {
        await patchDesktopCoworkerCall(db, claimed.callId, { stopUnclaimed: false }, { stopRequestId: null }, new Date().toISOString())
        const fresh = await owned(claimed.callId)
        if (!DESKTOP_COWORKER_CALL_ACTIVE.includes(fresh.status)) return finish(200, { call: snapshot(fresh) })
        return Response.json({ error: 'This coworker call has not finished stopping. Try Stop again.', call: snapshot(fresh) }, { status: 503, headers: NO_STORE })
    }
    let targetRunId = claimed.engineChildRunId
    if (!targetRunId && claimed.engineTargetSessionId) {
        const found = await runningChild(runtime, claimed.engineTargetAgentId, claimed.engineTargetSessionId, fetchImpl)
        if (found === 'unavailable' || found === 'ambiguous') return unavailable()
        if (found !== 'none') targetRunId = found
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
    if (latest.stopRequestId === parsed.data.requestId && latest.engineChildRunId) {
        const cancelled = await cancelChild(runtime, latest.engineTargetAgentId, latest.engineChildRunId, fetchImpl)
        if (cancelled === 'unavailable') return unavailable()
        const recorded = await patchDesktopCoworkerCall(db, latest.callId, { statuses: DESKTOP_COWORKER_CALL_ACTIVE, engineChildRunId: latest.engineChildRunId }, terminalPatch(cancelled === 'missing' ? 'interrupted' : 'cancelled'), new Date().toISOString())
        const finalRow = recorded ?? await owned(latest.callId)
        if (!DESKTOP_COWORKER_CALL_ACTIVE.includes(finalRow.status)) return finish(200, { call: snapshot(finalRow) })
    }
    return finish(409, { error: 'This coworker call changed. Refresh it and try Stop again.', call: snapshot(latest) })
}

export async function handleDesktopCoworkerCallBridge(runtime: DesktopRuntime, body: unknown, fetchImpl: typeof fetch = fetch): Promise<Response | null> {
    if (!body || typeof body !== 'object' || (body as { event?: string }).event !== 'desktop.coworker-call') return null
    const message = body as { op?: string; epoch?: string; payload?: Record<string, unknown> }
    const db = await openDesktopDatabase(runtime.dataRoot)
    await initializeDesktopCoworkerCalls(db)
    const payload = message.payload ?? {}
    try {
        switch (message.op) {
            case 'adopt-epoch': {
                if (typeof payload.epoch !== 'string' || typeof payload.now !== 'string') throw new DesktopHttpError(400, 'Coworker call epoch is invalid.')
                await adoptDesktopCoworkerCallEpoch(db, payload.epoch, payload.now)
                return Response.json({ ok: true, result: true })
            }
            case 'authorize': {
                const input = payload as { engineAgentId?: string; engineSessionId?: string; engineRunId?: string }
                if (!input.engineAgentId || !input.engineSessionId || !input.engineRunId) throw new DesktopHttpError(400, 'Coworker call authority is invalid.')
                return Response.json({ ok: true, result: await authorizeDesktopCoworkerCall(runtime, db, { engineAgentId: input.engineAgentId, engineSessionId: input.engineSessionId, engineRunId: input.engineRunId }, fetchImpl) })
            }
            case 'adopt-session': {
                const input = payload as { publicAgentId?: string; engineSessionId?: string; title?: string }
                if (!input.publicAgentId || !input.engineSessionId || !input.title) throw new DesktopHttpError(400, 'Coworker call chat is invalid.')
                const saved = await createDesktopSession(db, { agentId: input.publicAgentId, engineSessionId: input.engineSessionId, title: input.title })
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
                return Response.json({ ok: true, result: await patchDesktopCoworkerCall(db, input.callId, expect, patch, input.now) })
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
