import { createClient } from '@libsql/client'
import { lstat, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DesktopCoworkerShareDatabasePackage } from '@rerun/contracts'
import { PORTABLE_DATABASE_RECEIPT_TABLE as RECEIPT_TABLE } from '../../db/agentDb.ts'
import { VIEWS_DDL, VIEWS_TABLE } from '../../db/tableViews.ts'
import { pinDirectory, readConfinedBytes, writeExclusiveFile } from '../templates/files.ts'
import { canonicalJson } from './hash.ts'
import { captureLogicalPrivateDatabase } from './logical-reader.ts'
import { logicalCreateTableSql } from './normalize.ts'
import { databaseRefusal, LOGICAL_DATABASE_CAPTURE_LIMITS, verifyReviewedPrivateDatabase } from './verify.ts'

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`

/** Build and verify a new local SQLite file before publishing it with a no-replace rename. */
export async function restoreScopedPrivateDatabase(input: {
    agentRoot: string
    workspaceId: number
    destinationAgentId: string
    importReceiptId: string
    pkg: DesktopCoworkerShareDatabasePackage
    assertFreshImport: () => Promise<void>
    signal?: AbortSignal
}) {
    const { pkg } = input
    verifyReviewedPrivateDatabase(pkg, {
        sourceWorkspaceId: pkg.sourceWorkspaceId, sourceAgentId: pkg.sourceAgentId,
        captureRequestId: pkg.captureRequestId, expectedDigest: pkg.digest,
    })
    const current = async () => {
        input.signal?.throwIfAborted()
        await input.assertFreshImport()
        input.signal?.throwIfAborted()
    }
    await current()
    const directory = await mkdtemp(join(tmpdir(), 'rerun-portable-database-'))
    try {
        const file = join(directory, 'install.db')
        const client = createClient({ url: pathToFileURL(file).href })
        try {
            await client.execute('PRAGMA journal_mode=DELETE')
            const tx = await client.transaction('write')
            try {
                for (const table of pkg.tables) {
                    await current()
                    await tx.execute(logicalCreateTableSql(table))
                    const columns = table.columns.map(column => column.name)
                    const sql = `INSERT INTO ${quote(table.name)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
                    for (const row of table.rows) {
                        input.signal?.throwIfAborted()
                        await tx.execute({ sql, args: columns.map(name => {
                            const value = row[name]!
                            return value && typeof value === 'object' ? Buffer.from(value.data, 'base64') : typeof value === 'boolean' ? Number(value) : value
                        }) })
                    }
                }
                if (pkg.views.length) await tx.execute(VIEWS_DDL)
                for (const view of pkg.views) {
                    input.signal?.throwIfAborted()
                    await tx.execute({
                        sql: `INSERT INTO ${VIEWS_TABLE}(id,table_name,name,position,config,updated_at) VALUES (?,?,?,?,?,?)`,
                        args: [view.id, view.table, view.name, view.position, canonicalJson(view.config), pkg.capturedAt],
                    })
                }
                await tx.execute(`CREATE TABLE ${RECEIPT_TABLE} (identity TEXT PRIMARY KEY NOT NULL)`)
                await tx.execute({
                    sql: `INSERT INTO ${RECEIPT_TABLE}(identity) VALUES (?)`,
                    args: [canonicalJson([input.workspaceId, input.destinationAgentId, input.importReceiptId, pkg.captureRequestId, pkg.digest])],
                })
                await current()
                await tx.commit()
            } catch (error) {
                await tx.rollback().catch(() => {})
                throw error
            } finally { tx.close() }

            const restored = await captureLogicalPrivateDatabase(client, { workspaceId: pkg.sourceWorkspaceId, agentId: pkg.sourceAgentId, requestId: pkg.captureRequestId })
            if (restored.digest !== pkg.digest) return databaseRefusal('The staged private database does not match the reviewed data.')
        } finally { client.close() }
        if ((await stat(file)).size > LOGICAL_DATABASE_CAPTURE_LIMITS.maxSourceBytes) return databaseRefusal('The staged private database is too large.')
        const bytes = await readFile(file)
        const pin = await pinDirectory(input.agentRoot)
        try {
            await current()
            const [named, anchored] = await Promise.all([lstat(input.agentRoot, { bigint: true }), stat(pin.pinned, { bigint: true })])
            if (named.dev !== anchored.dev || named.ino !== anchored.ino) return databaseRefusal('The unpublished coworker directory changed.')
            const noSidecars = async () => {
                for (const suffix of ['-wal', '-shm', '-journal']) {
                    const existing = await lstat(join(pin.pinned, 'data', 'agent.db' + suffix)).catch((error: NodeJS.ErrnoException) => {
                        if (error.code === 'ENOENT') return null
                        throw error
                    })
                    if (existing) return databaseRefusal('The fresh private database already has SQLite sidecars.')
                }
            }
            await noSidecars()
            await current()
            const result = await writeExclusiveFile(pin.pinned, 'data/agent.db', bytes, input.agentRoot)
            await noSidecars()
            const installed = await readConfinedBytes(pin.pinned, 'data/agent.db', bytes.byteLength, input.agentRoot)
            if (!installed.ok || !installed.bytes.equals(bytes)) return databaseRefusal('The installed private database changed.')
            await current()
            return result
        } finally { await pin.close() }
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
}
