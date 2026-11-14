import type { DesktopDocumentSendSelection } from '@rerun/contracts'
import { type DesktopCoworkerMentionFields } from '@rerun/contracts'
import 'server-only'
import { createHash } from 'node:crypto'
import { desktopAttachmentFingerprintOf, desktopAttachmentSelectionsOf, type DesktopAttachmentFields } from '@rerun/contracts'
import type { Client, Row } from '@libsql/client'
import { listRuns } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'
import type { DesktopModelPick } from '../chat-model'
import { desktopChatTitle } from '../chat-content'
import { DesktopHttpError } from './auth'
import { GENERAL_SESSION_TITLE, generalTabUid, openingMessage } from '../general-threads'
import { createDesktopSession, type DesktopAgent } from './store'

export type DesktopPhoneFirstTurn = { sessionId: string; runId: string }

export const desktopPhoneTabUid = (sessionId: string) => 'mac-phone:' + sessionId

type StartInput = DesktopAttachmentFields & DesktopCoworkerMentionFields & { text: string; modelChoice?: DesktopModelPick; documents?: DesktopDocumentSendSelection }

function fingerprint(input: StartInput) {
    // A single path hashes exactly like the original receipt; two or more bind their order.
    return createHash('sha256').update(JSON.stringify([input.text, desktopAttachmentFingerprintOf(desktopAttachmentSelectionsOf(input)), input.modelChoice?.connectionId, input.modelChoice?.model, ...(input.coworkerMentions?.length ? [['coworkerMentions', input.coworkerMentions]] : []), ...(input.documents ? [['documents', input.documents]] : [])])).digest('hex')
}

// Keep a tab's session ID stable even if a rejected reservation is released and recreated.
// The run ID includes the input, so the engine can reject a competing different first message.
function tabUuid(parts: string[]) {
    const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex')
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
}

function validate(row: Row, hash: string) {
    if (row.input_hash !== hash) throw new DesktopHttpError(409, 'This tab already started with a different message. Retry that message, or close this tab and start a new chat.')
    return row
}

const tabSource = `FROM desktop_agent_tabs a JOIN json_each(a.layout, '$.tabs') tab
                   WHERE a.agent_id = :agent AND json_extract(tab.value,'$.uid') = :uid`

export async function readTabStart(db: Client, agent: DesktopAgent, uid: string, input: StartInput): Promise<{ row: Row | null; matches: boolean }> {
    const previous = await db.execute({ sql: 'SELECT * FROM desktop_tab_starts WHERE agent_id = ? AND uid = ?', args: [agent.id, uid] })
    const row = previous.rows[0]
    if (!row) return { row: null, matches: true }
    return { row, matches: row.input_hash === fingerprint(input) }
}

export async function existingTabStart(db: Client, agent: DesktopAgent, uid: string, input: StartInput, phone?: DesktopPhoneFirstTurn) {
    if (phone) {
        const { row } = await readTabStart(db, agent, uid, input)
        return row ? validate(row, fingerprint(input)) : null
    }
    if (uid.startsWith(desktopPhoneTabUid(''))) throw new DesktopHttpError(404, 'Open this coworker’s new conversation before sending.')
    const args = { agent: agent.id, uid }
    const [open, previous] = await db.batch([
        { sql: `SELECT json_extract(tab.value,'$.id') AS id ${tabSource}`, args },
        { sql: 'SELECT * FROM desktop_tab_starts WHERE agent_id = :agent AND uid = :uid', args },
    ], 'read')
    if (!open.rows.length) throw new DesktopHttpError(404, 'Open this coworker’s new conversation before sending.')
    if (previous.rows.length) return validate(previous.rows[0], fingerprint(input))
    if (open.rows[0].id !== null) throw new DesktopHttpError(409, 'This is no longer a new conversation.')
    return null
}

export async function reserveTabStart(db: Client, agent: DesktopAgent, uid: string, input: StartInput, launch: string, phone?: DesktopPhoneFirstTurn) {
    const hash = fingerprint(input)
    const [, current] = await db.batch([{
        sql: `INSERT INTO desktop_tab_starts (agent_id, uid, input_hash, engine_session_id, run_id, title, model_choice, launch_nonce)
              SELECT :agent,:uid,:hash,:engine,:run,:title,:model,:launch ${phone ? 'WHERE EXISTS (SELECT 1 FROM desktop_agents WHERE id = :agent AND workspace_id = 1)' : tabSource + " AND json_extract(tab.value,'$.id') IS NULL"}
              ON CONFLICT(agent_id, uid) DO NOTHING`,
        args: { agent: agent.id, uid, hash, engine: phone?.sessionId ?? tabUuid([agent.id,uid]), run: phone?.runId ?? tabUuid([agent.id,uid,hash]), title: desktopChatTitle(input), model: JSON.stringify(input.modelChoice ?? null), launch },
    }, {
        sql: 'SELECT * FROM desktop_tab_starts WHERE agent_id = ? AND uid = ?', args: [agent.id, uid],
    }], 'write')
    if (!current.rows.length) throw new DesktopHttpError(404, 'The new conversation tab has closed.')
    return validate(current.rows[0], hash)
}

export async function recoverTabSession(db: Client, conn: EngineConnection, agent: DesktopAgent, row: Row) {
    const engineSessionId = String(row.engine_session_id)
    // When the tab's first answer was accepted, a retry needs neither a file read nor a model call.
    const bound = await db.execute({ sql: 'SELECT id FROM desktop_sessions WHERE agent_id = ? AND engine_session_id = ?', args: [agent.id, engineSessionId] })
    if (bound.rows[0]) return String(bound.rows[0].id)
    const runs = await listRuns(conn, agent.engineAgentId, { sessionId: engineSessionId, limit: 1 })
    if (!runs.some(run => run.id === row.run_id && run.sessionId === engineSessionId)) return null
    const general = String(row.uid) === generalTabUid(agent.id)
    const saved = await createDesktopSession(db, {
        id: String(row.uid) === desktopPhoneTabUid(engineSessionId) ? engineSessionId : undefined,
        agentId: agent.id, engineSessionId,
        title: general ? GENERAL_SESSION_TITLE : String(row.title),
        model: JSON.parse(String(row.model_choice)),
        kind: general ? 'general' : 'thread',
        firstMessage: general ? null : openingMessage(String(row.title)),
    })
    return saved.id
}

// The engine may have accepted the turn immediately before the app quit. Recover its mapping even
// when the sender never received headers. Only uids in the saved layout appear as tabs.
export async function discardTabStart(db: Client, row: Row) {
    await db.execute({ sql: `DELETE FROM desktop_tab_starts WHERE run_id=? AND NOT EXISTS
        (SELECT 1 FROM desktop_sessions WHERE engine_session_id=desktop_tab_starts.engine_session_id AND agent_id=desktop_tab_starts.agent_id)`, args: [row.run_id] })
}

export async function recoverPendingTabSessions(db: Client, conn: EngineConnection, agent: DesktopAgent, launch: string) {
    const pending = await db.execute({
        sql: `SELECT t.* FROM desktop_tab_starts t LEFT JOIN desktop_sessions s ON s.engine_session_id = t.engine_session_id AND s.agent_id = t.agent_id
              WHERE t.agent_id = ? AND s.id IS NULL AND (t.launch_nonce != ? OR EXISTS
              (SELECT 1 FROM desktop_agent_tabs a, json_each(a.layout,'$.tabs') j WHERE a.agent_id=t.agent_id AND json_extract(j.value,'$.uid')=t.uid))`, args: [agent.id,launch],
    })
    for (const row of pending.rows) {
        const recovered = await recoverTabSession(db, conn, agent, row)
        // The previous engine and UI have shut down. No writer from that launch can still claim it.
        if (!recovered && row.launch_nonce !== launch) await discardTabStart(db, row)
    }
}
