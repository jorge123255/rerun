import { createClient } from '@libsql/client'
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { agentConfigSchema, desktopTemplateGuidedSetup } from '@rerun/contracts'
import { DESKTOP_CHAT_COMPACTIONS_SQL, migrateSystemDb } from '../../db/systemDb.js'
import { desktopScheduleOccurrenceSchema } from '../../runtime/desktop-schedule-state.js'
import { SETUP_IMPORT_RECEIPT, setupImportReceiptSchema, setupDigest } from '../setup/import-receipt.js'
import { readConfinedBytes } from './files.js'
import { sha256 } from './hash.js'
import { TemplateRequestError } from './errors.js'
import { templateHome } from './store.js'
import type { TemplateManifest } from './install.js'
import type { FidelityRecoveryRequest } from './fidelity-recovery.js'

type FileProof = { path: string; bytes: number; sourceRevision: string }
const proof = (path: string, bytes: Buffer): FileProof => ({ path, bytes: bytes.length, sourceRevision: sha256(bytes) })

/** Recognize only the two exact setup variants the initializer can derive from the capture. */
export async function initializedSetupFiles(
    folder: string, dataRoot: string, input: FidelityRecoveryRequest, member: TemplateManifest['coworkers'][number],
): Promise<FileProof[]> {
    const saved = await readConfinedBytes(folder, SETUP_IMPORT_RECEIPT, 4096)
    if (!saved.ok) throw new TemplateRequestError(409, 'Rollback could not verify the setup receipt')
    let value: unknown
    try { value = JSON.parse(saved.bytes.toString('utf8')) }
    catch { throw new TemplateRequestError(409, 'Rollback could not verify the setup receipt') }
    const receipt = setupImportReceiptSchema.safeParse(value)
    if (!receipt.success || receipt.data.engineAgentId !== input.engineAgentId || receipt.data.importReceiptId !== input.importReceiptId) {
        throw new TemplateRequestError(409, 'Rollback setup belongs to another installation')
    }
    const { agentId, engineAgentId, importReceiptId, fingerprint, state, revision: setupRevision } = receipt.data
    const { templateId, revision, agentKey } = input
    const variants = [
        { prompt: member.setup.prompt, required: member.setup.required === true },
        desktopTemplateGuidedSetup(member.setup, member.requirements),
    ]
    const setup = variants.find(({ prompt, required }) =>
        setupDigest({ agentId, engineAgentId, importReceiptId, prompt: prompt.trim(), required, templateId, revision, agentKey }) === fingerprint,
    )
    const configProof = member.files.find(file => file.path === 'config.json')
    if (!setup || !configProof) throw new TemplateRequestError(409, 'Rollback could not prove the original setup')
    const prompt = setup.prompt.trim()
    const configSetup = { required: setup.required, completedAt: null, sessionId: null }
    if (state === 'complete' && setupDigest({ required: setup.required, prompt, completedAt: null, sessionId: null }).slice(0, 24) !== setupRevision) {
        throw new TemplateRequestError(409, 'Rollback setup receipt revision changed')
    }
    const original = await readConfinedBytes(join(templateHome(dataRoot, templateId), 'revisions', revision, agentKey), 'config.json', configProof.bytes)
    if (!original.ok || original.contentRevision !== configProof.sourceRevision) throw new TemplateRequestError(409, 'Rollback original configuration changed')
    const config = agentConfigSchema.parse(JSON.parse(original.bytes.toString('utf8')))
    const generated = [
        proof(SETUP_IMPORT_RECEIPT, saved.bytes),
        proof('INSTALL.md', Buffer.from(prompt ? `${prompt}\n` : '')),
        proof('config.json', Buffer.from(`${JSON.stringify({ ...config, setup: configSetup }, null, 2)}\n`)),
    ]
    if (state === 'complete') return generated
    // The initializer writes the prompt and config separately. After a crash, each can
    // still match either the immutable capture or the exact replacement above.
    const confirmed = [generated[0]!]
    for (const file of generated.slice(1)) {
        const read = await readConfinedBytes(folder, file.path, file.bytes)
        if (read.ok && read.contentRevision === file.sourceRevision) confirmed.push(file)
    }
    return confirmed
}

const SYSTEM_DB = 'data/system.db'
const MAX_DATABASE_BYTES = 8 * 1024 * 1024
export const isFreshSystemDbFile = (path: string) =>
    path === SYSTEM_DB || path === `${SYSTEM_DB}-wal` || path === `${SYSTEM_DB}-shm`

/** A restart can initialize an empty system DB. Compare a private snapshot to the real empty schema. */
export async function emptySystemDbFiles(folder: string, paths: string[]): Promise<FileProof[]> {
    if (!paths.includes(SYSTEM_DB)) throw new TemplateRequestError(409, 'Rollback found an incomplete system database')
    const directory = await mkdtemp(join(tmpdir(), 'rerun-template-rollback-'))
    try {
        const files: FileProof[] = []
        for (const path of paths) {
            // WAL shared memory is an index, never the source of truth. The closed DB
            // and any WAL are validated as a pair. A surviving SHM is still byte-pinned
            // so cleanup cannot accept a substituted entry.
            const snapshot = await readConfinedBytes(folder, path, MAX_DATABASE_BYTES)
            if (!snapshot.ok) {
                if (path !== SYSTEM_DB && snapshot.reason === 'unsupported') {
                    const gone = await lstat(join(folder, path)).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
                    if (gone) continue
                }
                throw new TemplateRequestError(409, 'Rollback could not safely inspect the system database')
            }
            files.push(proof(path, snapshot.bytes))
            // SQLite reconstructs the shared-memory index from the verified WAL in the snapshot.
            if (!path.endsWith('-shm')) await writeFile(join(directory, path.slice('data/'.length)), snapshot.bytes, { mode: 0o600 })
        }
        const actual = createClient({ url: `file:${join(directory, 'system.db')}` })
        try {
            const empty = createClient({ url: ':memory:' })
            try {
                await migrateSystemDb(empty, ':memory:')
                await empty.execute(DESKTOP_CHAT_COMPACTIONS_SQL)
                await empty.executeMultiple(desktopScheduleOccurrenceSchema)
                const describe = 'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name LIMIT 512'
                const expected = (await empty.execute(describe)).rows
                const observed = (await actual.execute(describe)).rows
                const version = async (db: typeof actual) => (await db.execute('PRAGMA user_version')).rows[0]?.user_version
                if (observed.length >= 512 || await version(actual) !== await version(empty)) {
                    throw new TemplateRequestError(409, 'Rollback could not verify the system database schema')
                }
                for (const item of observed) {
                    const same = expected.find(row => row.name === item.name && row.type === item.type)
                    if (!same || !isDeepStrictEqual(Array.from(item), Array.from(same))) {
                        throw new TemplateRequestError(409, 'Rollback could not verify the system database schema')
                    }
                    if (item.type !== 'table') continue
                    const query = 'SELECT * FROM "' + String(item.name).replaceAll('"', '""') + '" LIMIT 4'
                    const rows = (await actual.execute(query)).rows.map(row => Array.from(row))
                    const baseline = (await empty.execute(query)).rows.map(row => Array.from(row))
                    if (!isDeepStrictEqual(rows, baseline)) throw new TemplateRequestError(409, 'Rollback refused because the coworker contains saved data')
                }
                // Additive desktop tables are optional before the first startup. Everything
                // from the recorded system DB migration must still be present.
                const optional = new Set(['desktop_chat_compactions', 'desktop_schedule_occurrences'])
                if (expected.some(item => !optional.has(String(item.tbl_name)) && !observed.some(row => row.name === item.name))) {
                    throw new TemplateRequestError(409, 'Rollback could not verify the system database schema')
                }
            } finally { empty.close() }
        } finally { actual.close() }
        return files
    } finally { await rm(directory, { recursive: true, force: true }) }
}
