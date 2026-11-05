import { createClient } from '@libsql/client'
import { pathToFileURL } from 'node:url'
import type { TableCard } from '@rerun/contracts'
import { DATA_INPUT_BYTES, DATA_OUTPUT_BYTES, dataOperationSchema, verifyDesktopDataFile, type DataCardOperation, type DataFilePin, type DataResult } from './data-executor.js'
import { desktopExecute, desktopQuery, desktopSchema } from './data-store.js'
import { buildTableCard } from '../tools/builtin/table-card.js'
import { findView, listViews } from '../db/tableViews.js'
import { SHARED_DB_MIGRATIONS } from '../db/sharedDb.js'
import { migrateSqlite } from '../db/ladder.js'

// No SQL, path, credential, env override, or executable comes from command-line arguments.
// The one parent-owned IPC channel supplies a validated operation and pinned existing file.
let started = false
let waitingCommit = false
let authorize: (() => void) | undefined
const send = (message: unknown) => new Promise<void>((resolve, reject) => {
    if (Buffer.byteLength(JSON.stringify(message)) > DATA_OUTPUT_BYTES) { reject(new Error('Database result exceeds its size limit.')); return }
    if (!process.send) { reject(new Error('Database parent disconnected.')); return }
    process.send(message, error => error ? reject(error) : resolve())
})
process.on('disconnect', () => process.exit(1))
process.on('message', (message: unknown) => {
    const msg = message as { type?: unknown; pin?: DataFilePin; operation?: unknown; databaseKind?: unknown }
    if (msg?.type === 'commit' && waitingCommit && authorize) {
        waitingCommit = false
        authorize()
        authorize = undefined
        return
    }
    if (started || msg?.type !== 'start' || !msg.pin || !['private', 'shared'].includes(String(msg.databaseKind)) || Buffer.byteLength(JSON.stringify(msg)) > DATA_INPUT_BYTES + 10_000) {
        process.exit(1)
    }
    started = true
    void run(msg.pin, msg.operation, msg.databaseKind === 'shared')
})

async function run(pin: DataFilePin, raw: unknown, shared: boolean) {
    let db: ReturnType<typeof createClient> | undefined
    try {
        const operation = dataOperationSchema.parse(raw)
        await verifyDesktopDataFile(pin)
        db = createClient({ url: pathToFileURL(pin.file).href })
        await db.execute('PRAGMA busy_timeout = 1000')
        // Same on-disk store and initialization as sqlStore/getSharedDb, entirely under the
        // parent's killable deadline. No uncached native initializer runs on the engine loop.
        await db.execute('PRAGMA journal_mode = WAL')
        await db.execute('PRAGMA synchronous = NORMAL')
        if (shared) await migrateSqlite(db, SHARED_DB_MIGRATIONS, pin.file)
        await verifyDesktopDataFile(pin)
        await send({ type: 'executing' })
        let result: DataResult
        if (operation.kind === 'query') {
            const queried = await desktopQuery(db, operation.sql, operation.params, operation.limit, operation.hidden)
            // Bound IPC in bytes as well as rows. A large cell never reaches the parent process.
            while (Buffer.byteLength(JSON.stringify(queried)) > 49_000 && queried.rows.length) {
                queried.rows.pop()
                queried.truncated = true
            }
            result = queried
        } else if (operation.kind === 'schema') result = await desktopSchema(db, operation.hidden)
        else if (operation.kind === 'card') result = await desktopCard(db, operation, shared)
        else result = await desktopExecute(db, operation.statements, operation.hidden, async () => {
            await verifyDesktopDataFile(pin)
            await new Promise<void>((resolve, reject) => {
                waitingCommit = true
                authorize = resolve
                void send({ type: 'ready' }).catch(reject)
            })
            await verifyDesktopDataFile(pin)
        }, operation.creator)
        await verifyDesktopDataFile(pin)
        db.close()
        db = undefined
        await send({ type: 'result', result })
        process.exit(0)
    } catch (error) {
        try { db?.close() } catch {}
        await send({ type: 'error', error: (error instanceof Error ? error.message : 'Database operation failed.').slice(0, 1000) }).catch(() => {})
        process.exit(1)
    }
}

/** Draws a saved view exactly as the app draws it. The view is addressed by name, the same way
 * the web card tool addresses it; a missing one names the real views or points at the editor
 * rather than opening a different view. */
async function desktopCard(db: ReturnType<typeof createClient>, operation: DataCardOperation, shared: boolean): Promise<TableCard> {
    const { table, view, limit, hidden, workspace } = operation
    const found = await findView(db, table, view, hidden)
    if (!found) {
        const names = (await listViews(db, table, hidden)).map(saved => saved.name)
        throw new Error(names.length
            ? `No view named "${view}" on ${table}. Its views: ${names.join(', ')}`
            : `${table} has no saved view yet. Save one in the database view editor, then pass its name in view.`)
    }
    const { id: _id, table: _table, name, position: _position, ...config } = found
    return buildTableCard(db, { ...config, scope: shared ? 'shared' : 'agent', table, view: name, ...(limit ? { limit } : {}) }, { hidden, workspace })
}
