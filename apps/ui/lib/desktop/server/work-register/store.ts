import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Client, InStatement, Row } from '@libsql/client'
import type { DesktopNotificationEvent } from '../../notifications'
import {
    FOREMAN_AGENT_ID, FOREMAN_DISPLAY_NAME, DESKTOP_WORK_CHIEF, DESKTOP_WORK_LIMITS, DESKTOP_WORK_OPEN_STATUSES, DESKTOP_WORK_PERSON, DESKTOP_WORK_STATUSES,
    desktopWorkEvidenceFindings, desktopWorkObjectiveKey, desktopWorkProjectKey, desktopWorkSecretFindings, isDesktopWorkOpen,
    type DesktopWorkItem, type DesktopWorkListInput, type DesktopWorkNoteInput, type DesktopWorkNotice, type DesktopWorkParty,
    type DesktopWorkStatus, type DesktopWorkUpsertInput,
} from '@rerun/contracts'

// The shared work register, kept in the workspace database beside the board. It records the team's
// work and nothing else: no row here approves, grants or starts anything.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS desktop_work_items (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
 project TEXT NOT NULL, project_key TEXT NOT NULL,
 owner_kind TEXT NOT NULL CHECK (owner_kind IN ('coworker', 'person', 'chief')), owner_agent_id TEXT,
 objective TEXT NOT NULL, objective_key TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'working', 'blocked', 'waiting_approval', 'done', 'dropped')),
 dependencies TEXT NOT NULL DEFAULT '[]', blockers TEXT, important INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1)),
 next_action TEXT, updates TEXT NOT NULL DEFAULT '[]', evidence TEXT NOT NULL DEFAULT '[]', approval TEXT,
 source_kind TEXT NOT NULL CHECK (source_kind IN ('coworker', 'person', 'chief')), source_agent_id TEXT,
 revision INTEGER NOT NULL CHECK (revision >= 1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_work_items_match ON desktop_work_items(workspace_id, project_key, owner_kind, owner_agent_id, status);
CREATE TABLE IF NOT EXISTS desktop_work_notices (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('approval', 'blocker', 'summary')),
 item_id TEXT, dedupe TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL, chat_id TEXT,
 created_at TEXT NOT NULL, read_at TEXT
);
CREATE INDEX IF NOT EXISTS desktop_work_notices_open ON desktop_work_notices(workspace_id, read_at, created_at);`

const ready = new WeakMap<Client, Promise<void>>()
export function ensureDesktopWorkRegister(db: Client): Promise<void> {
    let pending = ready.get(db)
    if (!pending) { pending = db.executeMultiple(SCHEMA).then(() => {}); ready.set(db, pending); pending.catch(() => ready.delete(db)) }
    return pending
}

/** A refusal the caller is told about in plain words. */
export class DesktopWorkRegisterError extends Error {
    constructor(readonly status: number, message: string) { super(message); this.name = 'DesktopWorkRegisterError' }
}

/** Who writes. The person only closes items from the list; coworkers and the Chief of Staff use the tools. */
export type DesktopWorkActor = { kind: 'chief' } | { kind: 'coworker'; agentId: string; name: string } | { kind: 'person' }
/** The workspace's coworkers, by their local id, to name owners and to resolve the names tools pass. */
export type DesktopWorkRoster = readonly { id: string; name: string }[]

const L = DESKTOP_WORK_LIMITS
const json = <T>(value: unknown, fallback: T): T => { try { return JSON.parse(String(value)) as T } catch { return fallback } }
const nullable = (value: unknown) => value === null || value === undefined ? null : String(value)
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16)
type Update = { text: string; at: string; by: string }

function party(kind: string, agentId: string | null, roster: DesktopWorkRoster): DesktopWorkParty {
    if (kind === 'person') return { kind: 'person', id: null, name: 'You' }
    if (kind === 'chief') return { kind: 'chief', id: null, name: DESKTOP_WORK_CHIEF }
    return { kind: 'coworker', id: agentId, name: roster.find(agent => agent.id === agentId)?.name ?? 'A removed coworker' }
}
const actorName = (actor: DesktopWorkActor) => actor.kind === 'coworker' ? actor.name : actor.kind === 'chief' ? DESKTOP_WORK_CHIEF : 'You'
const actorParty = (actor: DesktopWorkActor): [DesktopWorkParty['kind'], string | null] => [actor.kind, actor.kind === 'coworker' ? actor.agentId : null]

function itemOf(row: Row, roster: DesktopWorkRoster): DesktopWorkItem {
    const updates = json<Update[]>(row.updates, [])
    const approval = nullable(row.approval)
    return {
        id: String(row.id), project: String(row.project), owner: party(String(row.owner_kind), nullable(row.owner_agent_id), roster),
        objective: String(row.objective), status: String(row.status) as DesktopWorkStatus, dependencies: json<string[]>(row.dependencies, []),
        blockers: nullable(row.blockers), important: Number(row.important) === 1, nextAction: nullable(row.next_action),
        latestUpdate: updates.at(-1) ?? null, updates: updates.slice(-5), evidence: json<string[]>(row.evidence, []),
        approval: approval ? { required: approval, decides: 'person' } : null,
        source: party(String(row.source_kind), nullable(row.source_agent_id), roster),
        revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }
}

/** Resolves an owner named by a tool: a coworker's exact name (any case), the Chief of Staff, or the person. */
function ownerOf(name: string, roster: DesktopWorkRoster): [DesktopWorkParty['kind'], string | null] {
    const wanted = name.trim().toLowerCase()
    if (wanted === DESKTOP_WORK_PERSON || wanted === 'you' || wanted === 'the person') return ['person', null]
    if (wanted === DESKTOP_WORK_CHIEF.toLowerCase() || wanted === 'chief' || wanted === 'foreman') return ['chief', null]
    const matches = roster.filter(agent => agent.name.trim().toLowerCase() === wanted)
    if (matches.length === 1) return ['coworker', matches[0]!.id]
    if (matches.length > 1) throw new DesktopWorkRegisterError(400, `More than one coworker is called "${name}". Rename one of them before assigning work.`)
    throw new DesktopWorkRegisterError(400, `No coworker is called "${name}". Use a coworker's name, "${DESKTOP_WORK_CHIEF}" or "${DESKTOP_WORK_PERSON}".`)
}

/** Every text that would be stored is checked: a secret value or reference never enters the register. */
function refuseSecrets(input: { texts: (string | null | undefined)[]; evidence?: readonly string[] }) {
    const found = [...input.texts.flatMap(value => value ? desktopWorkSecretFindings(value) : []), ...(input.evidence ?? []).flatMap(desktopWorkEvidenceFindings)]
    if (found.length) throw new DesktopWorkRegisterError(400, `Not saved: this looks like a secret (${[...new Set(found)].join(', ')}). The work register never keeps keys, tokens, passwords or references to saved secrets; describe where the credential lives instead.`)
}

async function readRow(db: Pick<Client, 'execute'>, workspaceId: string, id: string): Promise<Row | null> {
    return (await db.execute({ sql: 'SELECT * FROM desktop_work_items WHERE workspace_id=? AND id=?', args: [workspaceId, id] })).rows[0] ?? null
}

function mayChange(actor: DesktopWorkActor, row: Row): boolean {
    if (actor.kind === 'chief' || actor.kind === 'person') return true
    return (row.owner_kind === 'coworker' && row.owner_agent_id === actor.agentId) || (row.source_kind === 'coworker' && row.source_agent_id === actor.agentId)
}

function notices(workspaceId: string, before: DesktopWorkItem | null, after: DesktopWorkItem, at: string): InStatement[] {
    const statements: InStatement[] = []
    const add = (kind: 'approval' | 'blocker', dedupe: string, title: string, body: string) => statements.push({
        sql: `INSERT INTO desktop_work_notices(id,workspace_id,kind,item_id,dedupe,title,body,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(dedupe) DO NOTHING`,
        args: [randomUUID(), workspaceId, kind, after.id, dedupe, title.slice(0, 200), body.slice(0, 600), at],
    })
    // One notice per thing the person has to decide, however often the item is written.
    if (after.approval && after.approval.required !== before?.approval?.required && isDesktopWorkOpen(after.status)) {
        add('approval', `approval:${after.id}:${digest(after.approval.required)}`, `Needs your approval · ${after.project}`, `${after.approval.required} (${after.objective})`)
    }
    // A blocker reaches the person only when whoever wrote it marked it important.
    if (after.status === 'blocked' && after.important && after.blockers && (before?.status !== 'blocked' || !before.important || before.blockers !== after.blockers)) {
        add('blocker', `blocker:${after.id}:${digest(after.blockers)}`, `Blocked · ${after.project}`, `${after.objective}: ${after.blockers}`)
    }
    return statements
}

const RELEVANCE: Record<DesktopWorkStatus, number> = { waiting_approval: 0, blocked: 1, working: 2, accepted: 3, proposed: 4, done: 5, dropped: 6 }

export async function listDesktopWorkItems(db: Client, workspaceId: string, roster: DesktopWorkRoster, input: DesktopWorkListInput = {}) {
    await ensureDesktopWorkRegister(db)
    const status = input.status ?? 'open'
    const where = ['workspace_id=?']
    const args: (string | number)[] = [workspaceId]
    if (status === 'open') where.push(`status IN (${DESKTOP_WORK_OPEN_STATUSES.map(() => '?').join(',')})`), args.push(...DESKTOP_WORK_OPEN_STATUSES)
    else if (status !== 'all') where.push('status=?'), args.push(status)
    if (input.project) where.push('project_key=?'), args.push(desktopWorkProjectKey(input.project))
    if (input.owner) {
        const [kind, agentId] = ownerOf(input.owner, roster)
        where.push('owner_kind=?'), args.push(kind)
        if (agentId) where.push('owner_agent_id=?'), args.push(agentId)
    }
    const rows = (await db.execute({ sql: `SELECT * FROM desktop_work_items WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id`, args })).rows
    const items = rows.map(row => itemOf(row, roster)).sort((a, b) => RELEVANCE[a.status] - RELEVANCE[b.status] || b.updatedAt.localeCompare(a.updatedAt))
    const limit = input.limit ?? 30
    const counts = Object.fromEntries(DESKTOP_WORK_STATUSES.map(name => [name, 0])) as Record<DesktopWorkStatus, number>
    for (const item of items) counts[item.status]++
    return { counts, items: items.slice(0, limit), more: Math.max(0, items.length - limit) }
}

export type DesktopWorkWrite = { item: DesktopWorkItem; created: boolean; duplicate?: true }

export async function upsertDesktopWorkItem(db: Client, workspaceId: string, actor: DesktopWorkActor, roster: DesktopWorkRoster, input: DesktopWorkUpsertInput, now = () => new Date()): Promise<DesktopWorkWrite> {
    await ensureDesktopWorkRegister(db)
    if (actor.kind === 'person') throw new DesktopWorkRegisterError(403, 'Items are written by the Chief of Staff and coworkers.')
    refuseSecrets({ texts: [input.project, input.owner, input.objective, input.blockers, input.nextAction, input.approvalRequired, input.update], evidence: input.evidence })
    const at = now().toISOString()
    const update = input.update ? [{ text: input.update, at, by: actorName(actor) }] : []
    let owner: [DesktopWorkParty['kind'], string | null] | undefined = input.owner ? ownerOf(input.owner, roster) : undefined
    // A coworker records its own work. Giving work to someone else is the Chief of Staff's.
    if (actor.kind === 'coworker' && owner && !(owner[0] === 'coworker' && owner[1] === actor.agentId)) {
        throw new DesktopWorkRegisterError(403, 'A coworker can only own its own items. Ask the Chief of Staff to assign work to someone else.')
    }
    if (input.dependencies?.length) {
        const known = (await db.execute({ sql: `SELECT id FROM desktop_work_items WHERE workspace_id=? AND id IN (${input.dependencies.map(() => '?').join(',')})`, args: [workspaceId, ...input.dependencies] })).rows.map(row => String(row.id))
        const missing = input.dependencies.filter(id => !known.includes(id) || id === input.id)
        if (missing.length) throw new DesktopWorkRegisterError(400, `Unknown dependencies: ${missing.join(', ')}. Use ids from work_list, never the item itself.`)
    }

    if (!input.id) {
        if (input.expectedRevision !== undefined) throw new DesktopWorkRegisterError(400, 'expectedRevision belongs with id. Leave both out to create an item.')
        if (!input.project || !input.objective) throw new DesktopWorkRegisterError(400, 'A new item needs a project and an objective.')
        owner ??= actor.kind === 'coworker' ? ['coworker', actor.agentId] : ['chief', null]
        const projectKey = desktopWorkProjectKey(input.project), objectiveKey = desktopWorkObjectiveKey(input.objective)
        if (!objectiveKey) throw new DesktopWorkRegisterError(400, 'Say what the objective is in words.')
        // The duplicate guard: the same words, the same project and the same owner, still open.
        const open = (await db.execute({
            sql: `SELECT * FROM desktop_work_items WHERE workspace_id=? AND project_key=? AND owner_kind=? AND owner_agent_id IS ? AND objective_key=?
                  AND status IN (${DESKTOP_WORK_OPEN_STATUSES.map(() => '?').join(',')}) ORDER BY created_at LIMIT 1`,
            args: [workspaceId, projectKey, owner[0], owner[1], objectiveKey, ...DESKTOP_WORK_OPEN_STATUSES],
        })).rows[0]
        if (open) return { item: itemOf(open, roster), created: false, duplicate: true }
        const id = `w_${randomUUID().replaceAll('-', '').slice(0, 12)}`
        const status = input.status ?? (input.approvalRequired ? 'waiting_approval' : 'proposed')
        const [sourceKind, sourceAgent] = actorParty(actor)
        const row = {
            id, workspace_id: workspaceId, project: input.project, project_key: projectKey, owner_kind: owner[0], owner_agent_id: owner[1],
            objective: input.objective, objective_key: objectiveKey, status, dependencies: JSON.stringify(input.dependencies ?? []),
            blockers: input.blockers ?? null, important: input.important ? 1 : 0, next_action: input.nextAction ?? null, updates: JSON.stringify(update),
            evidence: JSON.stringify([...new Set(input.evidence ?? [])].slice(-L.evidenceKept)), approval: input.approvalRequired ?? null,
            source_kind: sourceKind, source_agent_id: sourceAgent, revision: 1, created_at: at, updated_at: at,
        }
        const columns = Object.keys(row)
        const item = itemOf(row as unknown as Row, roster)
        await db.batch([
            { sql: `INSERT INTO desktop_work_items(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, args: Object.values(row) as (string | number | null)[] },
            ...notices(workspaceId, null, item, at),
        ], 'write')
        return { item, created: true }
    }

    if (input.expectedRevision === undefined) throw new DesktopWorkRegisterError(400, 'Changing an item needs the expectedRevision work_list gave.')
    const current = await readRow(db, workspaceId, input.id)
    if (!current) throw new DesktopWorkRegisterError(404, 'No item has this id. Read the register with work_list.')
    if (!mayChange(actor, current)) throw new DesktopWorkRegisterError(403, 'This item belongs to another coworker. Only its owner, whoever created it, or the Chief of Staff can change it.')
    if (Number(current.revision) !== input.expectedRevision) {
        throw new DesktopWorkRegisterError(409, `This item changed since you read it (now revision ${Number(current.revision)}). Read it again with work_list and decide again.`)
    }
    const before = itemOf(current, roster)
    const objective = input.objective ?? before.objective
    const project = input.project ?? before.project
    const next = {
        project, project_key: desktopWorkProjectKey(project), owner_kind: owner?.[0] ?? String(current.owner_kind), owner_agent_id: owner ? owner[1] : nullable(current.owner_agent_id),
        objective, objective_key: desktopWorkObjectiveKey(objective), status: input.status ?? before.status,
        dependencies: JSON.stringify(input.dependencies ?? before.dependencies),
        blockers: input.blockers !== undefined ? input.blockers : before.blockers, important: (input.important ?? before.important) ? 1 : 0,
        next_action: input.nextAction !== undefined ? input.nextAction : before.nextAction,
        updates: JSON.stringify([...json<Update[]>(current.updates, []), ...update].slice(-L.updatesKept)),
        evidence: JSON.stringify([...new Set([...before.evidence, ...(input.evidence ?? [])])].slice(-L.evidenceKept)),
        approval: input.approvalRequired !== undefined ? input.approvalRequired || null : before.approval?.required ?? null,
        revision: before.revision + 1, updated_at: at,
    }
    const after = itemOf({ ...current, ...next } as unknown as Row, roster)
    const columns = Object.keys(next)
    const results = await db.batch([
        { sql: `UPDATE desktop_work_items SET ${columns.map(name => `${name}=?`).join(',')} WHERE workspace_id=? AND id=? AND revision=?`,
            args: [...Object.values(next) as (string | number | null)[], workspaceId, before.id, before.revision] },
    ], 'write')
    if (Number(results[0]?.rowsAffected) !== 1) throw new DesktopWorkRegisterError(409, 'This item changed while it was being saved. Read it again with work_list.')
    const raised = notices(workspaceId, before, after, at)
    if (raised.length) await db.batch(raised, 'write')
    return { item: after, created: false }
}

/** Adds a line of progress or evidence. Appending needs no revision; the revision still moves on. */
export async function noteDesktopWorkItem(db: Client, workspaceId: string, actor: DesktopWorkActor, roster: DesktopWorkRoster, input: DesktopWorkNoteInput, now = () => new Date()): Promise<DesktopWorkWrite> {
    await ensureDesktopWorkRegister(db)
    if (!input.update && !input.evidence?.length) throw new DesktopWorkRegisterError(400, 'Add an update, evidence or both.')
    refuseSecrets({ texts: [input.update], evidence: input.evidence })
    for (let attempt = 0; attempt < 3; attempt++) {
        const current = await readRow(db, workspaceId, input.id)
        if (!current) throw new DesktopWorkRegisterError(404, 'No item has this id. Read the register with work_list.')
        if (!mayChange(actor, current)) throw new DesktopWorkRegisterError(403, 'This item belongs to another coworker. Only its owner, whoever created it, or the Chief of Staff can add to it.')
        const before = itemOf(current, roster)
        const at = now().toISOString()
        const updates = [...json<Update[]>(current.updates, []), ...(input.update ? [{ text: input.update, at, by: actorName(actor) }] : [])].slice(-L.updatesKept)
        const evidence = [...new Set([...before.evidence, ...(input.evidence ?? [])])].slice(-L.evidenceKept)
        const result = await db.execute({ sql: 'UPDATE desktop_work_items SET updates=?, evidence=?, revision=?, updated_at=? WHERE workspace_id=? AND id=? AND revision=?',
            args: [JSON.stringify(updates), JSON.stringify(evidence), before.revision + 1, at, workspaceId, before.id, before.revision] })
        if (Number(result.rowsAffected) === 1) return { item: itemOf({ ...current, updates: JSON.stringify(updates), evidence: JSON.stringify(evidence), revision: before.revision + 1, updated_at: at } as unknown as Row, roster), created: false }
    }
    throw new DesktopWorkRegisterError(409, 'This item is changing too often to add to right now. Read it again with work_list.')
}

/** The person's one change from the list: an item is done or dropped. */
export async function closeDesktopWorkItem(db: Client, workspaceId: string, roster: DesktopWorkRoster, input: { id: string; expectedRevision: number; status: 'done' | 'dropped' }, now = () => new Date()): Promise<DesktopWorkItem> {
    await ensureDesktopWorkRegister(db)
    const current = await readRow(db, workspaceId, input.id)
    if (!current) throw new DesktopWorkRegisterError(404, 'This item is no longer in the register.')
    if (Number(current.revision) !== input.expectedRevision) throw new DesktopWorkRegisterError(409, 'This item changed. Look at it again before closing it.')
    const at = now().toISOString()
    const updates = [...json<Update[]>(current.updates, []), { text: input.status === 'done' ? 'Marked done.' : 'Dropped.', at, by: 'You' }].slice(-L.updatesKept)
    const result = await db.execute({ sql: 'UPDATE desktop_work_items SET status=?, updates=?, revision=revision+1, updated_at=? WHERE workspace_id=? AND id=? AND revision=?',
        args: [input.status, JSON.stringify(updates), at, workspaceId, input.id, input.expectedRevision] })
    if (Number(result.rowsAffected) !== 1) throw new DesktopWorkRegisterError(409, 'This item changed. Look at it again before closing it.')
    // Whatever it asked the person for is settled with it.
    await db.execute({ sql: 'UPDATE desktop_work_notices SET read_at=? WHERE workspace_id=? AND item_id=? AND read_at IS NULL', args: [at, workspaceId, input.id] })
    return itemOf((await readRow(db, workspaceId, input.id))!, roster)
}

export async function recordDesktopWorkSummary(db: Client, workspaceId: string, input: { occurrence: string; chatId: string; text: string }, now = () => new Date()): Promise<boolean> {
    await ensureDesktopWorkRegister(db)
    const result = await db.execute({
        sql: `INSERT INTO desktop_work_notices(id,workspace_id,kind,item_id,dedupe,title,body,chat_id,created_at) VALUES(?,?,'summary',NULL,?,?,?,?,?) ON CONFLICT(dedupe) DO NOTHING`,
        args: [randomUUID(), workspaceId, `summary:${input.occurrence}`, 'Coordinate the team', input.text.slice(0, 600), input.chatId, now().toISOString()],
    })
    return Number(result.rowsAffected) === 1
}

const noticeOf = (row: Row): DesktopWorkNotice & { chatId: string | null } => ({
    id: String(row.id), kind: String(row.kind) as DesktopWorkNotice['kind'], itemId: nullable(row.item_id), title: String(row.title), body: String(row.body),
    createdAt: String(row.created_at), chatId: nullable(row.chat_id),
})
export async function listDesktopWorkNotices(db: Client, workspaceId: string, unreadOnly = true) {
    await ensureDesktopWorkRegister(db)
    return (await db.execute({ sql: `SELECT * FROM desktop_work_notices WHERE workspace_id=? ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT 50`, args: [workspaceId] })).rows.map(noticeOf)
}
export async function readDesktopWorkNotice(db: Client, workspaceId: string, id: string, now = () => new Date()): Promise<boolean> {
    await ensureDesktopWorkRegister(db)
    const result = await db.execute({ sql: 'UPDATE desktop_work_notices SET read_at=? WHERE workspace_id=? AND id=? AND read_at IS NULL', args: [now().toISOString(), workspaceId, id] })
    return Number(result.rowsAffected) === 1
}

/** What a tool call is answered with: short, names not ids for people, and the revision to write with. */
export function desktopWorkModelItem(item: DesktopWorkItem) {
    return {
        id: item.id, project: item.project, owner: item.owner.kind === 'person' ? DESKTOP_WORK_PERSON : item.owner.name, objective: item.objective, status: item.status,
        ...(item.dependencies.length && { dependencies: item.dependencies }), ...(item.blockers && { blockers: item.blockers, ...(item.important && { important: true }) }),
        ...(item.nextAction && { nextAction: item.nextAction }),
        ...(item.latestUpdate && { latestUpdate: `${item.latestUpdate.text} (${item.latestUpdate.by}, ${item.latestUpdate.at})` }),
        ...(item.evidence.length && { evidence: item.evidence.slice(-5) }), ...(item.approval && { approvalRequired: item.approval.required }),
        revision: item.revision,
    }
}

const NOTICE_KEY = 'work-notice:'
export const isDesktopWorkNoticeKey = (key: string) => key.startsWith(NOTICE_KEY) && /^[0-9a-f-]{36}$/.test(key.slice(NOTICE_KEY.length))

/**
 * Unread register notices as Mac notifications from the Chief of Staff: what needs approval, an
 * important blocker, and a routine summary the person asked for. Each is announced once.
 */
export async function readDesktopWorkNoticeEvents(db: Client, workspaceId: string): Promise<{ at: number; event: DesktopNotificationEvent }[]> {
    return (await listDesktopWorkNotices(db, workspaceId)).map(notice => ({
        at: Date.parse(notice.createdAt),
        event: {
            key: `${NOTICE_KEY}${notice.id}`, kind: notice.kind === 'summary' ? 'done' as const : 'approval' as const, source: 'schedule' as const,
            agentId: FOREMAN_AGENT_ID, agentName: FOREMAN_DISPLAY_NAME, sessionId: notice.chatId ?? FOREMAN_AGENT_ID, title: FOREMAN_DISPLAY_NAME,
            subtitle: notice.title.slice(0, 200), body: notice.body.slice(0, 400), silent: notice.kind === 'summary',
        },
    }))
}
