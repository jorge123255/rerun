import { createHash } from 'node:crypto'

import type { Client, Transaction } from '@libsql/client'
import {
    DESKTOP_FOREMAN_INTAKE_MISSING,
    desktopForemanIntakeCompletionReceiptSchema,
    desktopForemanIntakeCompleteInputSchema,
    desktopForemanIntakeAnswersSchema,
    desktopForemanIntakeDraftSchema,
    desktopForemanIntakeSaveInputSchema,
    desktopForemanIntakeSessionSchema,
    desktopForemanIntakeViewSchema,
    EMPTY_DRAFT,
    intakeSteps,
    stepAnswered,
    toIntake,
    type DesktopForemanChatRef,
    type DesktopForemanIntakeCompletionAuthority,
    type DesktopForemanIntakeCompletionReceipt,
    type DesktopForemanIntakeCompleteInput,
    type DesktopForemanIntakeSaveInput,
    type DesktopForemanIntakeSession,
    type DesktopForemanIntakeView,
} from '@rerun/contracts'

import { ensureDesktopForemanIntakeSchema } from './schema'

export class DesktopForemanIntakeConflictError extends Error {
    readonly status = 409
    constructor(
        readonly view: DesktopForemanIntakeView,
        message = 'This intake draft changed in another panel. Review the saved answers before continuing.',
    ) {
        super(message)
        this.name = 'DesktopForemanIntakeConflictError'
    }
}

export class DesktopForemanIntakeRefusal extends Error {
    readonly status: number
    constructor(status: number, message: string) {
        super(message)
        this.status = status
        this.name = 'DesktopForemanIntakeRefusal'
    }
}

type SessionRow = {
    session: DesktopForemanIntakeSession
}

type WriteRow = {
    requestId: string
    chat: DesktopForemanChatRef
    fingerprint: string
    resultRevision: number
}

export type DesktopForemanIntakeStore = {
    read(chat: DesktopForemanChatRef): Promise<DesktopForemanIntakeView>
    save(input: DesktopForemanIntakeSaveInput): Promise<DesktopForemanIntakeView>
    complete(
        input: DesktopForemanIntakeCompleteInput,
        authority: DesktopForemanIntakeCompletionAuthority | null,
        now?: () => Date,
    ): Promise<DesktopForemanIntakeCompletionReceipt>
    lookupCompletion(chat: DesktopForemanChatRef, requestId: string): Promise<DesktopForemanIntakeCompletionReceipt | null>
}

const sameChat = (a: DesktopForemanChatRef, b: DesktopForemanChatRef) => a.workspaceId === b.workspaceId && a.chatId === b.chatId

function fingerprintSave(input: DesktopForemanIntakeSaveInput): string {
    return createHash('sha256')
        .update(
            JSON.stringify([
                'desktop-foreman-intake-save-v1',
                input.chat,
                input.baseRevision,
                input.stepIndex,
                input.draft,
                input.decidedIndustry,
                input.knownFirstName,
            ]),
        )
        .digest('hex')
}

export function fingerprintIntakeAnswers(answers: DesktopForemanIntakeCompleteInput['answers'], chat: DesktopForemanChatRef, requestId: string): string {
    return createHash('sha256').update(JSON.stringify(['desktop-foreman-intake-complete-v1', chat.workspaceId, chat.chatId, requestId, desktopForemanIntakeAnswersSchema.parse(answers)])).digest('hex')
}

// The earlier source package called ambiguous delivery exceptions "failed". Keep those legacy
// identities reserved too; only unavailable proves that no authority was invoked.
const activeCompletion = (receipt: DesktopForemanIntakeCompletionReceipt) => receipt.state !== 'unavailable'
const completionPriority = (receipt: DesktopForemanIntakeCompletionReceipt) => receipt.state === 'acknowledged' ? 2 : activeCompletion(receipt) ? 1 : 0
const COMPLETION_FLIGHTS = Symbol.for('rerun.desktop.foreman.intake.flights.v1')
const completionFlights = () => ((globalThis as unknown as Record<symbol, WeakMap<object, Map<string, Promise<DesktopForemanIntakeCompletionReceipt>>>>)[COMPLETION_FLIGHTS] ??= new WeakMap())
const SQLITE_WRITES = Symbol.for('rerun.desktop.foreman.intake.sqlite-writes.v2')
const sqliteWrites = () => ((globalThis as unknown as Record<symbol, { tail: Promise<unknown> }>)[SQLITE_WRITES] ??= { tail: Promise.resolve() })
type SqliteExecutor = Pick<Transaction, 'execute'>

// Native SQLite BEGIN may synchronously wait for another connection's write lock. Two Clients
// on the same local file must not block the JavaScript continuation that commits the first one.
// Share a short process-wide queue for schema/transactions; authority work is never enqueued.
// Other processes remain fenced by SQLite transactions and the durable unique/CAS constraints.
function serializeSqliteIntakeWrite<T>(work: () => Promise<T>): Promise<T> {
    const queue = sqliteWrites()
    const result = queue.tail.catch(() => {}).then(work)
    queue.tail = result.catch(() => {})
    return result
}

function completionFromRow(row: Record<string, unknown>): DesktopForemanIntakeCompletionReceipt {
    try {
        const receipt = desktopForemanIntakeCompletionReceiptSchema.parse(JSON.parse(String(row.body)))
        if (receipt.requestId !== String(row.request_id) || receipt.chat.workspaceId !== String(row.workspace_id) || receipt.chat.chatId !== String(row.chat_id)
            || receipt.fingerprint !== String(row.fingerprint) || receipt.state !== String(row.state)
            || receipt.createdAt !== String(row.created_at) || receipt.updatedAt !== String(row.updated_at)
            || fingerprintIntakeAnswers(receipt.answers, receipt.chat, receipt.requestId) !== receipt.fingerprint) throw new Error('Identity mismatch')
        return receipt
    } catch { throw new DesktopForemanIntakeRefusal(503, 'The saved intake completion identity could not be confirmed.') }
}

function deliverOnce(key: object, receipt: DesktopForemanIntakeCompletionReceipt, work: () => Promise<DesktopForemanIntakeCompletionReceipt>) {
    let flights = completionFlights().get(key)
    if (!flights) { flights = new Map(); completionFlights().set(key, flights) }
    const current = flights.get(receipt.requestId)
    if (current) return current
    const result = work()
    flights.set(receipt.requestId, result)
    void result.then(() => { if (flights!.get(receipt.requestId) === result) flights!.delete(receipt.requestId) }, () => { if (flights!.get(receipt.requestId) === result) flights!.delete(receipt.requestId) })
    return result
}

function emptySession(chat: DesktopForemanChatRef, knownFirstName: string | null, now: string): DesktopForemanIntakeSession {
    return desktopForemanIntakeSessionSchema.parse({
        chat,
        revision: 0,
        stepIndex: 0,
        draft: { ...EMPTY_DRAFT },
        decidedIndustry: null,
        knownFirstName,
        updatedAt: now,
    })
}

function viewOf(session: DesktopForemanIntakeSession, completion: DesktopForemanIntakeCompletionReceipt | null): DesktopForemanIntakeView {
    return desktopForemanIntakeViewSchema.parse({ session, completion })
}

/** In-memory durable store for regressions and root wiring before SQLite activation. */
export function createMemoryDesktopForemanIntakeStore(options?: {
    knownFirstName?: string | null
    now?: () => Date
}): DesktopForemanIntakeStore & {
    dump: () => { sessions: DesktopForemanIntakeSession[]; completions: DesktopForemanIntakeCompletionReceipt[]; writes: WriteRow[] }
} {
    const sessions = new Map<string, SessionRow>()
    const writes = new Map<string, WriteRow>()
    const completions = new Map<string, DesktopForemanIntakeCompletionReceipt>()
    const keyOf = (chat: DesktopForemanChatRef) => JSON.stringify([chat.workspaceId, chat.chatId])
    const coordinationKey = {}
    const stamp = () => (options?.now ?? (() => new Date()))().toISOString()
    let chain = Promise.resolve()

    const run = <T>(work: () => Promise<T> | T): Promise<T> => {
        const next = chain.then(() => work())
        chain = next.then(
            () => undefined,
            () => undefined,
        )
        return next
    }

    const readSession = (chat: DesktopForemanChatRef): DesktopForemanIntakeSession => {
        const existing = sessions.get(keyOf(chat))
        if (existing) return existing.session
        return emptySession(chat, options?.knownFirstName ?? null, stamp())
    }

    const latestCompletionFor = (chat: DesktopForemanChatRef): DesktopForemanIntakeCompletionReceipt | null => {
        const matches = [...completions.values()].filter(entry => sameChat(entry.chat, chat))
        matches.sort((a, b) => completionPriority(a) - completionPriority(b) || a.updatedAt.localeCompare(b.updatedAt))
        return matches.at(-1) ?? null
    }

    return {
        dump: () => ({
            sessions: [...sessions.values()].map(entry => entry.session),
            completions: [...completions.values()],
            writes: [...writes.values()],
        }),
        read(chat) {
            return run(async () => viewOf(readSession(chat), latestCompletionFor(chat)))
        },
        save(input) {
            return run(async () => {
                input = desktopForemanIntakeSaveInputSchema.parse(input)
                const parsed = desktopForemanIntakeDraftSchema.parse(input.draft)
                const current = readSession(input.chat)
                const hash = fingerprintSave({ ...input, draft: parsed })
                const prior = writes.get(input.requestId)
                if (prior) {
                    if (!sameChat(prior.chat, input.chat) || prior.fingerprint !== hash) {
                        throw new DesktopForemanIntakeConflictError(
                            viewOf(current, latestCompletionFor(input.chat)),
                            'That intake save request was already used for a different change.',
                        )
                    }
                    return viewOf(readSession(input.chat), latestCompletionFor(input.chat))
                }
                if (input.baseRevision !== current.revision) {
                    throw new DesktopForemanIntakeConflictError(viewOf(current, latestCompletionFor(input.chat)))
                }
                const completed = latestCompletionFor(input.chat)
                if (completed && activeCompletion(completed)) {
                    throw new DesktopForemanIntakeConflictError(viewOf(current, completed), 'This intake already has a reserved completion. Resolve the same request before editing answers.')
                }
                const now = stamp()
                const next = desktopForemanIntakeSessionSchema.parse({
                    chat: input.chat,
                    revision: current.revision + 1,
                    stepIndex: input.stepIndex,
                    draft: parsed,
                    decidedIndustry: input.decidedIndustry,
                    knownFirstName: input.knownFirstName,
                    updatedAt: now,
                })
                sessions.set(keyOf(input.chat), { session: next })
                writes.set(input.requestId, {
                    requestId: input.requestId,
                    chat: input.chat,
                    fingerprint: hash,
                    resultRevision: next.revision,
                })
                return viewOf(next, completed)
            })
        },
        async complete(input, authority, now = () => new Date()) {
            input = desktopForemanIntakeCompleteInputSchema.parse(input)
            const receipt = await run(async () =>
                reserveIntakeCompletion({
                    input,
                    authorityAvailable: !!authority,
                    now,
                    readSession,
                    latestCompletionFor,
                    putCompletion: receipt => {
                        completions.set(receipt.requestId, receipt)
                    },
                    getCompletion: id => completions.get(id) ?? null,
                }),
            )
            if (receipt.state === 'acknowledged' || receipt.state === 'unavailable') return receipt
            return deliverOnce(coordinationKey, receipt, () => deliverReservedCompletion(receipt, authority, now, next => run(() => {
                const existing = completions.get(next.requestId)
                if (!existing || !sameChat(existing.chat, next.chat) || existing.fingerprint !== next.fingerprint) throw new DesktopForemanIntakeRefusal(409, 'This intake completion identity changed.')
                if (existing.state === 'acknowledged') return existing
                completions.set(next.requestId, next)
                return next
            })))
        },
        lookupCompletion(chat, requestId) {
            return run(async () => {
                const receipt = completions.get(requestId)
                return receipt && sameChat(receipt.chat, chat) ? receipt : null
            })
        },
    }
}

async function reserveIntakeCompletion(args: {
    input: DesktopForemanIntakeCompleteInput
    authorityAvailable: boolean
    now: () => Date
    readSession: (chat: DesktopForemanChatRef) => Promise<DesktopForemanIntakeSession> | DesktopForemanIntakeSession
    latestCompletionFor: (chat: DesktopForemanChatRef) => Promise<DesktopForemanIntakeCompletionReceipt | null> | DesktopForemanIntakeCompletionReceipt | null
    putCompletion: (receipt: DesktopForemanIntakeCompletionReceipt) => Promise<void> | void
    getCompletion: (requestId: string) => Promise<DesktopForemanIntakeCompletionReceipt | null> | DesktopForemanIntakeCompletionReceipt | null
}): Promise<DesktopForemanIntakeCompletionReceipt> {
    const { input, authorityAvailable, now } = args
    const fingerprint = fingerprintIntakeAnswers(input.answers, input.chat, input.requestId)
    const existing = await args.getCompletion(input.requestId)
    if (existing) {
        if (!sameChat(existing.chat, input.chat) || existing.fingerprint !== fingerprint) {
            throw new DesktopForemanIntakeRefusal(409, 'That intake completion request was already used for different answers.')
        }
        if (existing.state === 'acknowledged') return existing
    }

    const session = await args.readSession(input.chat)
    const latest = await args.latestCompletionFor(input.chat)
    if (latest && latest.requestId !== input.requestId && activeCompletion(latest)) {
        throw new DesktopForemanIntakeConflictError(viewOf(session, latest), 'This chat already has a reserved intake completion. Retry its original request.')
    }
    if (existing && activeCompletion(existing)) return existing
    if (input.expectedRevision !== session.revision) {
        throw new DesktopForemanIntakeConflictError(viewOf(session, latest), 'This intake draft changed before it could be submitted.')
    }

    const steps = intakeSteps(session.knownFirstName, session.draft.websiteSkipped)
    if (!steps.every(step => stepAnswered(step, session.draft))) throw new DesktopForemanIntakeRefusal(422, 'Answer each intake question before continuing.')
    const answers = desktopForemanIntakeAnswersSchema.parse(toIntake(session.draft, session.knownFirstName, session.decidedIndustry))
    if (fingerprintIntakeAnswers(answers, input.chat, input.requestId) !== fingerprint) {
        throw new DesktopForemanIntakeConflictError(viewOf(session, latest), 'These answers do not match the saved intake draft. Save and review the current answers first.')
    }
    const createdAt = existing?.createdAt ?? now().toISOString()
    const reserved = desktopForemanIntakeCompletionReceiptSchema.parse({
        requestId: input.requestId,
        chat: input.chat,
        fingerprint,
        state: authorityAvailable ? 'pending' : 'unavailable',
        answers,
        followUp: null,
        error: authorityAvailable ? null : 'Foreman intake completion is not wired yet.',
        missingAuthority: authorityAvailable ? null : DESKTOP_FOREMAN_INTAKE_MISSING.completion,
        createdAt,
        updatedAt: now().toISOString(),
    })
    await args.putCompletion(reserved)
    return reserved
}

async function deliverReservedCompletion(
    reserved: DesktopForemanIntakeCompletionReceipt,
    authority: DesktopForemanIntakeCompletionAuthority | null,
    now: () => Date,
    settle: (receipt: DesktopForemanIntakeCompletionReceipt) => Promise<DesktopForemanIntakeCompletionReceipt>,
): Promise<DesktopForemanIntakeCompletionReceipt> {
    try {
        if (!authority) throw new Error('Completion authority is unavailable during recovery')
        const identity = { chat: reserved.chat, requestId: reserved.requestId, fingerprint: reserved.fingerprint }
        const recovered = await authority.lookup(identity)
        if (recovered && (!sameChat(recovered.chat, reserved.chat) || recovered.requestId !== reserved.requestId || recovered.fingerprint !== reserved.fingerprint)) throw new Error('Intake authority identity mismatch')
        const delivered = recovered ?? await authority.deliver({ ...identity, answers: reserved.answers })
        const acknowledged = desktopForemanIntakeCompletionReceiptSchema.parse({
            ...reserved,
            state: 'acknowledged',
            followUp: {
                conversationId: delivered.conversationId,
                runId: delivered.runId,
                industry: delivered.industry,
            },
            error: null,
            missingAuthority: null,
            updatedAt: now().toISOString(),
        })
        return await settle(acknowledged)
    } catch {
        // The effect or even its final receipt may have succeeded. Preserve the reserved identity;
        // raw provider/error bodies must never leak into durable public receipts.
        return settle(desktopForemanIntakeCompletionReceiptSchema.parse({
            ...reserved,
            state: 'uncertain',
            followUp: null,
            error: 'Foreman intake delivery is not confirmed. Retry this same intake before changing answers.',
            missingAuthority: null,
            updatedAt: now().toISOString(),
        }))
    }
}

/** SQLite-backed store. Root must apply ensureDesktopForemanIntakeSchema before first use. */
export function createSqliteDesktopForemanIntakeStore(
    db: Client,
    options?: { knownFirstName?: string | null; now?: () => Date; schemaReady?: boolean },
): DesktopForemanIntakeStore {
    const stamp = () => (options?.now ?? (() => new Date()))().toISOString()
    // Production root applies migration 30 once while opening its database. Standalone fixtures
    // retain additive setup, coordinated with transactions across all local Client handles.
    let ready: Promise<void> | null = options?.schemaReady ? Promise.resolve() : null
    const ensure = () => (ready ??= serializeSqliteIntakeWrite(() => ensureDesktopForemanIntakeSchema(db)))

    const write = <T>(work: (tx: Transaction) => Promise<T>): Promise<T> => {
        return serializeSqliteIntakeWrite(async () => {
            const tx = await db.transaction('write')
            try { const value = await work(tx); await tx.commit(); return value }
            catch (error) { await tx.rollback().catch(() => {}); throw error }
            finally { tx.close() }
        })
    }

    const readSession = async (chat: DesktopForemanChatRef, executor: SqliteExecutor = db): Promise<DesktopForemanIntakeSession> => {
        const found = await executor.execute({
            sql: 'SELECT revision, step_index, draft, decided_industry, known_first_name, updated_at FROM desktop_foreman_intake_sessions WHERE workspace_id=? AND chat_id=?',
            args: [chat.workspaceId, chat.chatId],
        })
        const row = found.rows[0]
        if (!row) return emptySession(chat, options?.knownFirstName ?? null, stamp())
        return desktopForemanIntakeSessionSchema.parse({
            chat,
            revision: Number(row.revision),
            stepIndex: Number(row.step_index),
            draft: desktopForemanIntakeDraftSchema.parse(JSON.parse(String(row.draft))),
            decidedIndustry: row.decided_industry == null ? null : String(row.decided_industry),
            knownFirstName: row.known_first_name == null ? null : String(row.known_first_name),
            updatedAt: String(row.updated_at),
        })
    }

    const readCompletion = async (requestId: string, executor: SqliteExecutor = db): Promise<DesktopForemanIntakeCompletionReceipt | null> => {
        const found = await executor.execute({ sql: 'SELECT request_id,workspace_id,chat_id,fingerprint,state,body,created_at,updated_at FROM desktop_foreman_intake_completions WHERE request_id=?', args: [requestId] })
        const row = found.rows[0]
        return row ? completionFromRow(row) : null
    }

    const latestCompletionFor = async (chat: DesktopForemanChatRef, executor: SqliteExecutor = db): Promise<DesktopForemanIntakeCompletionReceipt | null> => {
        const found = await executor.execute({
            sql: `SELECT request_id,workspace_id,chat_id,fingerprint,state,body,created_at,updated_at FROM desktop_foreman_intake_completions WHERE workspace_id=? AND chat_id=?
                  ORDER BY CASE state WHEN 'acknowledged' THEN 2 WHEN 'pending' THEN 1 WHEN 'uncertain' THEN 1 WHEN 'failed' THEN 1 ELSE 0 END DESC, updated_at DESC, rowid DESC LIMIT 1`,
            args: [chat.workspaceId, chat.chatId],
        })
        const row = found.rows[0]
        return row ? completionFromRow(row) : null
    }

    const putCompletion = async (receipt: DesktopForemanIntakeCompletionReceipt, executor: SqliteExecutor) => {
        const result = await executor.execute({
            sql: `INSERT INTO desktop_foreman_intake_completions(request_id, workspace_id, chat_id, fingerprint, state, body, created_at, updated_at)
                  VALUES(?,?,?,?,?,?,?,?)
                  ON CONFLICT(request_id) DO UPDATE SET state=excluded.state, body=excluded.body, updated_at=excluded.updated_at
                  WHERE desktop_foreman_intake_completions.workspace_id=excluded.workspace_id
                    AND desktop_foreman_intake_completions.chat_id=excluded.chat_id
                    AND desktop_foreman_intake_completions.fingerprint=excluded.fingerprint
                    AND desktop_foreman_intake_completions.state<>'acknowledged'`,
            args: [
                receipt.requestId,
                receipt.chat.workspaceId,
                receipt.chat.chatId,
                receipt.fingerprint,
                receipt.state,
                JSON.stringify(receipt),
                receipt.createdAt,
                receipt.updatedAt,
            ],
        })
        if (result.rowsAffected !== 1) throw new DesktopForemanIntakeRefusal(503, 'The intake completion changed before its receipt could be saved.')
    }

    return {
        async read(chat) {
            await ensure()
            return viewOf(await readSession(chat), await latestCompletionFor(chat))
        },
        async save(input) {
            await ensure()
            input = desktopForemanIntakeSaveInputSchema.parse(input)
            const parsed = desktopForemanIntakeDraftSchema.parse(input.draft)
            const hash = fingerprintSave({ ...input, draft: parsed })
            return write(async tx => {
                const currentFound = await tx.execute({
                    sql: 'SELECT revision, step_index, draft, decided_industry, known_first_name, updated_at FROM desktop_foreman_intake_sessions WHERE workspace_id=? AND chat_id=?',
                    args: [input.chat.workspaceId, input.chat.chatId],
                })
                const current = currentFound.rows[0]
                    ? desktopForemanIntakeSessionSchema.parse({
                          chat: input.chat,
                          revision: Number(currentFound.rows[0].revision),
                          stepIndex: Number(currentFound.rows[0].step_index),
                          draft: desktopForemanIntakeDraftSchema.parse(JSON.parse(String(currentFound.rows[0].draft))),
                          decidedIndustry: currentFound.rows[0].decided_industry == null ? null : String(currentFound.rows[0].decided_industry),
                          knownFirstName: currentFound.rows[0].known_first_name == null ? null : String(currentFound.rows[0].known_first_name),
                          updatedAt: String(currentFound.rows[0].updated_at),
                      })
                    : emptySession(input.chat, options?.knownFirstName ?? null, stamp())

                const prior = await tx.execute({
                    sql: 'SELECT workspace_id, chat_id, fingerprint, result_revision FROM desktop_foreman_intake_writes WHERE request_id=?',
                    args: [input.requestId],
                })
                if (prior.rows[0]) {
                    const row = prior.rows[0]
                    if (String(row.workspace_id) !== input.chat.workspaceId || String(row.chat_id) !== input.chat.chatId || String(row.fingerprint) !== hash) {
                        throw new DesktopForemanIntakeConflictError(
                            viewOf(current, await latestCompletionFor(input.chat, tx)),
                            'That intake save request was already used for a different change.',
                        )
                    }
                    return viewOf(current, await latestCompletionFor(input.chat, tx))
                }

                if (input.baseRevision !== current.revision) {
                    throw new DesktopForemanIntakeConflictError(viewOf(current, await latestCompletionFor(input.chat, tx)))
                }

                const completed = await latestCompletionFor(input.chat, tx)
                if (completed && activeCompletion(completed)) {
                    throw new DesktopForemanIntakeConflictError(viewOf(current, completed), 'This intake already has a reserved completion. Resolve the same request before editing answers.')
                }

                const now = stamp()
                const next = desktopForemanIntakeSessionSchema.parse({
                    chat: input.chat,
                    revision: current.revision + 1,
                    stepIndex: input.stepIndex,
                    draft: parsed,
                    decidedIndustry: input.decidedIndustry,
                    knownFirstName: input.knownFirstName,
                    updatedAt: now,
                })
                await tx.execute({
                    sql: `INSERT INTO desktop_foreman_intake_sessions(workspace_id, chat_id, revision, step_index, draft, decided_industry, known_first_name, updated_at)
                          VALUES(?,?,?,?,?,?,?,?)
                          ON CONFLICT(workspace_id, chat_id) DO UPDATE SET
                            revision=excluded.revision,
                            step_index=excluded.step_index,
                            draft=excluded.draft,
                            decided_industry=excluded.decided_industry,
                            known_first_name=excluded.known_first_name,
                            updated_at=excluded.updated_at`,
                    args: [
                        next.chat.workspaceId,
                        next.chat.chatId,
                        next.revision,
                        next.stepIndex,
                        JSON.stringify(next.draft),
                        next.decidedIndustry,
                        next.knownFirstName,
                        next.updatedAt,
                    ],
                })
                await tx.execute({
                    sql: 'INSERT INTO desktop_foreman_intake_writes(request_id, workspace_id, chat_id, fingerprint, result_revision, created_at) VALUES(?,?,?,?,?,?)',
                    args: [input.requestId, input.chat.workspaceId, input.chat.chatId, hash, next.revision, now],
                })
                return viewOf(next, completed)
            })
        },
        async complete(input, authority, clock = () => new Date()) {
            await ensure()
            input = desktopForemanIntakeCompleteInputSchema.parse(input)
            // Commit a chat-scoped reservation before any authority or network operation. The
            // transaction sees the same session and receipt snapshot; a fresh nonce cannot bypass it.
            const receipt = await write(tx => reserveIntakeCompletion({
                input,
                authorityAvailable: !!authority,
                now: clock,
                readSession: chat => readSession(chat, tx),
                latestCompletionFor: chat => latestCompletionFor(chat, tx),
                putCompletion: receipt => putCompletion(receipt, tx),
                getCompletion: id => readCompletion(id, tx),
            }))
            if (receipt.state === 'acknowledged' || receipt.state === 'unavailable') return receipt
            return deliverOnce(db, receipt, () => deliverReservedCompletion(receipt, authority, clock, next => write(async tx => {
                const existing = await readCompletion(next.requestId, tx)
                if (!existing || !sameChat(existing.chat, next.chat) || existing.fingerprint !== next.fingerprint) throw new DesktopForemanIntakeRefusal(409, 'This intake completion identity changed.')
                if (existing.state === 'acknowledged') return existing
                await putCompletion(next, tx)
                return (await readCompletion(next.requestId, tx))!
            })))
        },
        async lookupCompletion(chat, requestId) {
            await ensure()
            const receipt = await readCompletion(requestId)
            return receipt && sameChat(receipt.chat, chat) ? receipt : null
        },
    }
}
