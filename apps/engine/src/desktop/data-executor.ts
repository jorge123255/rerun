import { fork } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { CARD_MAX_CELL_CHARS, CARD_MAX_COLUMNS, CARD_MAX_GROUPS, CARD_MAX_MEDIA_CHARS, CARD_MAX_ROWS, tableCardSchema, type TableCard } from '@rerun/contracts'

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
    // A card names a saved view, never SQL: the worker resolves it and freezes the rows it draws.
    z.object({
        kind: z.literal('card'),
        table: z.string().min(1).max(200),
        view: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(CARD_MAX_ROWS).optional(),
        hidden,
        /** Where an absolute image cell is made relative: this coworker's Files, or the shared space. */
        workspace: z.string().min(1).max(4096),
    }).strict(),
])
export type DataOperation = z.infer<typeof dataOperationSchema>
export type DataCardOperation = Extract<DataOperation, { kind: 'card' }>
export type DataQueryResult = { rows: Record<string, unknown>[]; truncated: boolean }
export type DataWriteResult = { statements: number; rowsAffected: number; lastInsertRowid: string | null }
export type DataCardResult = TableCard
export type DataResult = DataQueryResult | DataWriteResult | DataCardResult | string
type Identity = { dev: string; ino: string }
export type DataFilePin = { file: string; parent: Identity; identity: Identity }
const identity = (stat: { dev: bigint; ino: bigint }): Identity => ({ dev: String(stat.dev), ino: String(stat.ino) })
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino

async function safeDataDirectory(root: string, file: string, create: boolean): Promise<string> {
    const rootPath = resolve(root)
    const rel = relative(rootPath, resolve(file))
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Database is outside its data root.')
    const rootStat = await lstat(rootPath)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Unsafe database root.')
    const canonicalRoot = await realpath(rootPath)
    let current = canonicalRoot
    const parts = rel.split(sep)
    for (const part of parts.slice(0, -1)) {
        current = resolve(current, part)
        if (create) await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error
        })
        const stat = await lstat(current)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe database directory.')
    }
    if (await realpath(current) !== current) throw new Error('Unsafe database directory.')
    return resolve(current, parts.at(-1)!)
}

async function verifyDataJournals(file: string): Promise<void> {
    for (const suffix of ['-wal', '-shm', '-journal']) {
        const sidecar = await lstat(file + suffix, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null
            throw error
        })
        if (sidecar && (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1n)) throw new Error('Unsafe database journal.')
    }
}

/** Filesystem-only preflight, before ANY SQLite initializer. Human route getClient callbacks
 * must call this before getAgentDb/getSharedDb. Model tools call it through executeDesktopData,
 * then initialize SQLite only inside the killable child. Existing paths/schema are unchanged. */
export async function prepareDesktopDataFile(root: string, file: string): Promise<DataFilePin> {
    const canonicalFile = await safeDataDirectory(root, file, true)
    // A dangling/malicious journal must not cause even an empty database to be created first.
    await verifyDataJournals(canonicalFile)
    const existing = await lstat(canonicalFile, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
    })
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1n)) throw new Error('Unsafe database file.')
    if (!existing) {
        const handle = await open(canonicalFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
            .catch((error: NodeJS.ErrnoException) => { if (error.code === 'EEXIST') return null; throw error })
        await handle?.close()
    }
    return pinDesktopDataFile(root, file)
}

/** Pin an already existing safe file without opening SQLite or following an alias. */
export async function pinDesktopDataFile(root: string, file: string): Promise<DataFilePin> {
    const canonicalFile = await safeDataDirectory(root, file, false)
    const stat = await lstat(canonicalFile, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('Unsafe database file.')
    const pin = { file: canonicalFile, parent: identity(await lstat(dirname(canonicalFile), { bigint: true })), identity: identity(stat) }
    await verifyDesktopDataFile(pin)
    return pin
}

export async function verifyDesktopDataFile(pin: DataFilePin): Promise<void> {
    const parent = await lstat(dirname(pin.file), { bigint: true })
    const file = await lstat(pin.file, { bigint: true })
    if (!parent.isDirectory() || parent.isSymbolicLink() || !same(identity(parent), pin.parent) ||
        !file.isFile() || file.isSymbolicLink() || file.nlink !== 1n || !same(identity(file), pin.identity) ||
        await realpath(pin.file) !== pin.file) throw new Error('The database file changed. Try again.')
    await verifyDataJournals(pin.file)
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
    databaseKind?: 'private' | 'shared'
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
    const pin = await prepareDesktopDataFile(root, file)
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
                const result = readWorkerResult(operation, msg.result)
                if (result === undefined || (operation.kind === 'execute' && !permitted)) { stop('Invalid database worker result.'); return }
                outcome = result
                return
            }
            stop('Invalid database worker message.')
        })
        child.send({ type: 'start', pin, operation, databaseKind: options.databaseKind ?? 'private' }, error => { if (error) stop('Could not start database operation.') })
    })
}

const queryResultSchema = z.object({ rows: z.array(z.record(z.string(), z.unknown())).max(200), truncated: z.boolean() }).strict()
const writeResultSchema = z.object({ statements: z.number().int().min(1).max(100), rowsAffected: z.number().int().nonnegative(), lastInsertRowid: z.string().nullable() }).strict()

/** The renderer's own bounds: a card is replayed into later model context, so the parent refuses
 * one that is larger than the layouts can draw rather than passing it through. */
function boundedCard(card: TableCard): boolean {
    if (!Number.isInteger(card.total) || card.total < 0) return false
    if (card.rows.length > CARD_MAX_ROWS || card.columns.length > CARD_MAX_COLUMNS) return false
    if ((card.groups?.length ?? 0) > CARD_MAX_GROUPS) return false
    const formats = card.formats ?? {}
    const media = new Set([card.fields?.image, ...Object.entries(formats).filter(([, format]) => format === 'image' || format === 'url').map(([column]) => column)].filter((column): column is string => !!column))
    return card.rows.every(row => Object.entries(row).every(([column, value]) =>
        card.columns.includes(column) && (typeof value !== 'string' || value.length <= (media.has(column) ? CARD_MAX_MEDIA_CHARS : CARD_MAX_CELL_CHARS))))
}

function readWorkerResult(operation: DataOperation, value: unknown): DataResult | undefined {
    if (operation.kind === 'query') {
        const parsed = queryResultSchema.safeParse(value)
        return parsed.success ? parsed.data : undefined
    }
    if (operation.kind === 'execute') {
        const parsed = writeResultSchema.safeParse(value)
        return parsed.success ? parsed.data : undefined
    }
    if (operation.kind === 'card') {
        const parsed = tableCardSchema.safeParse(value)
        return parsed.success && boundedCard(parsed.data) ? parsed.data : undefined
    }
    const parsed = z.string().max(8_100).safeParse(value)
    return parsed.success ? parsed.data : undefined
}
