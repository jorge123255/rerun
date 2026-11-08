import 'server-only'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { FOREMAN_AGENT_ID } from '@rerun/contracts'
import type { Client } from '@libsql/client'
import { request } from '@/lib/engine/client'
import { authenticateDesktopEngineRequest, authenticateDesktopRequest, DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { readDesktopRuntime, type DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { boundedText } from '../mcp/remote'
import { foremanTurn, ownedForemanChat } from '../foreman/chat-store'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'
import { delegationReceipts, delegationStore } from './store'
import { delegationApi } from './api'
import { delegationIpcSchema, engineSourceSchema, sourceSchema, type Allocation, type EngineSource } from '../../../../../engine/src/desktop/delegation/protocol'
import type { Record as DelegationRecord, StopReceipt, Source } from '../../../../../engine/src/desktop/delegation/types'
import type { DelegationRuntime } from '../../../../../engine/src/desktop/delegation/runtime'

const id = z.string().min(1).max(200)
const sourceKey = (source: Source) => JSON.stringify([source.parentAgentId, source.parentSessionId, source.parentRunId, source.toolCallId])
const changed = () => new DesktopHttpError(409, 'Delegation ownership or permission changed.')
async function currentEpoch(runtime: DesktopRuntime) { if ((await readDesktopRuntime()).launchNonce !== runtime.launchNonce) throw changed() }

async function foremanDelegationChat(runtime: DesktopRuntime, db: Client, input: EngineSource) {
    assertDesktopWorkspaceAdmission(runtime)
    const turn = await foremanTurn(db, input.runId)
    if (!turn || !['pending', 'admitted'].includes(turn.status) || turn.body.binding.runId !== input.runId
        || turn.body.binding.workspaceId !== String(runtime.workspaceId) || turn.body.sessionId !== input.sessionId) throw changed()
    const owner = await ownedForemanChat(db, turn.body.binding)
    if (owner.sessionId !== input.sessionId) throw changed()
    return owner.chat.chatId
}

async function authorizeForemanDelegation(runtime: DesktopRuntime, db: Client, input: EngineSource, signal: AbortSignal) {
    const chatId = await foremanDelegationChat(runtime, db, input)
    const prefix = `/agents/${FOREMAN_AGENT_ID}`
    const [agent, run] = await Promise.all([
        request(engineOf(runtime), prefix, { signal }, value => z.object({
            id: z.literal(FOREMAN_AGENT_ID),
            config: z.object({ kind: z.literal('foreman'), enabled: z.literal(true), ephemeral: z.boolean().optional(),
                tools: z.object({ desktopToolGrants: z.object({ delegate: z.literal(true) }) }) }),
        }).parse(value)),
        request(engineOf(runtime), `${prefix}/runs/${encodeURIComponent(input.runId)}`, { signal }, value => z.object({
            id, agentId: z.literal(FOREMAN_AGENT_ID), sessionId: id, status: z.literal('running'),
        }).parse(value)),
    ])
    if (agent.config.ephemeral || run.id !== input.runId || run.sessionId !== input.sessionId
        || await foremanDelegationChat(runtime, db, input) !== chatId) throw changed()
    await currentEpoch(runtime)
    signal.throwIfAborted()
    assertDesktopWorkspaceAdmission(runtime)
    return { source: { parentAgentId: FOREMAN_AGENT_ID, parentSessionId: chatId, parentRunId: input.runId, toolCallId: input.toolCallId }, webFetch: false }
}

export async function authorizeDelegationSource(runtime: DesktopRuntime, db: Client, input: EngineSource, signal: AbortSignal) {
    await currentEpoch(runtime); signal.throwIfAborted()
    if (input.engineAgentId === FOREMAN_AGENT_ID) return authorizeForemanDelegation(runtime, db, input, signal)
    const local = (await db.execute({ sql: 'SELECT a.id,a.enabled,s.id AS session_id FROM desktop_agents a JOIN desktop_sessions s ON s.agent_id=a.id WHERE a.engine_agent_id=? AND s.engine_session_id=? AND a.workspace_id=1', args: [input.engineAgentId, input.sessionId] })).rows[0]
    if (!local || !Number(local.enabled)) throw changed()
    await assertCoworkerNotDeleting(db, String(local.id))
    const prefix = `/agents/${encodeURIComponent(input.engineAgentId)}`
    const [agent, session, run] = await Promise.all([
        request(engineOf(runtime), prefix, { signal }, value => z.object({ id, config: z.object({ enabled: z.boolean(), ephemeral: z.boolean().optional(), tools: z.object({ desktopToolGrants: z.record(z.string(), z.boolean()).optional() }).passthrough() }).passthrough() }).passthrough().parse(value)),
        request(engineOf(runtime), `${prefix}/sessions/${encodeURIComponent(input.sessionId)}`, { signal }, value => z.object({ id, agentId: id }).passthrough().parse(value)),
        request(engineOf(runtime), `${prefix}/runs/${encodeURIComponent(input.runId)}`, { signal }, value => z.object({ id, agentId: id, sessionId: id, status: z.literal('running') }).passthrough().parse(value)),
    ])
    if (agent.id !== input.engineAgentId || !agent.config.enabled || agent.config.ephemeral || !agent.config.tools.desktopToolGrants?.delegate || session.id !== input.sessionId || session.agentId !== input.engineAgentId || run.id !== input.runId || run.agentId !== input.engineAgentId || run.sessionId !== input.sessionId) throw changed()
    const again = (await db.execute({ sql: 'SELECT a.id FROM desktop_agents a JOIN desktop_sessions s ON s.agent_id=a.id WHERE a.id=? AND a.engine_agent_id=? AND a.enabled=1 AND s.id=? AND s.engine_session_id=?', args: [String(local.id), input.engineAgentId, String(local.session_id), input.sessionId] })).rows[0]
    if (!again) throw changed()
    await assertCoworkerNotDeleting(db, String(local.id)); await currentEpoch(runtime); signal.throwIfAborted()
    return { source: { parentAgentId: String(local.id), parentSessionId: String(local.session_id), parentRunId: input.runId, toolCallId: input.toolCallId }, webFetch: agent.config.tools.desktopToolGrants?.webFetch === true }
}

async function engineSource(runtime: DesktopRuntime, db: Client, source: Source): Promise<EngineSource> {
    if (source.parentAgentId === FOREMAN_AGENT_ID) {
        const chat = await ownedForemanChat(db, { workspaceId: String(runtime.workspaceId), chatId: source.parentSessionId })
        return { engineAgentId: FOREMAN_AGENT_ID, sessionId: chat.sessionId, runId: source.parentRunId, toolCallId: source.toolCallId }
    }
    const row = (await db.execute({ sql: 'SELECT a.engine_agent_id,s.engine_session_id FROM desktop_agents a JOIN desktop_sessions s ON s.agent_id=a.id WHERE a.id=? AND s.id=? AND a.enabled=1 AND a.workspace_id=1', args: [source.parentAgentId, source.parentSessionId] })).rows[0]
    if (!row) throw changed()
    return { engineAgentId: String(row.engine_agent_id), sessionId: String(row.engine_session_id), runId: source.parentRunId, toolCallId: source.toolCallId }
}
function recordOf(value: unknown): DelegationRecord {
    const record = value as DelegationRecord
    if (!record || record.version !== 1 || !/^[a-f0-9]{64}$/.test(record.digest) || !record.snapshot || !Array.isArray(record.snapshot.tasks) || record.snapshot.tasks.length < 1 || record.snapshot.tasks.length > 32 || !Array.isArray(record.resources) || !Array.isArray(record.outputs) || record.resources.length !== record.snapshot.tasks.length || record.outputs.length !== record.resources.length) throw changed()
    sourceSchema.parse({ parentAgentId: record.snapshot.parentAgentId, parentSessionId: record.snapshot.parentSessionId, parentRunId: record.snapshot.parentRunId, toolCallId: record.snapshot.toolCallId })
    z.string().uuid().parse(record.snapshot.delegationId); z.string().uuid().parse(record.snapshot.revision)
    for (const task of record.snapshot.tasks) {
        z.string().uuid().parse(task.taskId)
        if (task.stopRevision !== undefined) z.string().uuid().parse(task.stopRevision)
    }
    return record
}
async function resourceOf(db: Client, token: string): Promise<Allocation> {
    const row = (await db.execute({ sql: 'SELECT record FROM desktop_delegation_resources WHERE token=?', args: [token] })).rows[0]
    if (!row) throw changed()
    return JSON.parse(String(row.record)) as Allocation
}

/** Engine bearer only. The browser cannot create tasks, allocate workspaces or submit outputs. */
export async function handleDesktopDelegationBridge(incoming: Request): Promise<Response> {
    const headers = { 'Cache-Control': 'no-store' }
    try {
        const runtime = await authenticateDesktopEngineRequest(incoming), signal = AbortSignal.any([incoming.signal, AbortSignal.timeout(10000)])
        const body = delegationIpcSchema.parse(JSON.parse(await boundedText(new Response(incoming.body), signal, 4 * 1024 * 1024)))
        if (body.launchNonce !== runtime.launchNonce) throw changed()
        await currentEpoch(runtime); signal.throwIfAborted()
        const db = await openDesktopDatabase(runtime.dataRoot), store = delegationStore(db), receipts = delegationReceipts(db)
        const data = body.data as { [key: string]: unknown }; let result: unknown
        await currentEpoch(runtime); signal.throwIfAborted()
        switch (body.operation) {
        case 'authority': result = await authorizeDelegationSource(runtime, db, engineSourceSchema.parse(data), signal); break
        case 'record-reserve': {
            const record = recordOf(data), source = record.snapshot
            await authorizeDelegationSource(runtime, db, await engineSource(runtime, db, source), signal)
            if (record.resources.some(Boolean) || record.outputs.some(Boolean) || record.snapshot.tasks.some(task => task.status !== 'queued')) throw changed()
            result = await store.reserve(record); break
        }
        case 'record-save': {
            const record = recordOf(data.record), prior = await store.read(record.snapshot.delegationId)
            if (!prior || sourceKey(prior.snapshot) !== sourceKey(record.snapshot) || prior.digest !== record.digest || JSON.stringify(prior.snapshot.tasks.map(task => [task.taskId, task.stopRevision ?? null])) !== JSON.stringify(record.snapshot.tasks.map(task => [task.taskId, task.stopRevision ?? null]))) throw changed()
            await currentEpoch(runtime); signal.throwIfAborted()
            await store.save(record, id.parse(data.expectedRevision)); result = null; break
        }
        case 'record-read': result = await store.read(id.parse(data.id)); break
        case 'record-list': result = await store.list(data.sessionId === undefined ? undefined : id.parse(data.sessionId)); break
        case 'stop-read': result = await receipts.read(id.parse(data.requestId)); break
        case 'stop-reserve': result = await receipts.reserve(id.parse(data.requestId), data.receipt as StopReceipt); break
        case 'stop-settle': await receipts.put(id.parse(data.requestId), data.receipt as StopReceipt); result = null; break
        case 'allocate': {
            const source = sourceSchema.parse(data.source), taskId = z.string().uuid().parse(data.taskId)
            await authorizeDelegationSource(runtime, db, await engineSource(runtime, db, source), signal)
            const record = (await store.list(source.parentSessionId)).find(row => sourceKey(row.snapshot) === sourceKey(source))
            if (!record?.snapshot.tasks.some(task => task.taskId === taskId && task.status === 'queued')) throw changed()
            const old = (await db.execute({ sql: 'SELECT record FROM desktop_delegation_resources WHERE source=? AND task_id=?', args: [sourceKey(source), taskId] })).rows[0]
            if (old) { result = JSON.parse(String(old.record)); break }
            // Reserve a known private ID before mkdir, session creation, provider work or callbacks.
            const allocation: Allocation = { token: randomUUID(), identity: randomUUID(), revision: randomUUID(), epoch: runtime.launchNonce, source, taskId, childAgentId: `delegate-${randomUUID()}`, rootIdentity: null, sessionId: null, runId: null, phase: 'reserved', manifest: null }
            await currentEpoch(runtime); signal.throwIfAborted()
            await db.execute({ sql: 'INSERT INTO desktop_delegation_resources(token,source,task_id,revision,record) VALUES(?,?,?,?,?) ON CONFLICT(source,task_id) DO NOTHING', args: [allocation.token, sourceKey(source), taskId, allocation.revision, JSON.stringify(allocation)] })
            const saved = (await db.execute({ sql: 'SELECT record FROM desktop_delegation_resources WHERE source=? AND task_id=?', args: [sourceKey(source), taskId] })).rows[0]
            result = JSON.parse(String(saved!.record)); break
        }
        case 'resource-read': result = await resourceOf(db, id.parse(data.token)); break
        case 'recover': {
            const source = sourceSchema.parse(data.source), taskId = id.parse(data.taskId)
            const row = (await db.execute({ sql: 'SELECT record FROM desktop_delegation_resources WHERE source=? AND task_id=?', args: [sourceKey(source), taskId] })).rows[0]
            result = row ? JSON.parse(String(row.record)) : null; break
        }
        case 'resource-save': {
            const next = data.record as Allocation, prior = await resourceOf(db, id.parse(next?.token))
            if (prior.identity !== next.identity || prior.epoch !== next.epoch || prior.childAgentId !== next.childAgentId || sourceKey(prior.source) !== sourceKey(next.source) || prior.taskId !== next.taskId || (prior.rootIdentity && prior.rootIdentity !== next.rootIdentity) || (prior.sessionId && prior.sessionId !== next.sessionId) || (prior.runId && prior.runId !== next.runId)) throw changed()
            if (prior.cleanupStarted && !next.cleanupStarted) throw changed()
            const order = ['reserved','created','running','drained','retired']
            if (!order.includes(next.phase) || order.indexOf(next.phase) < order.indexOf(prior.phase) || prior.epoch !== runtime.launchNonce && !['drained','retired'].includes(next.phase)) throw changed()
            await currentEpoch(runtime)
            const saved = await db.execute({ sql: 'UPDATE desktop_delegation_resources SET revision=?,record=? WHERE token=? AND revision=?', args: [next.revision, JSON.stringify(next), next.token, id.parse(data.expectedRevision)] })
            if (saved.rowsAffected !== 1) throw changed()
            result = next; break
        }
        }
        await currentEpoch(runtime); signal.throwIfAborted()
        return Response.json({ result }, { headers })
    } catch (error) { return Response.json({ error: 'Delegation changed or is unavailable. Retry the same operation.' }, { status: error instanceof DesktopHttpError ? error.status : 409, headers }) }
}

export async function handleDesktopDelegationManagement(incoming: Request, sessionId: string) {
    const runtime = await authenticateDesktopRequest(incoming), db = await openDesktopDatabase(runtime.dataRoot), store = delegationStore(db)
    const authorize = async (request: Request, session: string) => {
        const now = await authenticateDesktopRequest(request); if (now.launchNonce !== runtime.launchNonce) throw changed()
        const row = (await db.execute({ sql: 'SELECT a.id,a.enabled FROM desktop_sessions s JOIN desktop_agents a ON a.id=s.agent_id WHERE s.id=? AND a.workspace_id=1', args: [session] })).rows[0]
        if (!row) throw changed()
        await assertCoworkerNotDeleting(db, String(row.id))
        return { parentAgentId: String(row.id), parentSessionId: session }
    }
    const proxy = {
        list: async (session: string) => (await store.list(session)).map(row => row.snapshot),
        stop: async (source: Pick<Source, 'parentAgentId' | 'parentSessionId'>, stop: unknown) => request(engineOf(runtime), '/desktop/delegation/stop', { method: 'POST', signal: incoming.signal, body: JSON.stringify({ launchNonce: runtime.launchNonce, source, request: stop }) }, value => (value as { delegation: unknown }).delegation),
    } as DelegationRuntime
    return delegationApi(proxy, authorize)(incoming, sessionId)
}
