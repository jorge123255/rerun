import 'server-only'
import type { Client, Row } from '@libsql/client'
import { z } from 'zod'
import { sanitizeIdentifier } from '@/lib/utils'
import { request as engineRequest } from '@/lib/engine/client'
import { desktopSpacePositionSchema } from '../spaces'
import type { DesktopCreationIntent } from '../new-agent'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import { startDesktopChat } from './engine'
import { desktopModel, engineOf } from './settings'
import { withRosterWrite } from './roster-writes'
import { findDesktopAgent } from './store'
import { desktopBoardRevisionWrite, desktopDuplicateDestination, desktopPlacementInsert } from './spaces'

const intentSchema = z.object({ requestId: z.uuid(), name: z.string().trim().min(1).max(60), kickoff: z.string().trim().min(1).max(2000), suggestionId: z.null(), scheduled: z.literal(false) }).strict()
export const desktopCreationRequest = z.object({ intent: intentSchema, position: desktopSpacePositionSchema, spaceId: z.uuid() }).strict()
type Input = z.infer<typeof desktopCreationRequest>
export const desktopCreationAck = z.object({ requestId: z.uuid() }).strict()
const createdSchema = z.object({ id: z.string(), config: z.object({ name: z.string(), displayName: z.string().optional() }) })
const unknown = () => new DesktopHttpError(503, 'Could not confirm creation and the first chat. Retry this same placement; it will not create another coworker.')
const readReceipt = async (db: Client, id: string) => (await db.execute({ sql: 'SELECT * FROM desktop_creations WHERE request_id=?', args: [id] })).rows[0]
const intentOf = (row: Row) => intentSchema.parse(JSON.parse(String(row.intent)))

export async function readPendingDesktopCreation(runtime: Parameters<typeof engineOf>[0]) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const row = (await db.execute('SELECT * FROM desktop_creations WHERE acknowledged=0')).rows[0]
    return row ? { intent: intentOf(row), position: { col: Number(row.board_col), row: Number(row.board_row) }, spaceId: String(row.space_id), phase: String(row.phase) } : null
}

export async function acknowledgeDesktopCreation(runtime: Parameters<typeof engineOf>[0], requestId: string) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const row = await readReceipt(db, requestId)
    if (!row || row.phase !== 'started') throw new DesktopHttpError(409, 'The first chat has not been confirmed yet.')
    await db.execute({ sql: "UPDATE desktop_creations SET acknowledged=1 WHERE request_id=? AND phase='started'", args: [requestId] })
}

async function reserve(db: Client, runtime: Parameters<typeof engineOf>[0], input: Input) {
    const previous = await readReceipt(db, input.intent.requestId)
    if (previous) {
        if (String(previous.intent) !== JSON.stringify(input.intent) || previous.space_id !== input.spaceId || previous.board_col !== input.position.col || previous.board_row !== input.position.row)
            throw new DesktopHttpError(409, 'This creation belongs to a different description or placement. Resume the saved attempt.')
        return previous
    }
    if ((await db.execute('SELECT 1 FROM desktop_creations WHERE acknowledged=0')).rows.length) throw new DesktopHttpError(409, 'Resume the unfinished coworker creation first.')
    const spaceId = await desktopDuplicateDestination(db, input.position, input.spaceId)
    const { connection } = await desktopModel(runtime)
    const handle = `${sanitizeIdentifier(input.intent.name).replace(/^_+|_+$/g, '') || 'coworker'}-${input.intent.requestId}`
    const config = { name: handle, displayName: input.intent.name, description: '', enabled: true, connectionId: connection.id, provider: connection.provider, model: null }
    await db.execute({ sql: `INSERT INTO desktop_creations(request_id,intent,agent_id,config,space_id,board_col,board_row,phase,created_at) VALUES(?,?,?,?,?,?,?,'reserved',?)`,
        args: [input.intent.requestId, JSON.stringify(input.intent), crypto.randomUUID(), JSON.stringify(config), spaceId, input.position.col, input.position.row, new Date().toISOString()] })
    return (await readReceipt(db, input.intent.requestId))!
}

async function publish(db: Client, runtime: Parameters<typeof engineOf>[0], receipt: Row) {
    const intent = intentOf(receipt)
    const agentId = String(receipt.agent_id)
    if (receipt.phase !== 'reserved') {
        const existing = await findDesktopAgent(db, agentId)
        if (!existing || existing.engineAgentId !== `new-${intent.requestId.toLowerCase()}`) throw unknown()
        return existing
    }
    await desktopDuplicateDestination(db, { col: Number(receipt.board_col), row: Number(receipt.board_row) }, String(receipt.space_id), agentId)
    const config = JSON.parse(String(receipt.config))
    const created = await engineRequest(engineOf(runtime), '/desktop/agents/create', {
        method: 'POST', body: JSON.stringify({ requestId: intent.requestId, config }), signal: AbortSignal.timeout(20_000),
    }, value => createdSchema.parse(value))
    if (created.id !== `new-${intent.requestId.toLowerCase()}` || created.config.name !== config.name || created.config.displayName !== intent.name) throw unknown()
    // The local coworker, exact board position, first-chat tab and phase become visible together.
    // A lost engine reply recovers from the same engine receipt before any local row is created.
    const now = new Date().toISOString()
    await db.batch([
        { sql: 'INSERT INTO desktop_agents(id,workspace_id,engine_agent_id,name,description,enabled,created_at,updated_at) VALUES(?,1,?,?,?,1,?,?)', args: [agentId, created.id, intent.name, '', now, now] },
        desktopPlacementInsert({ agentId, spaceId: String(receipt.space_id), col: Number(receipt.board_col), row: Number(receipt.board_row) }),
        desktopBoardRevisionWrite,
        { sql: 'INSERT INTO desktop_agent_tabs(agent_id,revision,layout) VALUES(?,0,?)', args: [agentId, JSON.stringify({ activeIndex: 0, tabs: [{ uid: intent.requestId, id: null, title: 'New conversation' }] })] },
        { sql: "UPDATE desktop_creations SET phase='created' WHERE request_id=? AND phase='reserved'", args: [intent.requestId] },
    ], 'write')
    return (await findDesktopAgent(db, agentId))!
}

// A single launch may receive overlapping retries from independent route bundles. The durable
// engine first-turn receipt remains the authority after Quit; this map only coalesces observers.
const KEY = Symbol.for('rerun.desktop.creation.calls.v1')
type Outcome = { agent: NonNullable<Awaited<ReturnType<typeof findDesktopAgent>>>; sessionId: string }
const calls = () => ((globalThis as unknown as Record<symbol, Map<string, { input: string; promise: Promise<Outcome> }>>)[KEY] ??= new Map())
export function createDescribedDesktopCoworker(runtime: Parameters<typeof engineOf>[0], input: Input): Promise<Outcome> {
    const key = JSON.stringify([runtime.dataRoot, runtime.launchNonce, input.intent.requestId]), fingerprint = JSON.stringify(input)
    const pending = calls().get(key)
    if (pending) return pending.input === fingerprint ? pending.promise : Promise.reject(new DesktopHttpError(409, 'Creation identity was reused.'))
    const work = async () => {
        const db = await openDesktopDatabase(runtime.dataRoot)
        const agent = await withRosterWrite(async () => publish(db, runtime, await reserve(db, runtime, input)))
        const row = (await readReceipt(db, input.intent.requestId))!
        if (row.phase === 'started' && typeof row.session_id === 'string') return { agent, sessionId: row.session_id }
        const kickoff = await startDesktopChat(runtime, { agentId: agent.id, text: input.intent.kickoff, tabUid: input.intent.requestId })
        // The stream only observes an already admitted engine run. Drain without retaining output;
        // the engine persists its reply and the newly opened chat reads that same run.
        if (kickoff.response.body) void kickoff.response.body.pipeTo(new WritableStream({ write() {} })).catch(() => {})
        await db.batch([
            { sql: "UPDATE desktop_creations SET phase='started',session_id=? WHERE request_id=?", args: [kickoff.sessionId, input.intent.requestId] },
            { sql: `UPDATE desktop_agent_tabs SET revision=revision+1,layout=? WHERE agent_id=? AND revision=0`, args: [JSON.stringify({ activeIndex: 0, tabs: [{ uid: input.intent.requestId, id: kickoff.sessionId, title: input.intent.kickoff.slice(0, 80) }] }), agent.id] },
        ], 'write')
        return { agent, sessionId: kickoff.sessionId }
    }
    const promise = Promise.resolve().then(work)
    calls().set(key, { input: fingerprint, promise })
    const finish = () => { if (calls().get(key)?.promise === promise) calls().delete(key) }
    void promise.then(finish, finish)
    return promise
}

export async function hasDesktopCreationReceipt(runtime: Parameters<typeof engineOf>[0], requestId: string) {
    return !!await readReceipt(await openDesktopDatabase(runtime.dataRoot), requestId)
}
