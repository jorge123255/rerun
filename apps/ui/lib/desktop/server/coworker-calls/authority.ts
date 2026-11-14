import 'server-only'
import {
    desktopCoworkerCallTargetSchema,
    FOREMAN_AGENT_ID,
    FOREMAN_DISPLAY_NAME,
    type DesktopForemanChatRef,
    type DesktopCoworkerCallTarget,
} from '@rerun/contracts'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { DesktopHttpError } from '../auth'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { initializeDesktopCoworkerCalls } from './db'
import { readDesktopRuntime, type DesktopRuntime } from '../runtime'
import { ownedForemanDispatch } from '../foreman/chat-store'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'

const detailSchema = z.object({
    id: z.string(),
    config: z.object({
        enabled: z.boolean(), kind: z.string().optional(), ephemeral: z.boolean().optional(),
        tools: z.object({ desktopToolGrants: z.record(z.string(), z.boolean()).optional() }).passthrough(),
    }).passthrough(),
}).passthrough()
const sessionSchema = z.object({ id: z.string(), agentId: z.string() }).passthrough()
const runSchema = z.object({ id: z.string(), agentId: z.string(), sessionId: z.string(), status: z.string() }).passthrough()

type ServerTarget = { publicAgentId: string; engineAgentId: string; name: string; enabled: boolean; callable: boolean }

async function bounded(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('Coworker authority is unavailable')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            signal.throwIfAborted()
            const item = await reader.read()
            if (item.done) break
            size += item.value.byteLength
            if (size > 1_000_000) throw new Error('Coworker authority response is too large')
            chunks.push(item.value)
        }
    } finally { await reader.cancel().catch(() => undefined) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function replaceDesktopCoworkerCallAllows(db: Client, callerAgentId: string, targets: readonly string[], expected?: readonly string[]) {
    return replaceCallAllows(db, callerAgentId, targets, expected)
}

export function replaceDesktopForemanCallAllows(db: Client, chat: DesktopForemanChatRef, targets: readonly string[], expected: readonly string[]) {
    return replaceCallAllows(db, FOREMAN_AGENT_ID, targets, expected, chat)
}

async function replaceCallAllows(db: Client, callerAgentId: string, targetAgentIds: readonly string[], expected?: readonly string[], foreman?: DesktopForemanChatRef): Promise<void> {
    await initializeDesktopCoworkerCalls(db)
    const unique = [...new Set(targetAgentIds)]
    if (unique.length !== targetAgentIds.length) throw new DesktopHttpError(400, 'Each allowed coworker can be listed once.')
    if (unique.includes(callerAgentId)) throw new DesktopHttpError(400, 'A coworker cannot allow a call to itself.')
    const tx = await db.transaction('write')
    try {
        const caller = foreman
            ? await tx.execute({ sql: 'SELECT chat_id FROM desktop_foreman_chats WHERE chat_id=? AND workspace_id=?', args: [foreman.chatId, foreman.workspaceId] })
            : await tx.execute({ sql: 'SELECT id FROM desktop_agents WHERE id = ? AND workspace_id = 1', args: [callerAgentId] })
        if (!caller.rows.length) throw new DesktopHttpError(404, 'Coworker not found.')
        const saved = (await tx.execute({ sql: 'SELECT target_agent_id FROM desktop_coworker_call_allows WHERE caller_agent_id=? ORDER BY target_agent_id', args: [callerAgentId] })).rows.map(row => String(row.target_agent_id))
        const same = (ids: readonly string[]) => JSON.stringify([...ids].sort()) === JSON.stringify(saved)
        if (same(unique)) { await tx.commit(); return }
        if (expected && !same(expected)) throw new DesktopHttpError(409, 'Allowed coworkers changed. Reopen Tools before trying again.')
        for (const id of unique) {
            const found = await tx.execute({ sql: 'SELECT id FROM desktop_agents WHERE id = ? AND workspace_id = 1', args: [id] })
            if (!found.rows.length) throw new DesktopHttpError(400, 'An allowed coworker was not found.')
        }
        await tx.execute({ sql: 'DELETE FROM desktop_coworker_call_allows WHERE caller_agent_id = ?', args: [callerAgentId] })
        for (const id of unique) await tx.execute({ sql: 'INSERT INTO desktop_coworker_call_allows (caller_agent_id, target_agent_id) VALUES (?, ?)', args: [callerAgentId, id] })
        await tx.commit()
    } finally { tx.close() }
}

export async function listDesktopCoworkerCallTargets(db: Client, callerAgentId: string, grantOn: boolean): Promise<DesktopCoworkerCallTarget[]> {
    await initializeDesktopCoworkerCalls(db)
    const result = await db.execute({
        sql: `SELECT a.id, a.name, a.enabled, s.name AS box_name,
                EXISTS(SELECT 1 FROM desktop_coworker_call_allows g WHERE g.caller_agent_id = ? AND g.target_agent_id = a.id) AS allowed,
                EXISTS(SELECT 1 FROM desktop_deletions d WHERE d.agent_id = a.id) AS deleting
            FROM desktop_agents a
            LEFT JOIN desktop_space_placements p ON p.agent_id = a.id
            LEFT JOIN desktop_spaces s ON s.id = p.space_id
            WHERE a.workspace_id = 1 AND a.id != ?
            ORDER BY a.created_at, a.id`,
        args: [callerAgentId, callerAgentId],
    })
    return result.rows.map(row => desktopCoworkerCallTargetSchema.parse({
        agentId: String(row.id),
        name: String(row.name),
        handle: null,
        boxName: row.box_name == null ? null : String(row.box_name),
        enabled: Number(row.enabled) !== 0 && Number(row.deleting) === 0,
        callable: grantOn && Number(row.allowed) === 1 && Number(row.enabled) !== 0 && Number(row.deleting) === 0,
    }))
}

export async function authorizeDesktopCoworkerCall(runtime: DesktopRuntime, db: Client, input: { engineAgentId: string; engineSessionId: string; engineRunId: string }, fetchImpl: typeof fetch = fetch, signal = AbortSignal.timeout(5_000)): Promise<{ ok: true; caller: { publicAgentId: string; publicSessionId: string; name: string; targets: ServerTarget[] } } | { ok: false; reason: string }> {
    await initializeDesktopCoworkerCalls(db)
    const response = async (path: string) => {
        signal.throwIfAborted()
        const result = await fetchImpl(`${runtime.engine.origin}${path}`, { headers: { Authorization: `Bearer ${runtime.engine.apiKey}` }, signal, cache: 'no-store', redirect: 'error' })
        return bounded(result, signal)
    }
    if (input.engineAgentId === FOREMAN_AGENT_ID) {
        try {
            const owner = await ownedForemanDispatch(runtime, db, input.engineSessionId, input.engineRunId)
            const agent = detailSchema.parse(await response('/agents/foreman'))
            const run = runSchema.parse(await response(`/agents/foreman/runs/${encodeURIComponent(input.engineRunId)}`))
            if (agent.id !== FOREMAN_AGENT_ID || agent.config.kind !== 'foreman' || !agent.config.enabled || agent.config.ephemeral
                || agent.config.tools.desktopToolGrants?.callAgent !== true) return { ok: false, reason: 'Call coworkers is turned off for Foreman.' }
            if (run.id !== input.engineRunId || run.agentId !== FOREMAN_AGENT_ID || run.sessionId !== owner.sessionId || run.status !== 'running') throw new Error('Run changed')
            const targets = await targetRows(db, FOREMAN_AGENT_ID, true)
            const current = await readDesktopRuntime()
            if (current.launchNonce !== runtime.launchNonce || current.workspaceId !== runtime.workspaceId || current.dataRoot !== runtime.dataRoot
                || (await ownedForemanDispatch(runtime, db, input.engineSessionId, input.engineRunId)).chat.chatId !== owner.chat.chatId) throw new Error('Owner changed')
            signal.throwIfAborted()
            assertDesktopWorkspaceAdmission(runtime)
            return { ok: true, caller: { publicAgentId: FOREMAN_AGENT_ID, publicSessionId: owner.chat.chatId, name: FOREMAN_DISPLAY_NAME, targets } }
        } catch { return { ok: false, reason: 'This Foreman run can no longer call a coworker.' } }
    }
    const local = await db.execute({ sql: 'SELECT id, name, enabled, engine_agent_id FROM desktop_agents WHERE engine_agent_id = ? AND workspace_id = 1', args: [input.engineAgentId] })
    const owner = local.rows[0]
    if (!owner) return { ok: false, reason: 'This run can no longer call a coworker.' }
    const publicAgentId = String(owner.id)
    try { await assertCoworkerNotDeleting(db, publicAgentId) } catch { return { ok: false, reason: 'This run can no longer call a coworker.' } }
    if (Number(owner.enabled) === 0) return { ok: false, reason: 'This coworker is switched off and cannot be called.' }
    const session = await db.execute({ sql: 'SELECT id FROM desktop_sessions WHERE agent_id = ? AND engine_session_id = ?', args: [publicAgentId, input.engineSessionId] })
    if (!session.rows[0]) return { ok: false, reason: 'This run can no longer call a coworker.' }
    let agent: z.infer<typeof detailSchema>
    let currentSession: z.infer<typeof sessionSchema>
    let currentRun: z.infer<typeof runSchema>
    try {
        agent = detailSchema.parse(await response(`/agents/${encodeURIComponent(input.engineAgentId)}`))
        currentSession = sessionSchema.parse(await response(`/agents/${encodeURIComponent(input.engineAgentId)}/sessions/${encodeURIComponent(input.engineSessionId)}`))
        currentRun = runSchema.parse(await response(`/agents/${encodeURIComponent(input.engineAgentId)}/runs/${encodeURIComponent(input.engineRunId)}`))
    } catch {
        return { ok: false, reason: 'This run can no longer call a coworker.' }
    }
    const again = await db.execute({ sql: 'SELECT id, engine_agent_id, enabled FROM desktop_agents WHERE id = ? AND workspace_id = 1', args: [publicAgentId] })
    if (String(again.rows[0]?.engine_agent_id ?? '') !== input.engineAgentId || Number(again.rows[0]?.enabled ?? 0) === 0) return { ok: false, reason: 'This run can no longer call a coworker.' }
    // The hosted callAgent switch defaults on. Only the explicit desktop grant, which defaults off, allows a call.
    if (agent.id !== input.engineAgentId || !agent.config.enabled || agent.config.tools.desktopToolGrants?.callAgent !== true) return { ok: false, reason: 'Call coworkers is turned off for this coworker.' }
    if (currentSession.id !== input.engineSessionId || currentSession.agentId !== input.engineAgentId || currentRun.id !== input.engineRunId || currentRun.agentId !== input.engineAgentId || currentRun.sessionId !== input.engineSessionId || currentRun.status !== 'running') {
        return { ok: false, reason: 'This run can no longer call a coworker.' }
    }
    const targets = await targetRows(db, publicAgentId, true)
    return { ok: true, caller: { publicAgentId, publicSessionId: String(session.rows[0].id), name: String(owner.name), targets } }
}

async function targetRows(db: Client, callerAgentId: string, grantOn: boolean): Promise<ServerTarget[]> {
    const result = await db.execute({
        sql: `SELECT a.id, a.engine_agent_id, a.name, a.enabled, s.name AS box_name,
                EXISTS(SELECT 1 FROM desktop_coworker_call_allows g WHERE g.caller_agent_id = ? AND g.target_agent_id = a.id) AS allowed,
                EXISTS(SELECT 1 FROM desktop_deletions d WHERE d.agent_id = a.id) AS deleting
            FROM desktop_agents a
            LEFT JOIN desktop_space_placements p ON p.agent_id = a.id
            LEFT JOIN desktop_spaces s ON s.id = p.space_id
            WHERE a.workspace_id = 1 AND a.id != ?
            ORDER BY a.created_at, a.id`,
        args: [callerAgentId, callerAgentId],
    })
    return result.rows.map(row => {
        const enabled = Number(row.enabled) !== 0 && Number(row.deleting) === 0
        const callable = grantOn && Number(row.allowed) === 1 && enabled
        desktopCoworkerCallTargetSchema.parse({ agentId: String(row.id), name: String(row.name), handle: null, boxName: row.box_name == null ? null : String(row.box_name), enabled, callable })
        return { publicAgentId: String(row.id), engineAgentId: String(row.engine_agent_id), name: String(row.name), enabled, callable }
    })
}
