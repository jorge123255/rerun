import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import {
    connectionReasoningOptions, redactHistoricalText, DESKTOP_TEAM_CHANGE_CHIEF, DESKTOP_TEAM_CHANGE_EVERYONE, desktopTeamChangePermissionLabel, desktopTeamChangesInputSchema, desktopTeamChangesSchema,
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
    coworkers: readonly {
        id: string
        name: string
        setupWaiting?: boolean
        setupActions?: { revision: string; canSkip: boolean; resume?: 'start' | 'continue' }
        setupStep?: Omit<NonNullable<DesktopTeamChange['setupReply']>, 'text'>
    }[]
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
        // The Chief of Staff may be the one that asks; no coworker can take its name's place.
        const chief = line.action === 'allow_calls' && !!line.coworker && same(line.coworker, DESKTOP_TEAM_CHANGE_CHIEF) && matches.length === 0
        if (line.action !== 'set_effort' && !chief) {
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
        let targets: { id: string; name: string }[] = []
        if (line.action === 'allow_calls') {
            const others = workspace.coworkers.filter(coworker => coworker.id !== who?.id)
            if (!line.targets) { refuse('name who may be asked, or "everyone"'); continue }
            if (line.targets.some(name => same(name, DESKTOP_TEAM_CHANGE_EVERYONE))) targets = [...others]
            else {
                const found = line.targets.map(name => others.filter(coworker => same(coworker.name, name)))
                const bad = line.targets.find((_, index) => found[index].length !== 1)
                if (bad) { refuse(`"${bad}" is not the name of exactly one other coworker`); continue }
                targets = [...new Map(found.map(([coworker]) => [coworker.id, coworker])).values()]
            }
            if (!targets.length) { refuse('there is no other coworker to ask'); continue }
        }
        if (line.action === 'start_setup' && who?.setupWaiting === false) { refuse('this coworker has no setup waiting to start'); continue }
        if (line.action === 'set_effort' && (!line.effort || !connectionReasoningOptions(connection as never, line.model!)?.supported.includes(line.effort))) { refuse('that model does not offer this effort'); continue }
        // Skipping conflicts with continuing this same setup in any form. Never pick a
        // winner by line order when the owner could reasonably approve the entire card.
        const isSkip = line.action === 'skip_setup'
        if (line.action.endsWith('_setup') && parsed.data.changes.some(other =>
            other.coworker && line.coworker && same(other.coworker, line.coworker) &&
            other.action.endsWith('_setup') && (other.action === 'skip_setup') !== isSkip)) {
            refuse('choose either skipping or continuing this coworker’s setup'); continue
        }
        if (line.action === 'skip_setup' && !who?.setupActions?.canSkip) { refuse('this setup cannot be skipped in its current state'); continue }
        if (line.action === 'continue_setup' && !who?.setupActions?.resume) { refuse('this setup has no skipped or interrupted start to resume'); continue }
        const step = who?.setupStep
        if (line.action === 'reply_setup') {
            if (!step || !line.reply || step.stepId !== line.stepId) {
                refuse('inspect the current setup question and propose an answer to that exact step'); continue
            }
            if (redactHistoricalText(line.reply, line.reply.length) !== line.reply) {
                refuse('use the coworker’s credential control for sensitive values'); continue
            }
            if (changes.some(change => change.action === 'reply_setup' && change.agentId === who?.id && change.setupReply?.text !== line.reply)) {
                refuse('a different answer is already proposed for this question'); continue
            }
        }
        const identity = JSON.stringify([line.action, chief ? 'chief' : who?.id ?? null, line.permission ?? null, connection?.id ?? null, line.model ?? null])
        if (seen.has(identity)) continue
        seen.add(identity)
        const name = who?.name ?? ''
        const model = connection ? `${connection.name} · ${line.model}` : ''
        const [label, caution]: [string, string | null] =
            line.action === 'switch_on' ? [`Switch on ${name}`, null]
            : line.action === 'switch_off' ? [`Switch off ${name}`, null]
            : line.action === 'allow' ? [`Allow ${name}: ${desktopTeamChangePermissionLabel(line.permission!)}`, line.permission === 'githubWrite' ? 'Every change to a repository still asks you first.' : null]
            : line.action === 'stop_allowing' ? [`Stop allowing ${name}: ${desktopTeamChangePermissionLabel(line.permission!)}`, null]
            : line.action === 'allow_calls' ? [`Let ${chief ? 'the Chief of Staff' : name} ask ${targets.length > 3 ? `${targets.slice(0, 3).map(target => target.name).join(', ')} and ${targets.length - 3} more` : targets.map(target => target.name).join(', ')} for help`,
                chief ? 'It can send them a message and read the answer. Each coworker still works with its own permissions.' : 'Added to who it may already ask. It also needs the Call coworkers permission.']
            : line.action === 'give_github' ? [`Let ${name} work on its GitHub repository`, 'A copy kept on this Mac; no app from the Vault is given. A pull request or a comment asks you first, every time.']
            : line.action === 'start_setup' ? [`Start ${name}'s setup`, 'Starts a setup conversation on this coworker’s model. The Chief can check its next step. Sign-ins and permission requests still need you.']
            : line.action === 'skip_setup' ? [`Skip ${name}’s guided setup`, 'Leaves setup unfinished and marks it skipped. No app connection or permission is granted.']
            : line.action === 'continue_setup' ? [`Resume ${name}’s guided setup`, 'Returns to guided setup on this coworker’s model.']
            : line.action === 'reply_setup' ? [`Reply to ${name}’s setup`, 'Sends the answer below to this setup question when you approve.']
            : line.action === 'set_model' ? [`Set ${name} to answer with ${model}`, null]
            : [`Set ${model} to ${line.effort} effort`, 'Applies wherever this model runs, not to one coworker.']
        changes.push({
            key: `change-${changes.length}`, action: line.action, agentId: who?.id ?? null, coworker: who?.name ?? null, permission: line.permission ?? null,
            connectionId: connection?.id ?? null, model: connection ? line.model! : null, effort: line.action === 'set_effort' ? line.effort! : null,
            ...((line.action === 'skip_setup' || line.action === 'continue_setup') && who?.setupActions ? { setupRevision: who.setupActions.revision } : {}),
            ...(line.action === 'continue_setup' && who?.setupActions?.resume ? { setupResumeAction: who.setupActions.resume } : {}),
            ...(line.action === 'reply_setup' && step ? { setupReply: { ...step, text: line.reply! } } : {}),
            targetAgentIds: line.action === 'allow_calls' ? targets.map(target => target.id) : null, chief, label, caution, result: null,
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
    const updated = await db.execute({ sql: 'UPDATE desktop_foreman_team_changes SET body=? WHERE id=? AND body=?', args: [JSON.stringify(next), record.id, String(row!.body)] })
    if (updated.rowsAffected) return next
    // Another window settled this same card while this one was reading it.
    return recordOf((await db.execute({ sql: 'SELECT body FROM desktop_foreman_team_changes WHERE id=? AND workspace_id=? AND chat_id=?', args: [record.id, ...of(chat)] })).rows[0])
}
