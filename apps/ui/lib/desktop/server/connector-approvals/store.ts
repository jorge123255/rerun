import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import type { DesktopConnectorActionKind, DesktopConnectorApprovalDecision, DesktopConnectorApprovalView } from '@rerun/contracts'
import { redactHistoricalText } from '@/components/desktop/tool-presentations/redact'

const MAX_PENDING = 20
const PREVIEW = 600

const WORDS: Record<DesktopConnectorActionKind, string> = {
    delete: 'deletes something', send: 'sends something to other people', share: 'shares something with other people',
    post: 'posts or publishes something', pay: 'pays or moves money', credential: 'changes a password or other credential',
}

/** Stable across key order, so the same call asked twice is the same request. */
function digestOf(value: unknown): string {
    const ordered = (input: unknown): unknown => Array.isArray(input) ? input.map(ordered)
        : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, ordered((input as Record<string, unknown>)[key])]))
        : input
    return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')
}

export type ConnectorCall = { owner: string; sessionId: string; tool: string; kind: DesktopConnectorActionKind; arguments: Record<string, unknown> }

/**
 * Decides whether a connector call that asks first may run now. `null` lets it run. A string is
 * what the coworker is told instead; the call did not run.
 *
 * An "allow once" is bound to the conversation, the tool and the very arguments that were shown,
 * and is spent by the call it lets through.
 */
export async function admitConnectorCall(db: Client, call: ConnectorCall, now = new Date()): Promise<string | null> {
    const rule = (await db.execute({ sql: "SELECT id FROM desktop_connector_approval_rules WHERE owner=? AND tool=? AND session_id IN ('',?) LIMIT 1", args: [call.owner, call.tool, call.sessionId] })).rows[0]
    if (rule) return null
    const digest = digestOf(call.arguments)
    const tx = await db.transaction('write')
    try {
        const row = (await tx.execute({
            sql: "SELECT id,status FROM desktop_connector_approval_requests WHERE owner=? AND session_id=? AND tool=? AND args_digest=? AND status IN ('pending','allowed','declined') ORDER BY created_at DESC LIMIT 1",
            args: [call.owner, call.sessionId, call.tool, digest],
        })).rows[0]
        let answer: string | null
        if (row?.status === 'allowed') {
            await tx.execute({ sql: "UPDATE desktop_connector_approval_requests SET status='used' WHERE id=? AND status='allowed'", args: [row.id] })
            answer = null
        } else if (row?.status === 'declined') {
            await tx.execute({ sql: "UPDATE desktop_connector_approval_requests SET status='refused' WHERE id=? AND status='declined'", args: [row.id] })
            answer = 'The person declined this action. Do not try it again unless they ask for it.'
        } else if (row) {
            answer = 'This action is still waiting for the person’s answer on the card in this chat. End your turn; do not call it again until they have answered.'
        } else {
            const pending = Number((await tx.execute({ sql: "SELECT COUNT(*) AS n FROM desktop_connector_approval_requests WHERE session_id=? AND status='pending'", args: [call.sessionId] })).rows[0]?.n ?? 0)
            if (pending >= MAX_PENDING) answer = 'Too many actions are already waiting for the person’s answer in this chat. End your turn and let them answer those first.'
            else {
                const text = redactHistoricalText(JSON.stringify(call.arguments), PREVIEW)
                await tx.execute({
                    sql: "INSERT INTO desktop_connector_approval_requests(id,owner,session_id,tool,kind,args_digest,preview,status,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)",
                    args: [randomUUID(), call.owner, call.sessionId, call.tool, call.kind, digest, text, now.toISOString()],
                })
                answer = `Rerun asks the person before a coworker ${WORDS[call.kind]}. This call did not run. A card asking them is now in this chat. `
                    + 'Tell them in one short sentence what you want to do and why, then end your turn. When they allow it, call this tool again with exactly the same arguments.'
            }
        }
        await tx.commit()
        return answer
    } finally { tx.close() }
}

export async function readConnectorApprovals(db: Client, sessionId: string): Promise<DesktopConnectorApprovalView> {
    const pending = (await db.execute({
        sql: "SELECT id,tool,kind,preview,created_at FROM desktop_connector_approval_requests WHERE session_id=? AND status='pending' ORDER BY created_at LIMIT ?", args: [sessionId, MAX_PENDING],
    })).rows.map(row => ({ id: String(row.id), tool: String(row.tool), kind: String(row.kind) as DesktopConnectorActionKind, preview: String(row.preview), createdAt: String(row.created_at) }))
    // The rules that reach this conversation: its own, and the standing ones of the coworkers that asked here.
    const rules = (await db.execute({
        sql: `SELECT id,tool,session_id FROM desktop_connector_approval_rules
              WHERE session_id=? OR (session_id='' AND owner IN (SELECT owner FROM desktop_connector_approval_requests WHERE session_id=?))
              ORDER BY created_at LIMIT 200`, args: [sessionId, sessionId],
    })).rows.map(row => ({ id: String(row.id), tool: String(row.tool), scope: row.session_id === '' ? 'always' as const : 'conversation' as const }))
    return { pending, rules }
}

/** Records the person's answer to one held call. Null when it is not pending in this conversation. */
export async function decideConnectorApproval(db: Client, sessionId: string, id: string, decision: DesktopConnectorApprovalDecision, now = new Date()) {
    const tx = await db.transaction('write')
    try {
        const row = (await tx.execute({ sql: "SELECT owner,tool,kind FROM desktop_connector_approval_requests WHERE id=? AND session_id=? AND status='pending'", args: [id, sessionId] })).rows[0]
        if (!row) { await tx.rollback(); return null }
        await tx.execute({ sql: 'UPDATE desktop_connector_approval_requests SET status=?, decided_at=? WHERE id=?', args: [decision === 'deny' ? 'declined' : 'allowed', now.toISOString(), id] })
        if (decision === 'conversation' || decision === 'always') {
            await tx.execute({
                sql: 'INSERT OR IGNORE INTO desktop_connector_approval_rules(id,owner,tool,session_id,created_at) VALUES(?,?,?,?,?)',
                args: [randomUUID(), row.owner, row.tool, decision === 'always' ? '' : sessionId, now.toISOString()],
            })
        }
        await tx.commit()
        return { tool: String(row.tool), kind: String(row.kind) as DesktopConnectorActionKind, decision }
    } finally { tx.close() }
}

/** Takes back a standing answer that reaches this conversation. */
export async function forgetConnectorRule(db: Client, sessionId: string, ruleId: string): Promise<boolean> {
    const result = await db.execute({
        sql: `DELETE FROM desktop_connector_approval_rules WHERE id=? AND (session_id=? OR (session_id='' AND owner IN (SELECT owner FROM desktop_connector_approval_requests WHERE session_id=?)))`,
        args: [ruleId, sessionId, sessionId],
    })
    return result.rowsAffected === 1
}
