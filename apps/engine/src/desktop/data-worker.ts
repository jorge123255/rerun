import { createClient } from '@libsql/client'
import { pathToFileURL } from 'node:url'
import { DATA_INPUT_BYTES, DATA_OUTPUT_BYTES, dataOperationSchema, verifyDesktopDataFile, type DataFilePin, type DataResult } from './data-executor.js'
import { desktopExecute, desktopQuery, desktopSchema } from './data-store.js'

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
    const msg = message as { type?: unknown; pin?: DataFilePin; operation?: unknown }
    if (msg?.type === 'commit' && waitingCommit && authorize) {
        waitingCommit = false
        authorize()
        authorize = undefined
        return
    }
    if (started || msg?.type !== 'start' || !msg.pin || Buffer.byteLength(JSON.stringify(msg)) > DATA_INPUT_BYTES + 10_000) {
        process.exit(1)
    }
    started = true
    void run(msg.pin, msg.operation)
})

async function run(pin: DataFilePin, raw: unknown) {
    let db: ReturnType<typeof createClient> | undefined
    try {
        const operation = dataOperationSchema.parse(raw)
        await verifyDesktopDataFile(pin)
        db = createClient({ url: pathToFileURL(pin.file).href })
        await db.execute('PRAGMA busy_timeout = 1000')
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
