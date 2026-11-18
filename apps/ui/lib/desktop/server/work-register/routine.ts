import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import type { UIMessageChunk } from 'ai'
import { z } from 'zod'
import {
    DESKTOP_WORK_ROUTINE_NAME, DESKTOP_WORK_ROUTINE_SLUG, desktopWorkRoutineTurnText, desktopWorkSecretFindings, readRoutineReply,
    type DesktopForemanChatRef, type DesktopWorkRoutineView,
} from '@rerun/contracts'
import { EngineRequestError, request as engineRequest } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'
import { routineGuardRefusalOf } from '../schedules/health'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { ensureDesktopWorkRegister, recordDesktopWorkSummary } from './store'

/**
 * "Coordinate the team": the Chief of Staff's ready-made routine. Its timing is an ordinary schedule
 * of the foreman agent in the engine, so the engine's scheduler decides when it is due. The app keeps
 * what only the person writes: their agreed scope and whether they want a summary after each run.
 * Each firing is one new Chief of Staff conversation, started here with the routine's firing frame.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS desktop_work_routine (
 workspace_id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT '', summaries INTEGER NOT NULL DEFAULT 0 CHECK (summaries IN (0, 1)), updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_work_routine_runs (
 occurrence TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, chat_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
 test INTEGER NOT NULL CHECK (test IN (0, 1)), state TEXT NOT NULL CHECK (state IN ('reserved', 'started', 'failed')),
 error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_work_routine_runs_latest ON desktop_work_routine_runs(workspace_id, created_at);`
const ready = new WeakMap<Client, Promise<void>>()
async function ensure(db: Client) {
    await ensureDesktopWorkRegister(db)
    let pending = ready.get(db)
    if (!pending) { pending = db.executeMultiple(SCHEMA).then(() => {}); ready.set(db, pending); pending.catch(() => ready.delete(db)) }
    return pending
}

export type DesktopWorkRoutineSettings = { scope: string; summaries: boolean }
export async function readDesktopWorkRoutineSettings(db: Client, workspaceId: string): Promise<DesktopWorkRoutineSettings> {
    await ensure(db)
    const row = (await db.execute({ sql: 'SELECT scope, summaries FROM desktop_work_routine WHERE workspace_id=?', args: [workspaceId] })).rows[0]
    return { scope: row ? String(row.scope) : '', summaries: row ? Number(row.summaries) === 1 : false }
}

/** The person's words are theirs to write, but a key pasted into them is refused like anywhere in the register. */
export async function saveDesktopWorkRoutineSettings(db: Client, workspaceId: string, settings: DesktopWorkRoutineSettings, now = () => new Date()) {
    const found = desktopWorkSecretFindings(settings.scope)
    if (found.length) throw new DesktopHttpError(400, `Not saved: the scope looks like it holds a secret (${found.join(', ')}). Describe the work, never a key or password.`)
    await ensure(db)
    await db.execute({
        sql: `INSERT INTO desktop_work_routine(workspace_id, scope, summaries, updated_at) VALUES(?,?,?,?)
              ON CONFLICT(workspace_id) DO UPDATE SET scope=excluded.scope, summaries=excluded.summaries, updated_at=excluded.updated_at`,
        args: [workspaceId, settings.scope.trim(), settings.summaries ? 1 : 0, now().toISOString()],
    })
}

export type DesktopWorkRoutinePorts = {
    db: Client
    workspaceId: string
    /** A new, separate Chief of Staff conversation with this request id. */
    createConversation(requestId: string): Promise<DesktopForemanChatRef>
    /** The Chief of Staff's own send, with every check a typed message has. */
    send(chat: DesktopForemanChatRef, requestId: string, text: string): Promise<{ runId: string }>
    /** Every chunk of the run's reply, then its end. Registered before the send. */
    watchReply(runId: string, watcher: { chunk(chunk: UIMessageChunk): void; end(): void }): () => void
    now?: () => Date
}

/** The last text block of a reply: what it ended with, after any tool calls. */
function finalText() {
    const blocks = new Map<string, string>()
    let last: string | null = null
    return {
        chunk(chunk: UIMessageChunk) {
            if (chunk.type === 'text-start') { blocks.set(chunk.id, ''); last = chunk.id }
            else if (chunk.type === 'text-delta') { blocks.set(chunk.id, (blocks.get(chunk.id) ?? '') + chunk.delta); last = chunk.id }
        },
        read: () => last === null ? '' : blocks.get(last) ?? '',
    }
}

/**
 * Keeps this occurrence once. A second announcement of the same occurrence finds it and starts
 * nothing. Answers the conversation it belongs to.
 */
export async function reserveDesktopWorkRoutineRun(ports: Pick<DesktopWorkRoutinePorts, 'db' | 'workspaceId' | 'now'>, input: { occurrence: string; test: boolean }) {
    await ensure(ports.db)
    const requestId = randomUUID()
    const chatId = `fmc_${requestId}`
    const inserted = await ports.db.execute({
        sql: `INSERT INTO desktop_work_routine_runs(occurrence, workspace_id, chat_id, request_id, test, state, created_at) VALUES(?,?,?,?,?,'reserved',?) ON CONFLICT(occurrence) DO NOTHING`,
        args: [input.occurrence, ports.workspaceId, chatId, requestId, input.test ? 1 : 0, (ports.now?.() ?? new Date()).toISOString()],
    })
    if (Number(inserted.rowsAffected) === 1) return { requestId, chatId, fresh: true }
    const row = (await ports.db.execute({ sql: 'SELECT chat_id, request_id FROM desktop_work_routine_runs WHERE occurrence=?', args: [input.occurrence] })).rows[0]!
    return { requestId: String(row.request_id), chatId: String(row.chat_id), fresh: false }
}

/**
 * Starts a reserved firing: a new Chief of Staff conversation named after the routine, the firing
 * frame with the person's scope as quoted data, and, when the run ends with something to say and the
 * person asked for summaries, one summary notice. A quiet run ([[no-update]]) leaves no notice.
 */
export async function startDesktopWorkRoutineRun(ports: DesktopWorkRoutinePorts, input: { occurrence: string; test: boolean; requestId: string }): Promise<{ chatId: string }> {
    const { db, workspaceId } = ports
    const settings = await readDesktopWorkRoutineSettings(db, workspaceId)
    let stop: (() => void) | undefined
    try {
        const chat = await ports.createConversation(input.requestId)
        await db.execute({ sql: 'UPDATE desktop_foreman_chats SET title=? WHERE chat_id=? AND workspace_id=? AND title IS NULL', args: [input.test ? `${DESKTOP_WORK_ROUTINE_NAME} (test)` : DESKTOP_WORK_ROUTINE_NAME, chat.chatId, chat.workspaceId] })
        const reply = finalText()
        stop = ports.watchReply(input.requestId, {
            chunk: reply.chunk,
            end: () => {
                stop?.()
                const said = readRoutineReply(reply.read())
                if (!settings.summaries || said.quiet || !said.text.trim()) return
                void recordDesktopWorkSummary(db, workspaceId, { occurrence: input.occurrence, chatId: chat.chatId, text: said.text.trim() }, ports.now).catch(() => {})
            },
        })
        await ports.send(chat, input.requestId, desktopWorkRoutineTurnText(settings.scope, input.test))
        await db.execute({ sql: "UPDATE desktop_work_routine_runs SET state='started' WHERE occurrence=?", args: [input.occurrence] })
        return { chatId: chat.chatId }
    } catch (error) {
        stop?.()
        await db.execute({ sql: "UPDATE desktop_work_routine_runs SET state='failed', error=? WHERE occurrence=?", args: [(error instanceof Error ? error.message : String(error)).slice(0, 400), input.occurrence] }).catch(() => {})
        throw error
    }
}

async function lastRun(db: Client, workspaceId: string): Promise<DesktopWorkRoutineView['lastRun']> {
    const row = (await db.execute({ sql: 'SELECT * FROM desktop_work_routine_runs WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1', args: [workspaceId] })).rows[0]
    return row ? { chatId: String(row.chat_id), at: String(row.created_at), test: Number(row.test) === 1, state: row.state === 'failed' ? 'failed' : 'started' } : null
}

const scheduleSchema = z.object({ schedule: z.object({ enabled: z.boolean(), cron: z.string().nullable(), timezone: z.string().nullable(), lastRunAt: z.string().nullable(), nextRunAt: z.string().nullable() }).nullable() })
const PATH = '/desktop/foreman-routine'

export async function readDesktopWorkRoutine(runtime: DesktopRuntime, db: Client, signal?: AbortSignal): Promise<DesktopWorkRoutineView> {
    const workspaceId = String(runtime.workspaceId)
    const [{ schedule }, settings, last] = await Promise.all([
        engineRequest(engineOf(runtime), PATH, { method: 'GET', cache: 'no-store', signal }, value => scheduleSchema.parse(value)),
        readDesktopWorkRoutineSettings(db, workspaceId), ensure(db).then(() => lastRun(db, workspaceId)),
    ])
    return { enabled: schedule?.enabled ?? false, cron: schedule?.cron ?? null, timezone: schedule?.timezone ?? null, lastRunAt: schedule?.lastRunAt ?? null,
        nextRunAt: schedule?.nextRunAt ?? null, scope: settings.scope, summaries: settings.summaries, lastRun: last }
}

export async function saveDesktopWorkRoutine(runtime: DesktopRuntime, db: Client, input: { enabled: boolean; cron: string; timezone: string } & DesktopWorkRoutineSettings, signal?: AbortSignal) {
    const workspaceId = String(runtime.workspaceId)
    // The words first: a refused scope leaves the timing as it was.
    await saveDesktopWorkRoutineSettings(db, workspaceId, input)
    try {
        await engineRequest(engineOf(runtime), PATH, { method: 'PUT', body: JSON.stringify({ enabled: input.enabled, cron: input.cron, timezone: input.timezone }), signal, cache: 'no-store' }, () => undefined)
    } catch (error) {
        const refusal = routineGuardRefusalOf(error)
        if (refusal) throw refusal
        if (error instanceof EngineRequestError && error.status === 400) throw new DesktopHttpError(400, 'Choose days and times for the routine.')
        throw error
    }
    return readDesktopWorkRoutine(runtime, db, signal)
}

export const DESKTOP_WORK_ROUTINE_EVENT = 'desktop.work-routine.fire'
const firingSchema = z.strictObject({ event: z.literal(DESKTOP_WORK_ROUTINE_EVENT), slug: z.literal(DESKTOP_WORK_ROUTINE_SLUG), occurrence: z.string().min(1).max(200), firedAt: z.string().max(64) })

/**
 * The engine's scheduler found "Coordinate the team" due. The occurrence is kept before the answer,
 * and the conversation starts after it: the engine waits only seconds for an acknowledgement.
 * Caller MUST authenticate the engine callback first.
 */
export async function handleDesktopWorkRoutineBridge(body: unknown, store: () => Promise<Pick<DesktopWorkRoutinePorts, 'db' | 'workspaceId'>>, ports: () => Promise<DesktopWorkRoutinePorts>): Promise<Response | null> {
    if (!body || typeof body !== 'object' || (body as { event?: unknown }).event !== DESKTOP_WORK_ROUTINE_EVENT) return null
    const parsed = firingSchema.safeParse(body)
    if (!parsed.success) throw new DesktopHttpError(400, 'Invalid routine firing')
    // Only the database is needed to keep the occurrence; the Chief of Staff's runtime is opened after the answer.
    const reserved = await reserveDesktopWorkRoutineRun(await store(), { occurrence: parsed.data.occurrence, test: false })
    if (reserved.fresh) void ports().then(resolved => startDesktopWorkRoutineRun(resolved, { occurrence: parsed.data.occurrence, test: false, requestId: reserved.requestId }))
        .catch(async error => {
            const { db } = await store()
            await db.execute({ sql: "UPDATE desktop_work_routine_runs SET state='failed', error=? WHERE occurrence=? AND state='reserved'", args: [(error instanceof Error ? error.message : String(error)).slice(0, 400), parsed.data.occurrence] }).catch(() => {})
        })
    return Response.json({ ok: true, persisted: true }, { headers: { 'Cache-Control': 'no-store' } })
}

/** Run now: a test firing the person starts by hand, marked as a test in its frame. */
export async function runDesktopWorkRoutineNow(ports: DesktopWorkRoutinePorts, requestId: string) {
    const reserved = await reserveDesktopWorkRoutineRun(ports, { occurrence: `test:${requestId}`, test: true })
    if (!reserved.fresh) return { chatId: reserved.chatId }
    return startDesktopWorkRoutineRun(ports, { occurrence: `test:${requestId}`, test: true, requestId: reserved.requestId })
}
