import { buildInstallMessage } from '@/lib/chat/install-marker'
import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DESKTOP_SETUP_DEFAULT_PROMPT, desktopSetupMutationResultSchema, type DesktopSetupMutationResult, type DesktopSetupView } from '@rerun/contracts'
import { EngineRequestError, getSessionMessages, request } from '@/lib/engine/client'
import type { Client, Row } from '@libsql/client'
import { DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { startDesktopChat } from '../engine'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { assertDesktopCreationSettled } from '../creation-guard'
import type { DesktopRuntime } from '../runtime'
import { findDesktopAgent, findDesktopSession, createDesktopSession, type DesktopAgent } from '../store'
import { ensureDesktopSetupSchema } from './schema'

const engineSetupSchema = z.object({ required: z.boolean().nullable(), prompt: z.string(), completedAt: z.string().nullable(), sessionId: z.string().nullable(), pending: z.boolean(), revision: z.string() })
type EngineSetup = z.infer<typeof engineSetupSchema>
type MutationInput = { action: string; requestId: string; expectedRevision: string; prompt?: string; required?: boolean | null }
const intentSchema = z.object({ engineRevision: z.string(), claimedEngineSessionId: z.string().nullable(), action: z.enum(['save', 'start', 'continue', 'skip']), prompt: z.string().optional(), required: z.boolean().nullable().optional() })
type Intent = z.infer<typeof intentSchema>
const errorChanged = () => new DesktopHttpError(409, 'The setup changed since it was read. Reload and try again.')
const engineOf = (runtime: DesktopRuntime) => ({ baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey })
const fingerprintOf = (agentId: string, input: MutationInput) => createHash('sha256').update(JSON.stringify({ agentId, action: input.action, expectedRevision: input.expectedRevision,
    ...(input.action === 'save' && { prompt: input.prompt ?? '', required: input.required ?? null }) })).digest('hex')

// Route bundles share one process, but SQLite remains the authority after restart. This queue
// coalesces per-owner work while the partial unique index refuses cross-process overlapping intents.
const LOCKS = Symbol.for('rerun.desktop.setup.owner-locks.v1')
const locks = () => ((globalThis as unknown as Record<symbol, Map<string, Promise<unknown>>>)[LOCKS] ??= new Map())
function withOwner<T>(runtime: DesktopRuntime, id: string, fn: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([runtime.dataRoot, id])
    const result = (locks().get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
    locks().set(key, result)
    const clear = () => { if (locks().get(key) === result) locks().delete(key) }
    void result.then(clear, clear)
    return result
}

async function skippedOf(db: Client, agentId: string): Promise<boolean> {
    return Number((await db.execute({ sql: 'SELECT skipped FROM desktop_setup_state WHERE agent_id=?', args: [agentId] })).rows[0]?.skipped) === 1
}
async function engineSetup(runtime: DesktopRuntime, engineAgentId: string): Promise<EngineSetup> {
    return request(engineOf(runtime), `/agents/${encodeURIComponent(engineAgentId)}/setup`, { method: 'GET' }, value => engineSetupSchema.parse(value))
}
async function ensureSetupDesktopSession(db: Client, agent: DesktopAgent, engineSessionId: string): Promise<string> {
    const existing = (await db.execute({ sql: 'SELECT id FROM desktop_sessions WHERE agent_id=? AND engine_session_id=?', args: [agent.id, engineSessionId] })).rows[0]
    if (existing) return String(existing.id)
    return (await createDesktopSession(db, { agentId: agent.id, engineSessionId, title: 'Setup' })).id
}
async function viewOf(db: Client, agent: DesktopAgent, setup: EngineSetup, skipped: boolean): Promise<DesktopSetupView> {
    return { agentId: agent.id,
        revision: createHash('sha256').update(`${setup.revision}:${skipped ? 1 : 0}`).digest('base64url').slice(0, 24),
        required: setup.required, prompt: setup.prompt, completedAt: setup.completedAt,
        sessionId: setup.sessionId ? await ensureSetupDesktopSession(db, agent, setup.sessionId) : null,
        pending: setup.pending && !skipped, skipped, defaultPrompt: DESKTOP_SETUP_DEFAULT_PROMPT }
}
async function agentFor(runtime: DesktopRuntime, agentId: string): Promise<{ db: Client; agent: DesktopAgent }> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    await ensureDesktopSetupSchema(db)
    await assertCoworkerNotDeleting(db, agentId)
    const agent = await findDesktopAgent(db, agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    return { db, agent }
}
const receiptOf = async (db: Client, requestId: string) => (await db.execute({ sql: 'SELECT * FROM desktop_setup_intents WHERE request_id=?', args: [requestId] })).rows[0]
const pendingOf = async (db: Client, agentId: string) => (await db.execute({ sql: "SELECT * FROM desktop_setup_intents WHERE agent_id=? AND status='pending'", args: [agentId] })).rows[0]

async function kickoffSetup(runtime: DesktopRuntime, db: Client, agent: DesktopAgent, engineSessionId: string, sessionId: string) {
    let receipt = (await db.execute({ sql: 'SELECT * FROM desktop_setup_kickoffs WHERE agent_id=? AND engine_session_id=?', args: [agent.id, engineSessionId] })).rows[0]
    if (!receipt) {
        // Adopt a pre-existing setup conversation without adding another welcome message. A
        // reserved receipt, unlike this migration case, always reconciles its exact run identity.
        const messages = await getSessionMessages(engineOf(runtime), agent.engineAgentId, engineSessionId, { requireSuccess: true })
        await db.execute({ sql: 'INSERT INTO desktop_setup_kickoffs(agent_id,engine_session_id,run_id,prompt,status) VALUES(?,?,?,?,?) ON CONFLICT(agent_id,engine_session_id) DO NOTHING',
            args: [agent.id, engineSessionId, randomUUID(), buildInstallMessage((await engineSetup(runtime, agent.engineAgentId)).prompt, agent.name), messages.some(message => message.role === 'user') ? 'existing' : 'reserved'] })
        receipt = (await db.execute({ sql: 'SELECT * FROM desktop_setup_kickoffs WHERE agent_id=? AND engine_session_id=?', args: [agent.id, engineSessionId] })).rows[0]
    }
    if (!receipt || (receipt.status !== 'reserved' && receipt.status !== 'admitted' && receipt.status !== 'existing')) throw new DesktopHttpError(409, 'The saved setup start is damaged.')
    if (receipt.status !== 'reserved') return
    const started = await startDesktopChat(runtime, { agentId: agent.id, sessionId, text: String(receipt.prompt), requestId: String(receipt.run_id) })
    if (started.sessionId !== sessionId || started.response.headers.get('x-run-id') !== receipt.run_id) throw new DesktopHttpError(502, 'The engine returned a different setup start.')
    // The run is persisted and continues independently of this observer. Opening its tab reads
    // the same history; no browser callback has permission to submit the kickoff again.
    if (started.response.body) void started.response.body.pipeTo(new WritableStream({ write() {} })).catch(() => {})
    await db.execute({ sql: "UPDATE desktop_setup_kickoffs SET status='admitted' WHERE agent_id=? AND engine_session_id=? AND run_id=?", args: [agent.id, engineSessionId, String(receipt.run_id)] })
}

async function finishIntent(runtime: DesktopRuntime, db: Client, agent: DesktopAgent, row: Row): Promise<DesktopSetupMutationResult> {
    if (row.agent_id !== agent.id) throw new DesktopHttpError(409, 'This setup request belongs to another coworker.')
    if (row.status === 'complete') return desktopSetupMutationResultSchema.parse(JSON.parse(String(row.result)))
    if (row.status === 'rejected') {
        const rejection = z.object({ status: z.number(), message: z.string() }).parse(JSON.parse(String(row.result)))
        throw new DesktopHttpError(rejection.status, rejection.message)
    }
    const intent: Intent = intentSchema.parse(JSON.parse(String(row.intent)))
    const base = `/agents/${encodeURIComponent(agent.engineAgentId)}/setup`
    let sessionId: string | null = null
    let skipped = await skippedOf(db, agent.id)
    // Only a definite rejection of the engine mutation releases this intent. A network failure
    // or later kickoff failure remains pending because its earlier effects may already exist.
    const engineMutation = async <T>(perform: () => Promise<T>): Promise<T> => {
        try { return await perform() }
        catch (error) {
            if (error instanceof EngineRequestError && ([400, 403, 404].includes(error.status) || (error.status === 409 && /"code"\s*:\s*"setup_mutation_rejected"/.test(error.message)))) {
                const message = error.status === 409 ? 'The setup changed since it was read. Reload and try again.'
                    : error.status === 403 ? 'This coworker is switched off and cannot run.' : 'This setup change was refused. Reload and try again.'
                await db.execute({ sql: "UPDATE desktop_setup_intents SET status='rejected',result=? WHERE request_id=? AND agent_id=? AND status='pending'", args: [JSON.stringify({ status: error.status, message }), String(row.request_id), agent.id] })
                throw new DesktopHttpError(error.status, message)
            }
            throw new DesktopHttpError(503, 'Could not confirm this setup change. Retry to resume the same attempt.')
        }
    }
    if (intent.action === 'save') {
        await engineMutation(() => request(engineOf(runtime), `${base}/save`, { method: 'POST', body: JSON.stringify({ requestId: row.request_id, expectedRevision: intent.engineRevision, prompt: intent.prompt ?? '', required: intent.required ?? null }) }, value => engineSetupSchema.parse(value)))
        skipped = false
    } else if (intent.action === 'start' || intent.action === 'continue') {
        if (!agent.enabled) throw new DesktopHttpError(403, 'This coworker is switched off and cannot run.')
        const claimed = intent.action === 'start' ? await engineMutation(() => request(engineOf(runtime), `${base}/claim`, {
            method: 'POST', body: JSON.stringify({ requestId: row.request_id, expectedRevision: intent.engineRevision }),
        }, value => z.object({ sessionId: z.string().min(1) }).parse(value))) : { sessionId: intent.claimedEngineSessionId }
        if (!claimed.sessionId) throw new DesktopHttpError(409, 'No setup chat is claimed. Reload and start setup.')
        const current = await engineSetup(runtime, agent.engineAgentId)
        if (current.sessionId !== claimed.sessionId) throw errorChanged()
        sessionId = await ensureSetupDesktopSession(db, agent, claimed.sessionId)
        await kickoffSetup(runtime, db, agent, claimed.sessionId, sessionId)
        skipped = false
    } else if (intent.action === 'skip') skipped = true
    const view = await viewOf(db, agent, await engineSetup(runtime, agent.engineAgentId), skipped)
    const result: DesktopSetupMutationResult = { view, ...(sessionId && { sessionId }) }
    // The local verdict, event and acknowledgement commit together. A process failure before
    // this transaction retries the already-reserved engine mutation/kickoff, never a fresh turn.
    const now = new Date().toISOString()
    await db.batch([
        { sql: `INSERT INTO desktop_setup_state(agent_id,skipped,updated_at) VALUES(?,?,?) ON CONFLICT(agent_id) DO UPDATE SET skipped=excluded.skipped,updated_at=excluded.updated_at`, args: [agent.id, Number(skipped), now] },
        { sql: "UPDATE desktop_setup_intents SET status='complete',result=? WHERE request_id=? AND agent_id=? AND status='pending'", args: [JSON.stringify(result), String(row.request_id), agent.id] },
        { sql: 'INSERT INTO desktop_setup_events(agent_id,kind,detail,created_at) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM desktop_setup_events WHERE agent_id=? AND kind=? AND detail=?)', args: [agent.id, intent.action, String(row.request_id), now, agent.id, intent.action, String(row.request_id)] },
    ], 'write')
    return result
}

export function readDesktopSetupView(runtime: DesktopRuntime, agentId: string): Promise<DesktopSetupView> {
    return withOwner(runtime, agentId, async () => {
        const { db, agent } = await agentFor(runtime, agentId)
        const pending = await pendingOf(db, agentId)
        // A previous explicit Start/Save is durable authorization to resume that same attempt.
        // If the engine is temporarily down, preserve it and keep the panel readable on retry.
        if (pending) await finishIntent(runtime, db, agent, pending).catch(() => {})
        const setup = await engineSetup(runtime, agent.engineAgentId)
        if (setup.completedAt) await db.execute({ sql: "INSERT INTO desktop_setup_events(agent_id,kind,detail,created_at) SELECT ?,'completed',?,? WHERE NOT EXISTS(SELECT 1 FROM desktop_setup_events WHERE agent_id=? AND kind='completed' AND detail=?)", args: [agentId, setup.completedAt, new Date().toISOString(), agentId, setup.completedAt] })
        return viewOf(db, agent, setup, await skippedOf(db, agentId))
    })
}

export function mutateDesktopSetup(runtime: DesktopRuntime, agentId: string, input: MutationInput): Promise<DesktopSetupMutationResult> {
    return withOwner(runtime, agentId, async () => {
        const { db, agent } = await agentFor(runtime, agentId)
        await assertDesktopCreationSettled(db, agentId)
        const fingerprint = fingerprintOf(agentId, input)
        const previous = await receiptOf(db, input.requestId)
        if (previous) {
            if (previous.agent_id !== agentId || previous.action !== input.action || previous.fingerprint !== fingerprint) throw new DesktopHttpError(409, 'This setup request was already used for a different change.')
            return finishIntent(runtime, db, agent, previous)
        }
        const pending = await pendingOf(db, agentId)
        if (pending) {
            await finishIntent(runtime, db, agent, pending)
            throw errorChanged()
        }
        const setup = await engineSetup(runtime, agent.engineAgentId)
        const skipped = await skippedOf(db, agentId)
        const current = await viewOf(db, agent, setup, skipped)
        if (current.revision !== input.expectedRevision) throw errorChanged()
        if ((input.action === 'start' || input.action === 'continue' || input.action === 'skip') && !setup.pending) throw new DesktopHttpError(409, 'This coworker does not have pending setup.')
        if (input.action === 'continue' && !setup.sessionId) throw new DesktopHttpError(409, 'No setup chat is claimed. Reload and start setup.')
        const intent = intentSchema.parse({ action: input.action, engineRevision: setup.revision, claimedEngineSessionId: setup.sessionId,
            ...(input.action === 'save' && { prompt: input.prompt ?? '', required: input.required ?? null }) })
        const tx = await db.transaction('write')
        try {
            const other = (await tx.execute({ sql: "SELECT request_id FROM desktop_setup_intents WHERE agent_id=? AND status='pending'", args: [agentId] })).rows[0]
            if (other) throw new DesktopHttpError(409, 'Another setup change is being saved. Reload to resume it.')
            const local = (await tx.execute({ sql: 'SELECT skipped FROM desktop_setup_state WHERE agent_id=?', args: [agentId] })).rows[0]
            if ((Number(local?.skipped) === 1) !== skipped) throw errorChanged()
            await tx.execute({ sql: "INSERT INTO desktop_setup_intents(request_id,agent_id,action,fingerprint,intent,status,created_at) VALUES(?,?,?,?,?,'pending',?)", args: [input.requestId, agentId, input.action, fingerprint, JSON.stringify(intent), new Date().toISOString()] })
            await tx.commit()
        } catch (error) { await tx.rollback(); throw error } finally { tx.close() }
        return finishIntent(runtime, db, agent, (await receiptOf(db, input.requestId))!)
    })
}

/** Central chat admission uses the engine claim, never a renderer supplied setup flag. This read
 * deliberately does not resume pending UI intents: kickoff itself calls startDesktopChat. */
export async function assertDesktopSetupChatAllowed(runtime: DesktopRuntime, agentId: string, sessionId?: string): Promise<void> {
    const { db, agent } = await agentFor(runtime, agentId)
    const setup = await engineSetup(runtime, agent.engineAgentId)
    if (!setup.pending || await skippedOf(db, agentId)) return
    const session = sessionId ? await findDesktopSession(db, sessionId) : null
    if (!session || session.agentId !== agentId || session.engineSessionId !== setup.sessionId) throw new DesktopHttpError(409, 'Start or continue this coworker’s setup before opening another conversation.')
}
