import type { Client, InStatement } from '@libsql/client'

// Root applies this statement as the next desktop database step. This module never creates the table.
export const DESKTOP_SHARED_FILE_MUTATION_SCHEMA = `CREATE TABLE IF NOT EXISTS desktop_shared_file_calls (
    workspace_id INTEGER NOT NULL,
    owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    state TEXT NOT NULL,
    result TEXT,
    PRIMARY KEY(workspace_id, owner, run_id, call_id))`

export type SharedReceiptKey = { workspaceId: number; owner: string; runId: string; callId: string }
export type SharedReceiptRow = { digest: string; state: string; result: string | null }
export type SharedReceiptStore = {
    read(key: SharedReceiptKey): Promise<SharedReceiptRow | null>
    claim(key: SharedReceiptKey, digest: string): Promise<boolean>
    finish(key: SharedReceiptKey, digest: string, state: string, result: string): Promise<boolean>
}

const argsOf = (key: SharedReceiptKey) => [key.workspaceId, key.owner, key.runId, key.callId]

export function createSharedReceiptSqliteStore(db: Client): SharedReceiptStore {
    const one = async (stmt: InStatement) => (await db.execute(stmt)).rows[0] ?? null
    return {
        async read(key) {
            const row = await one({ sql: 'SELECT digest,state,result FROM desktop_shared_file_calls WHERE workspace_id=? AND owner=? AND run_id=? AND call_id=?', args: argsOf(key) })
            return row ? { digest: String(row.digest), state: String(row.state), result: row.result == null ? null : String(row.result) } : null
        },
        async claim(key, digest) {
            const result = await db.execute({
                sql: 'INSERT INTO desktop_shared_file_calls(workspace_id,owner,run_id,call_id,digest,state) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
                args: [...argsOf(key), digest, 'claimed'],
            })
            return result.rowsAffected === 1
        },
        async finish(key, digest, state, result) {
            const written = await db.execute({
                sql: 'UPDATE desktop_shared_file_calls SET state=?,result=? WHERE workspace_id=? AND owner=? AND run_id=? AND call_id=? AND digest=? AND state=?',
                args: [state, result, ...argsOf(key), digest, 'claimed'],
            })
            return written.rowsAffected === 1
        },
    }
}
