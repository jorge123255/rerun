import 'server-only'
import type { Client } from '@libsql/client'
import { FOREMAN_AGENT_ID, desktopRerunGrantsOf, desktopWorkRegisterCallSchema, type DesktopWorkRegisterCall } from '@rerun/contracts'
import { getAgent, getRun } from '@/lib/engine/client'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { ownedForemanDispatch } from '../foreman/chat-store'
import { readDesktopJson } from '../request-json'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { listDesktopAgents } from '../store'
import { DesktopWorkRegisterError, desktopWorkModelItem, listDesktopWorkItems, noteDesktopWorkItem, upsertDesktopWorkItem, type DesktopWorkActor, type DesktopWorkRoster } from './store'

/** What the app must confirm about a caller before it may touch the register. Production reads the engine. */
export type DesktopWorkCallerPorts = {
    /** The engine's current config of this agent, or null when it cannot be read. */
    config(engineAgentId: string, signal: AbortSignal): Promise<{ enabled: boolean; ephemeral?: boolean; kind?: string; tools: Parameters<typeof desktopRerunGrantsOf>[0] } | null>
    /** True only while this exact run of this agent is running in this session. */
    running(engineAgentId: string, sessionId: string, runId: string, signal: AbortSignal): Promise<boolean>
    /** The Chief of Staff's run must be a turn the app itself dispatched into one of its conversations. */
    foremanTurn(sessionId: string, runId: string): Promise<boolean>
}

export const DESKTOP_WORK_REGISTER_OFF = 'The work register is turned off for this coworker.'

/** The caller, checked from its run and its live permission. Refuses everything else. */
export async function desktopWorkActor(db: Client, call: DesktopWorkRegisterCall, ports: DesktopWorkCallerPorts, signal: AbortSignal): Promise<DesktopWorkActor> {
    const { agentId, sessionId, runId } = call.caller
    const config = await ports.config(agentId, signal).catch(() => null)
    if (!config?.enabled || config.ephemeral || !desktopRerunGrantsOf(config.tools).workRegister) throw new DesktopWorkRegisterError(403, DESKTOP_WORK_REGISTER_OFF)
    if (agentId === FOREMAN_AGENT_ID) {
        if (config.kind !== 'foreman' || !await ports.foremanTurn(sessionId, runId).catch(() => false)) throw new DesktopWorkRegisterError(409, 'This Chief of Staff run is no longer active.')
    } else if (config.kind === 'foreman') throw new DesktopWorkRegisterError(403, DESKTOP_WORK_REGISTER_OFF)
    if (!await ports.running(agentId, sessionId, runId, signal).catch(() => false)) throw new DesktopWorkRegisterError(409, 'This run is no longer active.')
    if (agentId === FOREMAN_AGENT_ID) return { kind: 'chief' }
    const owner = (await db.execute({
        sql: `SELECT a.id, a.name FROM desktop_agents a LEFT JOIN desktop_deletions d ON d.agent_id=a.id
              WHERE a.workspace_id=1 AND a.engine_agent_id=? AND a.enabled=1 AND d.agent_id IS NULL`, args: [agentId],
    })).rows
    if (owner.length !== 1) throw new DesktopWorkRegisterError(403, DESKTOP_WORK_REGISTER_OFF)
    return { kind: 'coworker', agentId: String(owner[0]!.id), name: String(owner[0]!.name) }
}

export async function desktopWorkRoster(db: Client): Promise<DesktopWorkRoster> {
    return (await listDesktopAgents(db)).filter(agent => agent.workspaceId === 1).map(agent => ({ id: agent.id, name: agent.name }))
}

/** One tool call: the caller is checked, then the register answers it. */
export async function answerDesktopWorkRegisterCall(db: Client, workspaceId: string, call: DesktopWorkRegisterCall, ports: DesktopWorkCallerPorts, signal: AbortSignal) {
    const actor = await desktopWorkActor(db, call, ports, signal)
    const roster = await desktopWorkRoster(db)
    if (call.op === 'list') {
        const result = await listDesktopWorkItems(db, workspaceId, roster, call.input)
        return { counts: result.counts, items: result.items.map(desktopWorkModelItem), ...(result.more && { more: result.more }) }
    }
    const result = call.op === 'upsert'
        ? await upsertDesktopWorkItem(db, workspaceId, actor, roster, call.input)
        : await noteDesktopWorkItem(db, workspaceId, actor, roster, call.input)
    return {
        item: desktopWorkModelItem(result.item), created: result.created,
        ...(result.duplicate && { duplicate: true, note: 'An open item already covers this objective for this project and owner. Nothing new was created; update this one instead.' }),
    }
}

function productionPorts(runtime: DesktopRuntime, db: Client): DesktopWorkCallerPorts {
    const engine = engineOf(runtime)
    return {
        async config(engineAgentId, signal) {
            const agent = await getAgent(engine, engineAgentId, { signal })
            return agent.id === engineAgentId ? agent.config as never : null
        },
        async running(engineAgentId, sessionId, runId, signal) {
            const run = await getRun(engine, engineAgentId, runId, { signal })
            return run.id === runId && run.agentId === engineAgentId && run.sessionId === sessionId && run.status === 'running'
        },
        foremanTurn: async (sessionId, runId) => { await ownedForemanDispatch(runtime, db, sessionId, runId); return true },
    }
}

/** POST /api/desktop/engine/work-register: the engine's tools, authenticated as the engine. */
export async function handleDesktopWorkRegisterEngineCall(request: Request): Promise<Response> {
    const headers = { 'cache-control': 'no-store' }
    try {
        const runtime = await authenticateDesktopEngineRequest(request)
        const parsed = desktopWorkRegisterCallSchema.safeParse(await readDesktopJson(request, 32_000))
        if (!parsed.success) return Response.json({ error: `The register could not read this call: ${parsed.error.issues[0]?.message ?? 'invalid input'}.` }, { status: 400, headers })
        const db = await openDesktopDatabase(runtime.dataRoot)
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
        return Response.json(await answerDesktopWorkRegisterCall(db, String(runtime.workspaceId), parsed.data, productionPorts(runtime, db), signal), { headers })
    } catch (error) {
        if (error instanceof DesktopWorkRegisterError || error instanceof DesktopHttpError) return Response.json({ error: error.message }, { status: error.status, headers })
        return Response.json({ error: 'The work register could not answer.' }, { status: 500, headers })
    }
}
