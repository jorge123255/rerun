import type { Client, InStatement, Transaction } from '@libsql/client'
import {
    foremanBuildSchema,
    foremanDecisionSchema,
    foremanDiscoveryRunSchema,
    foremanRevisionSchema,
    type DesktopForemanBuild,
    type DesktopForemanChatRef,
    type DesktopForemanDecision,
    type DesktopForemanDiscoveryRun,
    type DesktopForemanRevision,
} from '@rerun/contracts'

// Root applies these statements as a numbered step of the desktop database ladder. This module
// never creates tables itself and is not another database: it reads and writes root's.
export const DESKTOP_FOREMAN_SCHEMA_STATEMENTS: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS desktop_foreman_revisions(revision_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, chat_id TEXT NOT NULL, plan_id TEXT NOT NULL, revision INTEGER NOT NULL, run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(chat_id, run_id, tool_call_id), UNIQUE(plan_id, revision))`,
    `CREATE TABLE IF NOT EXISTS desktop_foreman_decisions(decision_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, chat_id TEXT NOT NULL, revision_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS desktop_foreman_builds(build_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, decision_id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, intents TEXT NOT NULL, body TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS desktop_foreman_actions(request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, build_id TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS desktop_foreman_discoveries(discovery_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, run_id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(chat_id, run_id))`,
    `CREATE INDEX IF NOT EXISTS desktop_foreman_revisions_chat ON desktop_foreman_revisions(chat_id, plan_id, revision)`,
    `CREATE INDEX IF NOT EXISTS desktop_foreman_builds_chat ON desktop_foreman_builds(chat_id)`,
]

// Per-item intended identities, reserved with the build before any effect.
export type ForemanBuildIntents = {
    boxes: Record<string, string>
    items: Record<string, string>
    setup: string | null
}

export type ForemanAction = { requestId: string; fingerprint: string; buildId: string; state: 'pending' | 'acknowledged' | 'failed' | 'uncertain'; body: unknown }

export type ForemanTx = {
    revisionsOf(chat: DesktopForemanChatRef): Promise<DesktopForemanRevision[]>
    revisionByCall(chatId: string, runId: string, toolCallId: string): Promise<DesktopForemanRevision | null>
    putRevision(revision: DesktopForemanRevision): Promise<void>
    decisionsOf(chatId: string): Promise<DesktopForemanDecision[]>
    decisionByRequest(requestId: string): Promise<{ decision: DesktopForemanDecision; fingerprint: string; chatId: string } | null>
    putDecision(chatId: string, fingerprint: string, decision: DesktopForemanDecision): Promise<void>
    buildsOf(chatId: string): Promise<{ build: DesktopForemanBuild; version: number; intents: ForemanBuildIntents }[]>
    build(buildId: string): Promise<{ build: DesktopForemanBuild; version: number; intents: ForemanBuildIntents; chatId: string } | null>
    insertBuild(chatId: string, build: DesktopForemanBuild, intents: ForemanBuildIntents): Promise<void>
    // Compare-and-set: returns false when another writer advanced the build first.
    updateBuild(build: DesktopForemanBuild, expectedVersion: number, intents?: ForemanBuildIntents): Promise<boolean>
    action(requestId: string): Promise<ForemanAction | null>
    putAction(action: ForemanAction): Promise<void>
    discovery(chatId: string, runId: string): Promise<DesktopForemanDiscoveryRun | null>
    latestDiscovery(chatId: string): Promise<DesktopForemanDiscoveryRun | null>
    putDiscovery(run: DesktopForemanDiscoveryRun): Promise<void>
    unsettledBuildIds(): Promise<string[]>
    unsettledDecisions(): Promise<DesktopForemanDecision[]>
    runningDiscoveries(): Promise<DesktopForemanDiscoveryRun[]>
}

export type ForemanStore = { transaction<T>(work: (tx: ForemanTx) => Promise<T>): Promise<T> }

type Exec = Pick<Transaction, 'execute'>
const one = async (db: Exec, stmt: InStatement) => (await db.execute(stmt)).rows[0] ?? null
const all = async (db: Exec, stmt: InStatement) => (await db.execute(stmt)).rows

function bind(db: Exec): ForemanTx {
    const revision = (row: Record<string, unknown>) => foremanRevisionSchema.parse(JSON.parse(String(row.body)))
    const decision = (row: Record<string, unknown>) => foremanDecisionSchema.parse(JSON.parse(String(row.body)))
    const buildRow = (row: Record<string, unknown>) => ({ build: foremanBuildSchema.parse(JSON.parse(String(row.body))), version: Number(row.version), intents: JSON.parse(String(row.intents)) as ForemanBuildIntents, chatId: String(row.chat_id) })
    return {
        revisionsOf: async chat => (await all(db, { sql: 'SELECT body FROM desktop_foreman_revisions WHERE workspace_id=? AND chat_id=? ORDER BY plan_id, revision', args: [chat.workspaceId, chat.chatId] })).map(revision).sort((a, b) => a.shownAt.localeCompare(b.shownAt) || a.revision - b.revision),
        revisionByCall: async (chatId, runId, toolCallId) => {
            const row = await one(db, { sql: 'SELECT body FROM desktop_foreman_revisions WHERE chat_id=? AND run_id=? AND tool_call_id=?', args: [chatId, runId, toolCallId] })
            return row ? revision(row) : null
        },
        putRevision: async value => {
            await db.execute({
                sql: 'INSERT INTO desktop_foreman_revisions(revision_id,workspace_id,chat_id,plan_id,revision,run_id,tool_call_id,digest,state,body) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(revision_id) DO UPDATE SET state=excluded.state, body=excluded.body WHERE desktop_foreman_revisions.digest=excluded.digest',
                args: [value.revisionId, value.chat.workspaceId, value.chat.chatId, value.planId, value.revision, value.runId, value.toolCallId, value.digest, value.state, JSON.stringify(value)],
            })
        },
        decisionsOf: async chatId => (await all(db, { sql: 'SELECT body FROM desktop_foreman_decisions WHERE chat_id=? ORDER BY rowid', args: [chatId] })).map(decision),
        decisionByRequest: async requestId => {
            const row = await one(db, { sql: 'SELECT body, fingerprint, chat_id FROM desktop_foreman_decisions WHERE request_id=?', args: [requestId] })
            return row ? { decision: decision(row), fingerprint: String(row.fingerprint), chatId: String(row.chat_id) } : null
        },
        putDecision: async (chatId, fingerprint, value) => {
            await db.execute({
                sql: 'INSERT INTO desktop_foreman_decisions(decision_id,request_id,fingerprint,chat_id,revision_id,body) VALUES(?,?,?,?,?,?) ON CONFLICT(decision_id) DO UPDATE SET body=excluded.body',
                args: [value.decisionId, value.requestId, fingerprint, chatId, value.revisionId, JSON.stringify(value)],
            })
        },
        buildsOf: async chatId => (await all(db, { sql: 'SELECT * FROM desktop_foreman_builds WHERE chat_id=? ORDER BY rowid', args: [chatId] })).map(buildRow),
        build: async buildId => {
            const row = await one(db, { sql: 'SELECT * FROM desktop_foreman_builds WHERE build_id=?', args: [buildId] })
            return row ? buildRow(row) : null
        },
        insertBuild: async (chatId, value, intents) => {
            await db.execute({ sql: 'INSERT INTO desktop_foreman_builds(build_id,chat_id,decision_id,version,intents,body) VALUES(?,?,?,0,?,?)', args: [value.buildId, chatId, value.decisionId, JSON.stringify(intents), JSON.stringify(value)] })
        },
        updateBuild: async (value, expectedVersion, intents) => {
            const result = await db.execute({
                sql: 'UPDATE desktop_foreman_builds SET version=version+1, body=?, intents=COALESCE(?, intents) WHERE build_id=? AND version=?',
                args: [JSON.stringify(value), intents ? JSON.stringify(intents) : null, value.buildId, expectedVersion],
            })
            return result.rowsAffected === 1
        },
        action: async requestId => {
            const row = await one(db, { sql: 'SELECT * FROM desktop_foreman_actions WHERE request_id=?', args: [requestId] })
            return row ? { requestId, fingerprint: String(row.fingerprint), buildId: String(row.build_id), state: String(row.state) as ForemanAction['state'], body: JSON.parse(String(row.body)) } : null
        },
        putAction: async value => {
            await db.execute({
                sql: 'INSERT INTO desktop_foreman_actions(request_id,fingerprint,build_id,state,body) VALUES(?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET state=excluded.state, body=excluded.body WHERE desktop_foreman_actions.fingerprint=excluded.fingerprint',
                args: [value.requestId, value.fingerprint, value.buildId, value.state, JSON.stringify(value.body ?? null)],
            })
        },
        discovery: async (chatId, runId) => {
            const row = await one(db, { sql: 'SELECT body FROM desktop_foreman_discoveries WHERE chat_id=? AND run_id=?', args: [chatId, runId] })
            return row ? foremanDiscoveryRunSchema.parse(JSON.parse(String(row.body))) : null
        },
        latestDiscovery: async chatId => {
            const row = await one(db, { sql: 'SELECT body FROM desktop_foreman_discoveries WHERE chat_id=? ORDER BY rowid DESC LIMIT 1', args: [chatId] })
            return row ? foremanDiscoveryRunSchema.parse(JSON.parse(String(row.body))) : null
        },
        putDiscovery: async value => {
            await db.execute({
                sql: 'INSERT INTO desktop_foreman_discoveries(discovery_id,chat_id,run_id,body) VALUES(?,?,?,?) ON CONFLICT(discovery_id) DO UPDATE SET body=excluded.body',
                args: [value.discoveryId, value.chat.chatId, value.runId, JSON.stringify(value)],
            })
        },
        unsettledBuildIds: async () => (await all(db, { sql: "SELECT build_id FROM desktop_foreman_builds WHERE json_extract(body,'$.state') IN ('reserved','running','uncertain') OR json_extract(body,'$.setup.state') IN ('pending','uncertain')", args: [] })).map(row => String(row.build_id)),
        unsettledDecisions: async () => (await all(db, { sql: "SELECT body FROM desktop_foreman_decisions WHERE json_extract(body,'$.state') IN ('pending','uncertain')", args: [] })).map(decision),
        runningDiscoveries: async () => (await all(db, { sql: "SELECT body FROM desktop_foreman_discoveries WHERE json_extract(body,'$.status')='running'", args: [] })).map(row => foremanDiscoveryRunSchema.parse(JSON.parse(String(row.body)))),
    }
}

// Binds the store to root's open desktop database. Root must have applied the schema step.
export function createForemanSqliteStore(db: Client): ForemanStore {
    return {
        async transaction(work) {
            const tx = await db.transaction('write')
            try {
                const result = await work(bind(tx))
                await tx.commit()
                return result
            } catch (error) {
                await tx.rollback().catch(() => {})
                throw error
            } finally {
                tx.close()
            }
        },
    }
}
