import { createHash } from 'node:crypto'

import type { Client } from '@libsql/client'
import {
    DESKTOP_FOREMAN_INTAKE_MISSING,
    desktopForemanIntakeCompletionReceiptSchema,
    desktopForemanIntakeDraftSchema,
    desktopForemanIntakeSessionSchema,
    desktopForemanIntakeViewSchema,
    EMPTY_DRAFT,
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
    lookupCompletion(requestId: string): Promise<DesktopForemanIntakeCompletionReceipt | null>
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

export function fingerprintIntakeAnswers(answers: DesktopForemanIntakeCompleteInput['answers']): string {
    return createHash('sha256').update(JSON.stringify(['desktop-foreman-intake-complete-v1', answers])).digest('hex')
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
    const keyOf = (chat: DesktopForemanChatRef) => `${chat.workspaceId}::${chat.chatId}`
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
        matches.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
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
                if (completed?.state === 'acknowledged') {
                    throw new DesktopForemanIntakeRefusal(409, 'This Foreman intake is already finished for this chat.')
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
        complete(input, authority, now = () => new Date()) {
            return run(async () =>
                completeIntake({
                    input,
                    authority,
                    now,
                    readSession,
                    latestCompletionFor,
                    putCompletion: receipt => {
                        completions.set(receipt.requestId, receipt)
                    },
                    getCompletion: id => completions.get(id) ?? null,
                }),
            )
        },
        lookupCompletion(requestId) {
            return run(async () => completions.get(requestId) ?? null)
        },
    }
}

async function completeIntake(args: {
    input: DesktopForemanIntakeCompleteInput
    authority: DesktopForemanIntakeCompletionAuthority | null
    now: () => Date
    readSession: (chat: DesktopForemanChatRef) => Promise<DesktopForemanIntakeSession> | DesktopForemanIntakeSession
    latestCompletionFor: (chat: DesktopForemanChatRef) => Promise<DesktopForemanIntakeCompletionReceipt | null> | DesktopForemanIntakeCompletionReceipt | null
    putCompletion: (receipt: DesktopForemanIntakeCompletionReceipt) => Promise<void> | void
    getCompletion: (requestId: string) => Promise<DesktopForemanIntakeCompletionReceipt | null> | DesktopForemanIntakeCompletionReceipt | null
}): Promise<DesktopForemanIntakeCompletionReceipt> {
    const { input, authority, now } = args
    const fingerprint = fingerprintIntakeAnswers(input.answers)
    const existing = await args.getCompletion(input.requestId)
    if (existing) {
        if (!sameChat(existing.chat, input.chat) || existing.fingerprint !== fingerprint) {
            throw new DesktopForemanIntakeRefusal(409, 'That intake completion request was already used for different answers.')
        }
        if (existing.state === 'acknowledged') return existing
        // Lost ACK / pending / failed / previously-unavailable: re-check the same request id (never mint a new one).
    }

    const session = await args.readSession(input.chat)
    if (input.expectedRevision !== session.revision) {
        throw new DesktopForemanIntakeConflictError(viewOf(session, await args.latestCompletionFor(input.chat)), 'This intake draft changed before it could be submitted.')
    }

    const latest = await args.latestCompletionFor(input.chat)
    if (latest && latest.requestId !== input.requestId && latest.state === 'acknowledged') {
        throw new DesktopForemanIntakeRefusal(409, 'This Foreman intake is already finished for this chat.')
    }

    const createdAt = existing?.createdAt ?? now().toISOString()
    if (!authority) {
        const unavailable = desktopForemanIntakeCompletionReceiptSchema.parse({
            requestId: input.requestId,
            chat: input.chat,
            fingerprint,
            state: 'unavailable',
            answers: input.answers,
            followUp: null,
            error: 'Foreman intake completion is not wired yet.',
            missingAuthority: DESKTOP_FOREMAN_INTAKE_MISSING.completion,
            createdAt,
            updatedAt: now().toISOString(),
        })
        await args.putCompletion(unavailable)
        return unavailable
    }

    const lookedUp = await authority.lookup(input.requestId)
    if (lookedUp) {
        if (lookedUp.fingerprint !== fingerprint) {
            throw new DesktopForemanIntakeRefusal(409, 'A different intake completion already used this request.')
        }
        const recovered = desktopForemanIntakeCompletionReceiptSchema.parse({
            requestId: input.requestId,
            chat: input.chat,
            fingerprint,
            state: 'acknowledged',
            answers: input.answers,
            followUp: {
                conversationId: lookedUp.conversationId,
                runId: lookedUp.runId,
                industry: lookedUp.industry,
            },
            error: null,
            missingAuthority: null,
            createdAt,
            updatedAt: now().toISOString(),
        })
        await args.putCompletion(recovered)
        return recovered
    }

    try {
        const delivered = await authority.deliver({
            chat: input.chat,
            requestId: input.requestId,
            fingerprint,
            answers: input.answers,
        })
        const acknowledged = desktopForemanIntakeCompletionReceiptSchema.parse({
            requestId: input.requestId,
            chat: input.chat,
            fingerprint,
            state: 'acknowledged',
            answers: input.answers,
            followUp: {
                conversationId: delivered.conversationId,
                runId: delivered.runId,
                industry: delivered.industry,
            },
            error: null,
            missingAuthority: null,
            createdAt,
            updatedAt: now().toISOString(),
        })
        await args.putCompletion(acknowledged)
        return acknowledged
    } catch (error) {
        const failed = desktopForemanIntakeCompletionReceiptSchema.parse({
            requestId: input.requestId,
            chat: input.chat,
            fingerprint,
            state: 'failed',
            answers: input.answers,
            followUp: null,
            error: error instanceof Error ? error.message : 'We could not save that. Try again.',
            missingAuthority: null,
            createdAt,
            updatedAt: now().toISOString(),
        })
        await args.putCompletion(failed)
        return failed
    }
}

/** SQLite-backed store. Root must apply ensureDesktopForemanIntakeSchema before first use. */
export function createSqliteDesktopForemanIntakeStore(
    db: Client,
    options?: { knownFirstName?: string | null; now?: () => Date },
): DesktopForemanIntakeStore {
    const stamp = () => (options?.now ?? (() => new Date()))().toISOString()
    let ready: Promise<void> | null = null
    const ensure = () => (ready ??= ensureDesktopForemanIntakeSchema(db))

    const readSession = async (chat: DesktopForemanChatRef): Promise<DesktopForemanIntakeSession> => {
        const found = await db.execute({
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

    const readCompletion = async (requestId: string): Promise<DesktopForemanIntakeCompletionReceipt | null> => {
        const found = await db.execute({ sql: 'SELECT body FROM desktop_foreman_intake_completions WHERE request_id=?', args: [requestId] })
        const row = found.rows[0]
        return row ? desktopForemanIntakeCompletionReceiptSchema.parse(JSON.parse(String(row.body))) : null
    }

    const latestCompletionFor = async (chat: DesktopForemanChatRef): Promise<DesktopForemanIntakeCompletionReceipt | null> => {
        const found = await db.execute({
            sql: 'SELECT body FROM desktop_foreman_intake_completions WHERE workspace_id=? AND chat_id=? ORDER BY updated_at DESC LIMIT 1',
            args: [chat.workspaceId, chat.chatId],
        })
        const row = found.rows[0]
        return row ? desktopForemanIntakeCompletionReceiptSchema.parse(JSON.parse(String(row.body))) : null
    }

    const putCompletion = async (receipt: DesktopForemanIntakeCompletionReceipt) => {
        await db.execute({
            sql: `INSERT INTO desktop_foreman_intake_completions(request_id, workspace_id, chat_id, fingerprint, state, body, created_at, updated_at)
                  VALUES(?,?,?,?,?,?,?,?)
                  ON CONFLICT(request_id) DO UPDATE SET state=excluded.state, body=excluded.body, updated_at=excluded.updated_at`,
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
    }

    return {
        async read(chat) {
            await ensure()
            return viewOf(await readSession(chat), await latestCompletionFor(chat))
        },
        async save(input) {
            await ensure()
            const parsed = desktopForemanIntakeDraftSchema.parse(input.draft)
            const hash = fingerprintSave({ ...input, draft: parsed })
            const tx = await db.transaction('write')
            try {
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
                        await tx.commit()
                        throw new DesktopForemanIntakeConflictError(
                            viewOf(current, await latestCompletionFor(input.chat)),
                            'That intake save request was already used for a different change.',
                        )
                    }
                    await tx.commit()
                    return viewOf(await readSession(input.chat), await latestCompletionFor(input.chat))
                }

                if (input.baseRevision !== current.revision) {
                    await tx.commit()
                    throw new DesktopForemanIntakeConflictError(viewOf(current, await latestCompletionFor(input.chat)))
                }

                const completed = await latestCompletionFor(input.chat)
                if (completed?.state === 'acknowledged') {
                    await tx.commit()
                    throw new DesktopForemanIntakeRefusal(409, 'This Foreman intake is already finished for this chat.')
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
                await tx.commit()
                return viewOf(next, completed)
            } catch (error) {
                await tx.rollback().catch(() => {})
                throw error
            } finally {
                tx.close()
            }
        },
        async complete(input, authority, clock = () => new Date()) {
            await ensure()
            return completeIntake({
                input,
                authority,
                now: clock,
                readSession: chat => readSession(chat),
                latestCompletionFor: chat => latestCompletionFor(chat),
                putCompletion,
                getCompletion: id => readCompletion(id),
            })
        },
        async lookupCompletion(requestId) {
            await ensure()
            return readCompletion(requestId)
        },
    }
}
