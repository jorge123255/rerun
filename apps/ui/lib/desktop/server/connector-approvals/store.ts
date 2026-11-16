import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import type { DesktopActivityDecision, DesktopConnectorActionKind, DesktopConnectorApprovalDecision, DesktopConnectorApprovalView, DesktopConnectorPreview } from '@rerun/contracts'
import { redactHistoricalText } from '@/components/desktop/tool-presentations/redact'

const MAX_PENDING = 20
const PREVIEW = 3800
const NAME_KEY = /^(?:tool_?slug|tool_?name|tool|slug|action|name)$/i
const LONG_KEY = /^(?:body|message|text|content|html_?body|description|comment|note)$/i

/**
 * What the card shows for a held call: each inner call's fields, or the code a sandbox would run,
 * with credentials struck out and long values cut so the whole always fits and stays readable.
 */
export function connectorPreview(args: Record<string, unknown>): string {
    const build = (scale: number): DesktopConnectorPreview => {
        const text = (value: unknown, limit: number) => redactHistoricalText(typeof value === 'string' ? value : JSON.stringify(value) ?? '', Math.max(40, Math.floor(limit / scale)))
        const fields = (source: unknown) => Object.entries(source && typeof source === 'object' && !Array.isArray(source) ? source : {})
            .filter(([, value]) => value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0))
            .slice(0, 14).map(([key, value]) => [key.slice(0, 80), text(value, LONG_KEY.test(key) ? 1200 : 300)] as [string, string])
        if (Array.isArray(args.code)) return { v: 1, items: args.code.slice(0, 6).map(code => ({ code: text(code, 1800) })) }
        if (Array.isArray(args.tools)) return { v: 1, items: args.tools.slice(0, 6).map(entry => {
            const row = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
            const name = Object.entries(row).find(([key, value]) => NAME_KEY.test(key) && typeof value === 'string')
            const given = ['arguments', 'args', 'params', 'parameters', 'input'].map(key => row[key]).find(value => value && typeof value === 'object')
            return { ...(name ? { tool: String(name[1]).slice(0, 200) } : {}), fields: fields(given ?? Object.fromEntries(Object.entries(row).filter(([key]) => key !== name?.[0]))) }
        }) }
        return { v: 1, items: [{ fields: fields(args) }] }
    }
    for (const scale of [1, 2, 4, 8, 16]) { const made = JSON.stringify(build(scale)); if (made.length <= PREVIEW) return made }
    return JSON.stringify({ v: 1, items: [] } satisfies DesktopConnectorPreview)
}

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
// A held call already has its card. A coworker that also asks through another tool (an approval request, a
// sign-in request, a question) puts a second, misleading card in the chat.
const NO_SECOND_ASK = 'The card is the only request needed: do not ask through any other tool, and do not request a sign-in, since the app is already signed in.'

export async function admitConnectorCall(db: Client, call: ConnectorCall, now = new Date()): Promise<string | null> {
    return (await decideConnectorCall(db, call, now)).answer
}

/**
 * The same decision with what the activity trail records of it: how the call ended here (a
 * standing answer, allowed once, declined, still waiting) and the rule that decided.
 */
export async function decideConnectorCall(db: Client, call: ConnectorCall, now = new Date()): Promise<{ answer: string | null; trail: DesktopActivityDecision }> {
    const said = (outcome: NonNullable<DesktopActivityDecision['outcome']>, rule: string): DesktopActivityDecision => ({ outcome, rule, kind: call.kind, action: call.tool.slice(0, 200) })
    const rule = (await db.execute({ sql: "SELECT id,session_id FROM desktop_connector_approval_rules WHERE owner=? AND tool=? AND session_id IN ('',?) ORDER BY session_id DESC LIMIT 1", args: [call.owner, call.tool, call.sessionId] })).rows[0]
    if (rule) return { answer: null, trail: said('allowed-by-permission', rule.session_id === '' ? 'standing-answer:always' : 'standing-answer:conversation') }
    const digest = digestOf(call.arguments)
    const tx = await db.transaction('write')
    try {
        const row = (await tx.execute({
            sql: "SELECT id,status FROM desktop_connector_approval_requests WHERE owner=? AND session_id=? AND tool=? AND args_digest=? AND status IN ('pending','allowed','declined') ORDER BY created_at DESC LIMIT 1",
            args: [call.owner, call.sessionId, call.tool, digest],
        })).rows[0]
        let answer: string | null
        let trail = said('asked-person', `ask-first:${call.kind}`)
        if (row?.status === 'allowed') {
            await tx.execute({ sql: "UPDATE desktop_connector_approval_requests SET status='used' WHERE id=? AND status='allowed'", args: [row.id] })
            answer = null
            trail = said('allowed-once-by-person', `ask-first:${call.kind}`)
        } else if (row?.status === 'declined') {
            await tx.execute({ sql: "UPDATE desktop_connector_approval_requests SET status='refused' WHERE id=? AND status='declined'", args: [row.id] })
            answer = 'The person declined this action. Do not try it again unless they ask for it.'
            trail = said('declined-by-person', `ask-first:${call.kind}`)
        } else if (row) {
            answer = 'This action is still waiting for the person’s answer on the card in this chat. End your turn; do not call it again until they have answered. ' + NO_SECOND_ASK
        } else {
            const pending = Number((await tx.execute({ sql: "SELECT COUNT(*) AS n FROM desktop_connector_approval_requests WHERE session_id=? AND status='pending'", args: [call.sessionId] })).rows[0]?.n ?? 0)
            if (pending >= MAX_PENDING) { answer = 'Too many actions are already waiting for the person’s answer in this chat. End your turn and let them answer those first.'; trail = said('refused-policy', 'policy:too-many-waiting') }
            else {
                const text = connectorPreview(call.arguments)
                await tx.execute({
                    sql: "INSERT INTO desktop_connector_approval_requests(id,owner,session_id,tool,kind,args_digest,preview,status,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)",
                    args: [randomUUID(), call.owner, call.sessionId, call.tool, call.kind, digest, text, now.toISOString()],
                })
                answer = `Rerun asks the person before a coworker ${WORDS[call.kind]}. This call did not run. A card asking them is now in this chat. `
                    + 'Tell them in one short sentence what you want to do and why, then end your turn. When they allow it, call this tool again with exactly the same arguments. ' + NO_SECOND_ASK
            }
        }
        await tx.commit()
        return { answer, trail }
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

/** The oldest held call still waiting in a conversation, for the board and the Actions inbox. */
export async function pendingConnectorApproval(db: Client, sessionId: string): Promise<{ id: string; tool: string; createdAt: string } | null> {
    const row = (await db.execute({ sql: "SELECT id,tool,created_at FROM desktop_connector_approval_requests WHERE session_id=? AND status='pending' ORDER BY created_at LIMIT 1", args: [sessionId] })).rows[0]
    return row ? { id: String(row.id), tool: String(row.tool), createdAt: String(row.created_at) } : null
}

/** Every standing answer a coworker holds, for its Tools settings. */
export async function listConnectorRules(db: Client, owner: string): Promise<DesktopConnectorApprovalView['rules']> {
    return (await db.execute({ sql: 'SELECT id,tool,session_id FROM desktop_connector_approval_rules WHERE owner=? ORDER BY created_at LIMIT 200', args: [owner] }))
        .rows.map(row => ({ id: String(row.id), tool: String(row.tool), scope: row.session_id === '' ? 'always' as const : 'conversation' as const }))
}

export async function forgetConnectorRuleOf(db: Client, owner: string, ruleId: string): Promise<boolean> {
    return (await db.execute({ sql: 'DELETE FROM desktop_connector_approval_rules WHERE id=? AND owner=?', args: [ruleId, owner] })).rowsAffected === 1
}
