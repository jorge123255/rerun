import { randomUUID } from 'node:crypto'
import type { Client, InStatement, Row } from '@libsql/client'
import { FOREMAN_AGENT_ID, type ForemanAlternateRequest } from '@rerun/contracts'
import { withAgentLock } from '../../agents/lock.js'
import { desktopApp } from '../../desktop/policy.js'
import { HttpError } from '../../lib/errors.js'
import { newId, nowIso } from '../../lib/ids.js'
import { claimSession, releaseSession, sessionClaim } from '../../runtime/run-control.js'
import type { MessageRow } from '../schema.js'
import { getSystemDb } from '../systemDb.js'
import { readForemanReplySnapshot } from './foreman-reply-sources.js'
import { copiedMessageStatements } from './messages.js'

type PreparationGuard = { authorize(): Promise<void>; assertCurrent(): void }

const conflict = () => new HttpError(409, 'This saved Chief of Staff reply cannot be used to prepare an alternate.')

async function readReservation(reader: Pick<Client, 'execute'>, input: ForemanAlternateRequest) {
    const { rows: [saved] } = await reader.execute({
        sql: `SELECT alternate.*, session.id AS owned_session, user_message.id AS copied_user
              FROM desktop_foreman_alternate_sessions AS alternate
              LEFT JOIN sessions AS session ON session.id = alternate.session_id
                AND session.agent_id = ? AND session.origin_agent_id = session.agent_id
                AND session.origin_session_id = alternate.source_session_id
                AND session.source = 'dashboard' AND session.status = 'open'
              LEFT JOIN messages AS user_message ON user_message.id = alternate.user_message_id
                AND user_message.session_id = session.id AND user_message.role = 'user'
              WHERE alternate.request_id = ?`,
        args: [FOREMAN_AGENT_ID, input.requestId],
    })
    if (!saved) return null
    if (saved.workspace_id !== input.workspaceId || saved.chat_id !== input.chatId ||
        saved.source_session_id !== input.sessionId || saved.source_message_id !== input.assistantMessageId ||
        saved.transcript_revision !== input.transcriptRevision || !saved.owned_session || !saved.copied_user) throw conflict()
    return {
        requestId: input.requestId,
        sessionId: String(saved.session_id),
        runId: String(saved.run_id),
        userMessageId: String(saved.user_message_id),
        source: {
            workspaceId: input.workspaceId, chatId: input.chatId, sessionId: input.sessionId,
            assistantMessageId: input.assistantMessageId, transcriptRevision: input.transcriptRevision,
            sourceRunId: String(saved.source_run_id), precedingUserMessageId: String(saved.source_user_message_id),
            replyDigest: String(saved.reply_digest),
        },
    }
}

function asMessage(row: Row, id: string, sessionId: string): MessageRow {
    return {
        id, sessionId, role: String(row.role), contentJson: String(row.content_json),
        toolCallsJson: typeof row.tool_calls_json === 'string' ? row.tool_calls_json : null,
        sourcesJson: typeof row.sources_json === 'string' ? row.sources_json : null,
        createdAt: String(row.created_at),
        authorId: typeof row.author_id === 'string' ? row.author_id : null,
        authorName: typeof row.author_name === 'string' ? row.author_name : null,
    }
}

async function assertForemanAlternateIdle(reader: Pick<Client, 'execute'>, input: ForemanAlternateRequest) {
    const { rows: running } = await reader.execute({
        sql: `SELECT id FROM runs WHERE agent_id = ? AND status = 'running' AND (
                  session_id = ? OR session_id IN (
                      SELECT session_id FROM desktop_foreman_alternate_sessions
                      WHERE workspace_id = ? AND chat_id = ? AND source_session_id = ?
                  )
              ) LIMIT 1`,
        args: [FOREMAN_AGENT_ID, input.sessionId, input.workspaceId, input.chatId, input.sessionId],
    })
    const { rows: alternates } = await reader.execute({
        sql: `SELECT session_id FROM desktop_foreman_alternate_sessions
              WHERE workspace_id = ? AND chat_id = ? AND source_session_id = ?`,
        args: [input.workspaceId, input.chatId, input.sessionId],
    })
    if (running.length || sessionClaim(input.sessionId) || alternates.some(row => sessionClaim(String(row.session_id)))) {
        throw conflict()
    }
}

// A lookup acknowledges the same preparation after an uncertain response, without preparing or
// starting any work. The app boundary must authenticate and recheck the current owner first.
export async function lookupForemanAlternate(input: ForemanAlternateRequest) {
    if (!desktopApp()) return null
    const { client } = await getSystemDb(FOREMAN_AGENT_ID)
    return readReservation(client, input)
}

// Persist the independent session, copied prefix and stable future run identity together.
// Dispatch and human-decision/build admission belong to the authenticated app/engine bridge.
// The reserved run ID has no live run row and no tool authority.
export async function prepareForemanAlternate(input: ForemanAlternateRequest, guard?: PreparationGuard) {
    if (!desktopApp()) throw conflict()
    return withAgentLock(FOREMAN_AGENT_ID, async () => {
        await guard?.authorize()
        guard?.assertCurrent()
        const { client } = await getSystemDb(FOREMAN_AGENT_ID)
        const tx = await client.transaction('write')
        try {
            const saved = await readReservation(tx, input)
            if (saved) return saved
            const target = {
                workspaceId: input.workspaceId, chatId: input.chatId,
                sessionId: input.sessionId, assistantMessageId: input.assistantMessageId,
            }
            const snapshot = await readForemanReplySnapshot(tx, target)
            if (!snapshot || snapshot.proof.transcriptRevision !== input.transcriptRevision) throw conflict()
            const { proof, rows } = snapshot
            const anchor = rows.findIndex(row => row.id === proof.precedingUserMessageId)
            const reply = rows.findIndex(row => row.id === proof.assistantMessageId)
            if (anchor < 0 || anchor >= reply) throw conflict()

            await assertForemanAlternateIdle(tx, input)
            const sessionId = randomUUID(), runId = randomUUID(), now = nowIso()
            const prefix = rows.slice(0, anchor + 1).map(row => asMessage(row, newId(), sessionId))
            const userMessageId = prefix[anchor]!.id
            const statements: InStatement[] = [
                {
                    sql: `INSERT INTO sessions (id, agent_id, title, source, origin_agent_id, origin_session_id, created_at, updated_at)
                          SELECT ?, agent_id, title, source, agent_id, id, ?, ? FROM sessions WHERE id = ?`,
                    args: [sessionId, now, now, input.sessionId],
                },
                {
                    sql: `INSERT INTO desktop_foreman_alternate_sessions
                          (request_id, workspace_id, chat_id, source_session_id, source_message_id, source_run_id,
                           source_user_message_id, reply_digest, transcript_revision, session_id, run_id, user_message_id)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                    args: [input.requestId, input.workspaceId, input.chatId, input.sessionId, proof.assistantMessageId,
                        proof.sourceRunId, proof.precedingUserMessageId, proof.replyDigest, proof.transcriptRevision,
                        sessionId, runId, userMessageId],
                },
            ]
            guard?.assertCurrent()
            await tx.batch([...statements, ...prefix.flatMap(copiedMessageStatements)])
            guard?.assertCurrent()
            await tx.commit()
            return { requestId: input.requestId, sessionId, runId, userMessageId, source: proof }
        } finally { tx.close() }
    })
}

// The route holds the same agent lock as ordinary Chief of Staff admission. Revalidate the
// original transcript inside the write transaction that turns the reserved ID into a run.
export async function reserveForemanAlternateRun(input: ForemanAlternateRequest, assertCurrent: () => void) {
    const { client } = await getSystemDb(FOREMAN_AGENT_ID)
    const tx = await client.transaction('write')
    let claimedRun: string | undefined
    try {
        const alternate = await readReservation(tx, input)
        if (!alternate) throw conflict()
        const current = await readForemanReplySnapshot(tx, {
            workspaceId: input.workspaceId, chatId: input.chatId, sessionId: input.sessionId, assistantMessageId: input.assistantMessageId,
        })
        if (!current || current.proof.transcriptRevision !== input.transcriptRevision
            || current.proof.sourceRunId !== alternate.source.sourceRunId || current.proof.replyDigest !== alternate.source.replyDigest
            || current.proof.precedingUserMessageId !== alternate.source.precedingUserMessageId) throw conflict()
        await assertForemanAlternateIdle(tx, input)
        const { rows: [savedUser] } = await tx.execute({
            sql: "SELECT * FROM messages WHERE id = ? AND session_id = ? AND role = 'user'",
            args: [alternate.userMessageId, alternate.sessionId],
        })
        if (!savedUser) throw conflict()
        assertCurrent()
        if (claimSession(alternate.sessionId, alternate.runId)) throw conflict()
        claimedRun = alternate.runId
        await tx.execute({ sql: 'INSERT INTO runs (id, agent_id, session_id, started_at) VALUES (?,?,?,?)',
            args: [alternate.runId, FOREMAN_AGENT_ID, alternate.sessionId, nowIso()] })
        assertCurrent()
        await tx.commit()
        return { alternate, user: asMessage(savedUser, alternate.userMessageId, alternate.sessionId) }
    } catch (error) {
        if (claimedRun) releaseSession(claimedRun)
        throw error
    } finally { tx.close() }
}
