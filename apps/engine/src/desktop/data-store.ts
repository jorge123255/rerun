import type { Client, Transaction } from '@libsql/client'
import { assertReadOnlySql, formatSchema, listTables, serializeRow, withBusyRetry, type SqlParam } from '../db/sqlStore.js'
import { assertExplicitWrite, assertNoHiddenTables, assertNoPragma, assertSafeFunctions, singleStatement, sqlTokens } from './sql-guard.js'
import { recordTableOwnership } from '../db/sharedDb.js'

// Existing schema programs must not turn a permitted table operation into hidden-table access
// or file access. Desktop tools create ordinary tables only; pre-existing programmable schemas
// fail closed rather than trying to inspect or execute their code.
export async function assertPlainDataSchema(tx: Transaction): Promise<void> {
    const programs = await tx.execute("SELECT name FROM sqlite_master WHERE type IN ('view','trigger') OR (type='table' AND upper(ltrim(sql)) LIKE 'CREATE VIRTUAL TABLE%') LIMIT 1")
    if (programs.rows.length) throw new Error('Views, triggers and virtual tables are unavailable in desktop data tools.')
    const tables = await tx.execute("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    for (const row of tables.rows) {
        if (typeof row.sql === 'string') {
            if (sqlTokens(row.sql).some(token => !token.literal && token.value.toLowerCase() === 'virtual')) throw new Error('Virtual tables are unavailable in desktop data tools.')
            if (!/^(?:sqlite_|_rerun_)/i.test(String(row.name))) assertNoHiddenTables(row.sql, [])
            assertSafeFunctions(row.sql)
        }
    }
}

export async function desktopQuery(client: Client, sql: string, params: SqlParam[], limit: number, hidden: string[]) {
    const statement = singleStatement(sql)
    assertReadOnlySql(statement)
    assertNoHiddenTables(statement, hidden)
    assertNoPragma(statement)
    assertSafeFunctions(statement)
    const cap = Math.min(200, Math.max(1, Math.floor(limit)))
    const tx = await client.transaction('read')
    try {
        // libsql's local transaction owns a detached connection. query_only therefore does not
        // toggle the pooled writer, and SQLite itself refuses mutations in addition to our guard.
        await tx.execute('PRAGMA query_only = ON')
        await assertPlainDataSchema(tx)
        const result = await tx.execute({ sql: `SELECT * FROM (\n${statement}\n) LIMIT ${cap + 1}`, args: params })
        const rows = result.rows.slice(0, cap).map(row => serializeRow(result.columns, row))
        return { rows, truncated: result.rows.length > cap }
    } finally { try { await tx.rollback() } finally { tx.close() } }
}

export async function desktopExecute(client: Client, statements: { sql: string; params: SqlParam[] }[], hidden: string[], beforeCommit: () => Promise<void>, creator?: string) {
    if (!statements.length || statements.length > 100) throw new Error('Provide 1–100 statements.')
    const checked = statements.map(item => {
        const sql = singleStatement(item.sql)
        assertNoHiddenTables(sql, hidden)
        assertNoPragma(sql)
        assertExplicitWrite(sql)
        return { sql, args: item.params }
    })
    return withBusyRetry(async () => {
        const tx = await client.transaction('write')
        try {
            await assertPlainDataSchema(tx)
            let rowsAffected = 0, lastInsertRowid: string | null = null
            for (const item of checked) {
                const result = await tx.execute(item)
                rowsAffected += result.rowsAffected
                lastInsertRowid = result.lastInsertRowid?.toString() ?? null
            }
            // Advisory shared metadata is in the same isolated transaction. Never perform its
            // SQL back on the engine's event loop after a commit acknowledgement.
            if (creator !== undefined) await recordTableOwnership(tx as unknown as Client, checked.map(item => item.sql), creator)
            await beforeCommit()
            await tx.commit()
            return { statements: checked.length, rowsAffected, lastInsertRowid: checked.length === 1 ? lastInsertRowid : null }
        } catch (error) { await tx.rollback().catch(() => {}); throw error }
        finally { tx.close() }
    })
}

export async function desktopSchema(client: Client, hidden: string[]): Promise<string> {
    const tx = await client.transaction('read')
    try {
        await tx.execute('PRAGMA query_only = ON')
        await assertPlainDataSchema(tx)
        const tables = (await listTables(tx as unknown as Client, hidden)).filter(table => !/^(?:sqlite_|_rerun_)/i.test(table.name))
        return formatSchema(tables, { maxTables: 40, maxChars: 8_000, more: count => `[Schema truncated: ${count} more tables]` })
    } finally { try { await tx.rollback() } finally { tx.close() } }
}
