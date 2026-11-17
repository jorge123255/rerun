import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import {
    connectionReasoningOptions, desktopTeamChangePermissionLabel, desktopTeamChangesInputSchema, desktopTeamChangesSchema,
    type ConnectionSummary, type DesktopForemanBinding, type DesktopForemanChatRef, type DesktopTeamChange, type DesktopTeamChanges, type DesktopTeamModelOption,
} from '@rerun/contracts'

// Team changes the Chief of Staff proposed. This file checks a proposal against the real workspace
// and keeps it for the card. It applies nothing: applying is the person's click, sent through the
// same requests their own clicks make.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS desktop_foreman_team_changes (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, chat_id TEXT NOT NULL, run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
 body TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(chat_id, run_id, tool_call_id)
);
CREATE INDEX IF NOT EXISTS desktop_foreman_team_changes_chat ON desktop_foreman_team_changes(workspace_id, chat_id, created_at);`
const ready = new WeakMap<Client, Promise<void>>()
function ensure(db: Client): Promise<void> {
    let pending = ready.get(db)
    if (!pending) { pending = db.executeMultiple(SCHEMA).then(() => {}); ready.set(db, pending); pending.catch(() => ready.delete(db)) }
    return pending
}

export type TeamChangeWorkspace = {
    /** `setupWaiting` false: nothing to start (no setup, already started, or done). Left out when it could not be read. */
    coworkers: readonly { id: string; name: string; setupWaiting?: boolean }[]
    connections: readonly Pick<ConnectionSummary, 'id' | 'name' | 'provider' | 'connected' | 'models' | 'extraModels' | 'codexReasoning' | 'customReasoning' | 'subscriptionModels'>[]
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** The models the Chief of Staff may choose from, with each model's efforts. Names only: no key, no address. */
export function teamModelOptions(connections: TeamChangeWorkspace['connections']): DesktopTeamModelOption[] {
    return connections.filter(connection => connection.connected).slice(0, 12).map(connection => ({
        connectionId: connection.id, name: connection.name,
        models: [...connection.models, ...(connection.extraModels ?? [])].slice(0, 30).map(id => ({ id, efforts: connectionReasoningOptions(connection as never, id)?.supported ?? [] })),
    }))
}

/** Each proposed line resolved to a real coworker, permission and model, or refused with the reason. */
export function sealTeamChanges(raw: unknown, workspace: TeamChangeWorkspace): { ok: true; summary: string; changes: DesktopTeamChange[]; refused: string[] } | { ok: false; message: string } {
    const parsed = desktopTeamChangesInputSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: parsed.error.issues.map(issue => issue.message).join(' ').slice(0, 600) }
    const changes: DesktopTeamChange[] = [], refused: string[] = []
    const seen = new Set<string>()
    for (const line of parsed.data.changes) {
        const refuse = (why: string) => { if (refused.length < 20) refused.push(`${line.action}${line.coworker ? ` for "${line.coworker}"` : ''}: ${why}`) }
        const matches = line.coworker ? workspace.coworkers.filter(coworker => same(coworker.name, line.coworker!)) : []
        if (line.action !== 'set_effort') {
            if (!line.coworker) { refuse('name the coworker'); continue }
            if (matches.length !== 1) { refuse(matches.length ? 'more than one coworker has this name' : 'no coworker has this name'); continue }
        }
        const who = matches[0] ?? null
        let connection: TeamChangeWorkspace['connections'][number] | null = null
        if (line.action === 'set_model' || line.action === 'set_effort') {
            connection = workspace.connections.find(item => item.connected && (same(item.name, line.connection ?? '') || item.id === line.connection)) ?? null
            if (!connection) { refuse('that provider is not connected'); continue }
            if (!line.model || ![...connection.models, ...(connection.extraModels ?? [])].includes(line.model)) { refuse('that provider does not offer this model'); continue }
        }
        if ((line.action === 'allow' || line.action === 'stop_allowing') && !line.permission) { refuse('name the permission'); continue }
        if (line.action === 'start_setup' && who?.setupWaiting === false) { refuse('this coworker has no setup waiting to start'); continue }
        if (line.action === 'set_effort' && (!line.effort || !connectionReasoningOptions(connection as never, line.model!)?.supported.includes(line.effort))) { refuse('that model does not offer this effort'); continue }
        const identity = JSON.stringify([line.action, who?.id ?? null, line.permission ?? null, connection?.id ?? null, line.model ?? null])
        if (seen.has(identity)) continue
        seen.add(identity)
        const name = who?.name ?? ''
        const model = connection ? `${connection.name} · ${line.model}` : ''
        const [label, caution]: [string, string | null] =
            line.action === 'switch_on' ? [`Switch on ${name}`, null]
            : line.action === 'switch_off' ? [`Switch off ${name}`, null]
            : line.action === 'allow' ? [`Allow ${name}: ${desktopTeamChangePermissionLabel(line.permission!)}`, line.permission === 'githubWrite' ? 'Every change to a repository still asks you first.' : null]
            : line.action === 'stop_allowing' ? [`Stop allowing ${name}: ${desktopTeamChangePermissionLabel(line.permission!)}`, null]
            : line.action === 'give_github' ? [`Let ${name} work on its GitHub repository`, 'A copy kept on this Mac; no app from the Vault is given. A pull request or a comment asks you first, every time.']
            : line.action === 'start_setup' ? [`Start ${name}'s setup`, 'Runs one conversation turn on its model.']
            : line.action === 'set_model' ? [`Set ${name} to answer with ${model}`, null]
            : [`Set ${model} to ${line.effort} effort`, 'Applies wherever this model runs, not to one coworker.']
        changes.push({
            key: `change-${changes.length}`, action: line.action, agentId: who?.id ?? null, coworker: who?.name ?? null, permission: line.permission ?? null,
            connectionId: connection?.id ?? null, model: connection ? line.model! : null, effort: line.action === 'set_effort' ? line.effort! : null, label, caution, result: null,
        })
    }
    return { ok: true, summary: parsed.data.summary, changes, refused }
}

const of = (chat: DesktopForemanChatRef) => [chat.workspaceId, chat.chatId]
function recordOf(row: Record<string, unknown> | undefined): DesktopTeamChanges | null {
    if (!row) return null
    try { const parsed = desktopTeamChangesSchema.safeParse(JSON.parse(String(row.body))); return parsed.success ? parsed.data : null } catch { return null }
}

/** Keeps a checked proposal for the card and tells the model, in plain words, what the person will see. */
export async function recordDesktopTeamChanges(db: Client, binding: DesktopForemanBinding, toolCallId: string, raw: unknown, workspace: TeamChangeWorkspace, now = () => new Date().toISOString()) {
    await ensure(db)
    const existing = recordOf((await db.execute({ sql: 'SELECT body FROM desktop_foreman_team_changes WHERE chat_id=? AND run_id=? AND tool_call_id=?', args: [binding.chatId, binding.runId, toolCallId] })).rows[0])
    const said = (record: DesktopTeamChanges, refused: string[]) => ({
        shown: record.changes.length, refused,
        note: `A card with ${record.changes.length} ${record.changes.length === 1 ? 'change' : 'changes'} is waiting above the person's message box. Nothing has changed yet: tell them in one sentence to review and approve it there, then end your turn.${refused.length ? ' Lines the app refused are listed under refused; say which and why.' : ''}`,
    })
    if (existing) return said(existing, [])
    const sealed = sealTeamChanges(raw, workspace)
    if (!sealed.ok) return { shown: 0, refused: [sealed.message], note: 'No card was shown. Correct the proposal and call the tool again.' }
    if (!sealed.changes.length) return { shown: 0, refused: sealed.refused, note: 'No card was shown: every line was refused. Use the exact coworker names and the providers and models listed to you.' }
    const record: DesktopTeamChanges = { id: `ftc_${randomUUID()}`, summary: sealed.summary, state: 'shown', changes: sealed.changes, createdAt: now() }
    await db.execute({ sql: 'INSERT INTO desktop_foreman_team_changes(id,workspace_id,chat_id,run_id,tool_call_id,body,created_at) VALUES(?,?,?,?,?,?,?)', args: [record.id, ...of(binding), binding.runId, toolCallId, JSON.stringify(record), record.createdAt] })
    return said(record, sealed.refused)
}

/** The conversation's latest proposal, whatever its state. */
export async function readDesktopTeamChanges(db: Client, chat: DesktopForemanChatRef): Promise<DesktopTeamChanges | null> {
    await ensure(db)
    return recordOf((await db.execute({ sql: 'SELECT body FROM desktop_foreman_team_changes WHERE workspace_id=? AND chat_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', args: of(chat) })).rows[0])
}

/** Writes down what the person did with a card: applied, with each line's outcome, or dismissed. A settled card stays settled. */
export async function settleDesktopTeamChanges(db: Client, chat: DesktopForemanChatRef, settle: { id: string; state: 'applied' | 'dismissed'; results: { key: string; ok: boolean; message: string | null }[] }): Promise<DesktopTeamChanges | null> {
    await ensure(db)
    const row = (await db.execute({ sql: 'SELECT body FROM desktop_foreman_team_changes WHERE id=? AND workspace_id=? AND chat_id=?', args: [settle.id, ...of(chat)] })).rows[0]
    const record = recordOf(row)
    if (!record) return null
    if (record.state !== 'shown') return record
    const next: DesktopTeamChanges = { ...record, state: settle.state, changes: record.changes.map(change => {
        const result = settle.results.find(item => item.key === change.key)
        return result ? { ...change, result: { ok: result.ok, message: result.message } } : change
    }) }
    await db.execute({ sql: 'UPDATE desktop_foreman_team_changes SET body=? WHERE id=?', args: [JSON.stringify(next), record.id] })
    return next
}
