import type { Client, InStatement, Transaction } from '@libsql/client'
import { companyDiscoverySnapshotSchema, type DesktopCompanyDiscoverySnapshot } from '@rerun/contracts'

// Root applies these statements as the next desktop database step. This module never creates tables.
export const DESKTOP_COMPANY_DISCOVERY_SCHEMA_STATEMENTS: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS desktop_company_discoveries(discovery_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, chat_id TEXT NOT NULL, run_id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(workspace_id, chat_id, run_id))`,
    `CREATE TABLE IF NOT EXISTS desktop_company_discovery_revisions(discovery_id TEXT NOT NULL, source TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(discovery_id, source, revision))`,
    `CREATE INDEX IF NOT EXISTS desktop_company_discoveries_chat ON desktop_company_discoveries(workspace_id, chat_id)`,
]

export type StoredSnapshot =
    | { state: 'present'; snapshot: DesktopCompanyDiscoverySnapshot }
    | { state: 'unknown'; discoveryId: string; workspaceId: string; chatId: string; runId: string }

export type CompanyDiscoveryTx = {
    byRun(workspaceId: string, chatId: string, runId: string): Promise<StoredSnapshot | null>
    byId(workspaceId: string, chatId: string, discoveryId: string): Promise<StoredSnapshot | null>
    latest(workspaceId: string, chatId: string): Promise<StoredSnapshot | null>
    insert(snapshot: DesktopCompanyDiscoverySnapshot): Promise<'inserted' | 'exists'>
    put(snapshot: DesktopCompanyDiscoverySnapshot): Promise<void>
    insertRevision(discoveryId: string, source: string, revision: number, body: unknown): Promise<boolean>
    running(): Promise<StoredSnapshot[]>
}

export type CompanyDiscoveryStore = { transaction<T>(work: (tx: CompanyDiscoveryTx) => Promise<T>): Promise<T> }

const QUEUE = Symbol.for('rerun.desktop.company-discovery.transactions.v1')
const queues = () => ((globalThis as unknown as Record<symbol, WeakMap<Client, Promise<unknown>>>)[QUEUE] ??= new WeakMap())

type Exec = Pick<Transaction, 'execute'>
const one = async (db: Exec, stmt: InStatement) => (await db.execute(stmt)).rows[0] ?? null
const all = async (db: Exec, stmt: InStatement) => (await db.execute(stmt)).rows

export function readSnapshotBody(body: string, identity: { discoveryId: string; workspaceId: string; chatId: string; runId: string }): StoredSnapshot {
    try {
        const snapshot = companyDiscoverySnapshotSchema.parse(JSON.parse(body))
        if (snapshot.discoveryId !== identity.discoveryId || snapshot.workspaceId !== identity.workspaceId || snapshot.chatId !== identity.chatId || snapshot.runId !== identity.runId) {
            return { state: 'unknown', ...identity }
        }
        return { state: 'present', snapshot }
    } catch {
        return { state: 'unknown', ...identity }
    }
}

function rowOf(row: Record<string, unknown>): StoredSnapshot {
    const identity = { discoveryId: String(row.discovery_id), workspaceId: String(row.workspace_id), chatId: String(row.chat_id), runId: String(row.run_id) }
    return readSnapshotBody(String(row.body), identity)
}

function bind(db: Exec): CompanyDiscoveryTx {
    return {
        byRun: async (workspaceId, chatId, runId) => {
            const row = await one(db, { sql: 'SELECT * FROM desktop_company_discoveries WHERE workspace_id=? AND chat_id=? AND run_id=?', args: [workspaceId, chatId, runId] })
            return row ? rowOf(row) : null
        },
        byId: async (workspaceId, chatId, discoveryId) => {
            const row = await one(db, { sql: 'SELECT * FROM desktop_company_discoveries WHERE workspace_id=? AND chat_id=? AND discovery_id=?', args: [workspaceId, chatId, discoveryId] })
            return row ? rowOf(row) : null
        },
        latest: async (workspaceId, chatId) => {
            const row = await one(db, { sql: 'SELECT * FROM desktop_company_discoveries WHERE workspace_id=? AND chat_id=? ORDER BY rowid DESC LIMIT 1', args: [workspaceId, chatId] })
            return row ? rowOf(row) : null
        },
        insert: async snapshot => {
            try {
                await db.execute({
                    sql: 'INSERT INTO desktop_company_discoveries(discovery_id,workspace_id,chat_id,run_id,body) VALUES(?,?,?,?,?)',
                    args: [snapshot.discoveryId, snapshot.workspaceId, snapshot.chatId, snapshot.runId, JSON.stringify(snapshot)],
                })
                return 'inserted'
            } catch (error) {
                if (!/UNIQUE|constraint/i.test(error instanceof Error ? error.message : String(error))) throw error
                return 'exists'
            }
        },
        put: async snapshot => {
            await db.execute({
                sql: 'UPDATE desktop_company_discoveries SET body=? WHERE discovery_id=? AND workspace_id=? AND chat_id=? AND run_id=?',
                args: [JSON.stringify(snapshot), snapshot.discoveryId, snapshot.workspaceId, snapshot.chatId, snapshot.runId],
            })
        },
        insertRevision: async (discoveryId, source, revision, body) => {
            const result = await db.execute({
                sql: 'INSERT INTO desktop_company_discovery_revisions(discovery_id,source,revision,body) VALUES(?,?,?,?) ON CONFLICT(discovery_id, source, revision) DO NOTHING',
                args: [discoveryId, source, revision, JSON.stringify(body)],
            })
            return result.rowsAffected === 1
        },
        running: async () => (await all(db, { sql: "SELECT * FROM desktop_company_discoveries WHERE json_extract(body,'$.status')='running'", args: [] })).map(rowOf),
    }
}

export function createCompanyDiscoverySqliteStore(db: Client): CompanyDiscoveryStore {
    return {
        transaction(work) {
            const previous = queues().get(db) ?? Promise.resolve()
            const result = previous.then(() => execute(work), () => execute(work))
            queues().set(db, result.catch(() => {}))
            return result
        },
    }
    async function execute<T>(work: (tx: CompanyDiscoveryTx) => Promise<T>): Promise<T> {
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
    }
}
