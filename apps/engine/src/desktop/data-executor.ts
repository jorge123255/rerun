import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

export const DATA_DEADLINE_MS = 10_000
export const DATA_INPUT_BYTES = 1_000_000
export const DATA_OUTPUT_BYTES = 60_000
export class DesktopDataCommitUnknownError extends Error {
    constructor() {
        super('Database commit outcome is unknown. Read the database before retrying; do not repeat the write automatically.')
        this.name = 'DesktopDataCommitUnknownError'
    }
}

const scalar = z.union([z.string().max(50_000), z.number().finite(), z.boolean(), z.null()])
const params = z.array(scalar).max(500)
const statement = z.object({ sql: z.string().min(1).max(20_000), params }).strict()
const hidden = z.array(z.string().max(200)).max(20)
export const dataOperationSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('query'), sql: statement.shape.sql, params, limit: z.number().int().min(1).max(200), hidden }).strict(),
    z.object({ kind: z.literal('execute'), statements: z.array(statement).min(1).max(100), hidden, creator: z.string().max(200).optional() }).strict(),
    z.object({ kind: z.literal('schema'), hidden }).strict(),
])
export type DataOperation = z.infer<typeof dataOperationSchema>
export type DataQueryResult = { rows: Record<string, unknown>[]; truncated: boolean }
export type DataWriteResult = { statements: number; rowsAffected: number; lastInsertRowid: string | null }
export type DataResult = DataQueryResult | DataWriteResult | string
type Identity = { dev: string; ino: string }
export type DataFilePin = { file: string; parent: Identity; identity: Identity }
const identity = (stat: { dev: bigint; ino: bigint }): Identity => ({ dev: String(stat.dev), ino: String(stat.ino) })
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino

/** Called only after the existing parent getAgentDb/getSharedDb initialization. No model input
 * chooses a path. Refuse aliases into another database, including symlinked WAL/SHM files. */
export async function pinDesktopDataFile(root: string, file: string): Promise<DataFilePin> {
    const rootPath = resolve(root)
    const rel = relative(rootPath, resolve(file))
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Database is outside its data root.')
    const canonicalRoot = await realpath(rootPath)
    let current = canonicalRoot
    const parts = rel.split(sep)
    for (const part of parts.slice(0, -1)) {
        current = resolve(current, part)
        const stat = await lstat(current)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe database directory.')
    }
    const canonicalFile = resolve(current, parts.at(-1)!)
    const stat = await lstat(canonicalFile, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('Unsafe database file.')
    const pin = { file: canonicalFile, parent: identity(await lstat(current, { bigint: true })), identity: identity(stat) }
    await verifyDesktopDataFile(pin)
    return pin
}

export async function verifyDesktopDataFile(pin: DataFilePin): Promise<void> {
    const parent = await lstat(dirname(pin.file), { bigint: true })
    const file = await lstat(pin.file, { bigint: true })
    if (!parent.isDirectory() || parent.isSymbolicLink() || !same(identity(parent), pin.parent) ||
        !file.isFile() || file.isSymbolicLink() || file.nlink !== 1n || !same(identity(file), pin.identity) ||
        await realpath(pin.file) !== pin.file) throw new Error('The database file changed. Try again.')
    for (const suffix of ['-wal', '-shm', '-journal']) {
        const sidecar = await lstat(pin.file + suffix, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null
            throw error
        })
        if (sidecar && (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1n)) throw new Error('Unsafe database journal.')
    }
}

export function desktopDataWorkerLaunch() {
    const compiled = fileURLToPath(new URL('./data-worker.js', import.meta.url))
    const execArgv = ['--max-old-space-size=128', '--disable-proto=throw']
    if (existsSync(compiled)) return { file: compiled, execArgv }
    // Source-only development/tests use the engine's existing dev dependency. Packaged builds
    // always resolve the adjacent compiled worker and never require tsx or inherit NODE_OPTIONS.
    const source = fileURLToPath(new URL('./data-worker.ts', import.meta.url))
    const require = createRequire(import.meta.url)
    return { file: source, execArgv: [...execArgv, '--import', require.resolve('tsx')] }
}

type Options = {
    signal?: AbortSignal
    beforeCommit?: () => Promise<void>
    /** Shorter budgets and an execution observer support real child-process regressions. */
    timeoutMs?: number
    onExecuting?: () => void
}

/** SQLite's local native execute can block its event loop. A separate process lets the parent
 * kill it on Stop/deadline and reap it before releasing the coworker's lifecycle/config lock. */
export async function executeDesktopData(root: string, file: string, raw: DataOperation, options: Options = {}): Promise<DataResult> {
    options.signal?.throwIfAborted()
    const operation = dataOperationSchema.parse(raw)
    if (Buffer.byteLength(JSON.stringify(operation)) > DATA_INPUT_BYTES) throw new Error('Database input exceeds 1 MB. Use a smaller batch.')
    const pin = await pinDesktopDataFile(root, file)
    options.signal?.throwIfAborted()
    const launch = desktopDataWorkerLaunch()
    return new Promise((resolveResult, reject) => {
        const child = fork(launch.file, [], {
            execPath: process.execPath, execArgv: launch.execArgv,
            env: { NODE_ENV: 'production', TZ: 'UTC' },
            cwd: dirname(launch.file), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
        })
        let finished = false
        let permitted = false
        let ready = false
        let outcome: DataResult | undefined
        let failure: Error | undefined
        const timer = setTimeout(() => stop('Database operation exceeded its time limit.'), Math.min(DATA_DEADLINE_MS, Math.max(1, options.timeoutMs ?? DATA_DEADLINE_MS)))
        function stop(message: string) {
            if (finished) return
            if (outcome !== undefined) { child.kill('SIGKILL'); return }
            failure ??= permitted ? new DesktopDataCommitUnknownError() : new Error(message)
            child.kill('SIGKILL')
        }
        const abort = () => stop('Database operation was canceled before commit.')
        options.signal?.addEventListener('abort', abort, { once: true })
        if (options.signal?.aborted) abort()
        child.on('error', error => {
            failure ??= error
            if (!child.pid) finish(null)
            else stop('Database worker failed.')
        })
        function finish(_code: number | null) {
            if (finished) return
            finished = true
            clearTimeout(timer)
            options.signal?.removeEventListener('abort', abort)
            // A validated result is the worker's post-commit acknowledgement. A later exit
            // must not turn that known committed write into an instruction to retry it.
            if (!failure && outcome !== undefined) resolveResult(outcome)
            else reject(permitted && outcome === undefined
                ? new DesktopDataCommitUnknownError()
                : failure ?? new Error('Database worker stopped without a result.'))
        }
        child.on('exit', finish)
        child.on('message', (message: unknown) => {
            if (finished || failure || !message || typeof message !== 'object') return
            if (Buffer.byteLength(JSON.stringify(message)) > DATA_OUTPUT_BYTES) { stop('Database result exceeds its size limit.'); return }
            const msg = message as { type?: unknown; result?: unknown; error?: unknown }
            if (msg.type === 'executing') { options.onExecuting?.(); return }
            if (msg.type === 'ready' && operation.kind === 'execute' && !ready) {
                ready = true
                void (async () => {
                    try {
                        if (!options.beforeCommit) throw new Error('Database commit authorization is required.')
                        await options.beforeCommit()
                        await verifyDesktopDataFile(pin)
                        options.signal?.throwIfAborted()
                        if (finished || failure) return
                        permitted = true
                        child.send({ type: 'commit' }, error => { if (error) stop('Could not authorize database commit.') })
                    } catch (error) { stop(error instanceof Error ? error.message : 'Database commit was refused.') }
                })()
                return
            }
            if (msg.type === 'error' && typeof msg.error === 'string') { stop(msg.error.slice(0, 1000)); return }
            if (msg.type === 'result') {
                const queryResult = z.object({ rows: z.array(z.record(z.string(), z.unknown())).max(200), truncated: z.boolean() }).strict()
                const writeResult = z.object({ statements: z.number().int().min(1).max(100), rowsAffected: z.number().int().nonnegative(), lastInsertRowid: z.string().nullable() }).strict()
                const parsed = (operation.kind === 'query' ? queryResult : operation.kind === 'execute' ? writeResult : z.string().max(8_100)).safeParse(msg.result)
                if (!parsed.success || (operation.kind === 'execute' && !permitted)) { stop('Invalid database worker result.'); return }
                outcome = parsed.data
                return
            }
            stop('Invalid database worker message.')
        })
        child.send({ type: 'start', pin, operation }, error => { if (error) stop('Could not start database operation.') })
    })
}
