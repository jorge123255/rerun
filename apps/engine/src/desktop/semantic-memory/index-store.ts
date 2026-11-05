import { constants } from 'node:fs'
import { lstat, mkdir, open, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { DESKTOP_SEMANTIC_STORE_BYTES_MAX, type DesktopSemanticIndexStore, type DesktopSemanticOwnerIndex, type DesktopSemanticPendingWork, type DesktopSemanticIndexRecord } from '@rerun/contracts'
import { desktopSemanticLocalId } from './identity.js'
import { desktopSemanticVector } from './vectors.js'

export class DesktopSemanticStorageError extends Error {
    constructor() {
        super('Semantic index storage limit')
        this.name = 'DesktopSemanticStorageError'
    }
}

export function emptyDesktopSemanticOwnerIndex(): DesktopSemanticOwnerIndex {
    return { generation: '', revoke: 0, invalid: false, records: [], pending: [] }
}

function copyRecord(record: DesktopSemanticIndexRecord): DesktopSemanticIndexRecord {
    return { ...record, vector: [...record.vector] }
}

function copyJob(job: DesktopSemanticPendingWork): DesktopSemanticPendingWork {
    return { ...job }
}

export function copyDesktopSemanticOwnerIndex(index: DesktopSemanticOwnerIndex): DesktopSemanticOwnerIndex {
    return {
        generation: index.generation,
        revoke: index.revoke,
        invalid: index.invalid,
        records: index.records.map(copyRecord),
        pending: index.pending.map(copyJob),
    }
}

export function desktopSemanticIndexBytes(index: DesktopSemanticOwnerIndex): number {
    let bytes = index.generation.length + 32
    for (const record of index.records) bytes += record.noteId.length + record.contentFingerprint.length + record.backendFingerprint.length + record.vector.length * 8
    for (const job of index.pending) bytes += job.noteId.length + job.contentFingerprint.length + job.backendFingerprint.length + job.generation.length + 16
    return bytes
}

function queue<T>(chain: { current: Promise<unknown> }, work: () => Promise<T> | T): Promise<T> {
    const next = chain.current.then(work, work)
    chain.current = next.then(() => undefined, () => undefined)
    return next
}

export function createMemorySemanticIndexStore(): DesktopSemanticIndexStore {
    const owners = new Map<string, DesktopSemanticOwnerIndex>()
    const chain = { current: Promise.resolve() }
    return {
        read: ownerId => queue(chain, () => {
            if (!desktopSemanticLocalId(ownerId)) return null
            const found = owners.get(ownerId)
            return found ? copyDesktopSemanticOwnerIndex(found) : null
        }),
        write: (ownerId, next) => queue(chain, () => {
            if (!desktopSemanticLocalId(ownerId)) throw new DesktopSemanticStorageError()
            const copy = copyDesktopSemanticOwnerIndex(next)
            if (desktopSemanticIndexBytes(copy) > DESKTOP_SEMANTIC_STORE_BYTES_MAX) throw new DesktopSemanticStorageError()
            owners.set(ownerId, copy)
        }),
        listOwnerIds: () => queue(chain, () => [...owners.keys()]),
    }
}

type FileDocument = { version: 1; invalid: boolean; owners: Record<string, DesktopSemanticOwnerIndex> }

const FILE_NAME = 'semantic-index.json'

function emptyDocument(): FileDocument {
    return { version: 1, invalid: false, owners: Object.create(null) as Record<string, DesktopSemanticOwnerIndex> }
}

function recordOf(value: unknown): DesktopSemanticIndexRecord | null {
    if (!value || typeof value !== 'object') return null
    const record = value as Partial<DesktopSemanticIndexRecord>
    if (typeof record.noteId !== 'string' || !desktopSemanticLocalId(record.noteId)) return null
    if (typeof record.contentFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.contentFingerprint)) return null
    if (typeof record.backendFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.backendFingerprint)) return null
    if (typeof record.dimensions !== 'number') return null
    const vector = desktopSemanticVector(record.vector, record.dimensions)
    if (!vector) return null
    return { noteId: record.noteId, contentFingerprint: record.contentFingerprint, backendFingerprint: record.backendFingerprint, dimensions: record.dimensions, vector }
}

function jobOf(value: unknown): DesktopSemanticPendingWork | null {
    if (!value || typeof value !== 'object') return null
    const job = value as Partial<DesktopSemanticPendingWork>
    if (typeof job.noteId !== 'string' || !desktopSemanticLocalId(job.noteId)) return null
    if (typeof job.contentFingerprint !== 'string' || typeof job.generation !== 'string' || typeof job.backendFingerprint !== 'string') return null
    if (typeof job.revoke !== 'number' || typeof job.attempts !== 'number' || job.attempts < 0) return null
    return {
        noteId: job.noteId,
        contentFingerprint: job.contentFingerprint,
        generation: job.generation,
        revoke: job.revoke,
        attempts: job.attempts,
        backendFingerprint: job.backendFingerprint,
    }
}

function ownerOf(value: unknown): DesktopSemanticOwnerIndex | null {
    if (!value || typeof value !== 'object') return null
    const owner = value as Partial<DesktopSemanticOwnerIndex>
    if (typeof owner.generation !== 'string' || typeof owner.revoke !== 'number' || typeof owner.invalid !== 'boolean') return null
    if (!Array.isArray(owner.records) || !Array.isArray(owner.pending)) return null
    const records = owner.records.map(recordOf).filter((record): record is DesktopSemanticIndexRecord => record !== null)
    const pending = owner.pending.map(jobOf).filter((job): job is DesktopSemanticPendingWork => job !== null)
    return {
        generation: owner.generation,
        revoke: owner.revoke,
        invalid: owner.invalid || records.length !== owner.records.length,
        records,
        pending,
    }
}

function documentOf(value: unknown): FileDocument | null {
    if (!value || typeof value !== 'object') return null
    const document = value as Partial<FileDocument>
    if (document.version !== 1 || typeof document.invalid !== 'boolean' || !document.owners || typeof document.owners !== 'object') return null
    const owners: Record<string, DesktopSemanticOwnerIndex> = Object.create(null)
    for (const [ownerId, owner] of Object.entries(document.owners)) {
        if (!desktopSemanticLocalId(ownerId)) continue
        const parsed = ownerOf(owner)
        if (parsed) owners[ownerId] = parsed
    }
    return { version: 1, invalid: document.invalid, owners }
}

async function assertDirectory(directory: string) {
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
    })
    if (!info) {
        await mkdir(directory, { mode: 0o700 })
        return
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Semantic index directory is not a real directory')
}

async function readFileNoFollow(path: string): Promise<string | null> {
    const noFollow = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW
    const file = await open(path, constants.O_RDONLY | noFollow).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
    })
    if (!file) return null
    try {
        const stat = await file.stat()
        if (!stat.isFile()) throw new Error('Semantic index file is not a regular file')
        if (stat.size > DESKTOP_SEMANTIC_STORE_BYTES_MAX) throw new Error('Semantic index file is too large')
        return await file.readFile('utf8')
    } finally {
        await file.close()
    }
}

async function writeAtomic(directory: string, document: FileDocument) {
    const target = join(directory, FILE_NAME)
    const temporary = join(directory, `.${FILE_NAME}.${process.pid}.tmp`)
    const payload = JSON.stringify(document)
    if (Buffer.byteLength(payload) > DESKTOP_SEMANTIC_STORE_BYTES_MAX) throw new DesktopSemanticStorageError()
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600)
    try {
        await file.writeFile(payload, 'utf8')
        await file.sync()
    } finally {
        await file.close()
    }
    await rename(temporary, target)
}

export async function initializeDesktopSemanticIndex(directory: string): Promise<void> {
    await assertDirectory(directory)
    const target = join(directory, FILE_NAME)
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
    })
    if (!existing) {
        await writeAtomic(directory, emptyDocument())
        return
    }
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Semantic index file is not a regular file')
}

export function createFileSemanticIndexStore(directory: string): DesktopSemanticIndexStore {
    const chain = { current: Promise.resolve() }
    let loaded: FileDocument | null = null
    const load = async (): Promise<FileDocument> => {
        if (loaded) return loaded
        await assertDirectory(directory)
        const target = join(directory, FILE_NAME)
        try {
            const text = await readFileNoFollow(target)
            if (text === null) {
                loaded = emptyDocument()
                return loaded
            }
            const parsed = documentOf(JSON.parse(text))
            if (!parsed) throw new Error('invalid semantic index')
            loaded = parsed
            return loaded
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'ELOOP' || code === 'EISDIR') throw error
            const invalidTarget = join(directory, 'semantic-index.invalid.json')
            await rename(target, invalidTarget).catch(() => undefined)
            loaded = { version: 1, invalid: true, owners: Object.create(null) }
            return loaded
        }
    }
    return {
        read: ownerId => queue(chain, async () => {
            if (!desktopSemanticLocalId(ownerId)) return null
            const document = await load()
            const owner = document.owners[ownerId]
            if (!owner) return document.invalid ? { ...emptyDesktopSemanticOwnerIndex(), invalid: true } : null
            return copyDesktopSemanticOwnerIndex({ ...owner, invalid: owner.invalid || document.invalid })
        }),
        write: (ownerId, next) => queue(chain, async () => {
            if (!desktopSemanticLocalId(ownerId)) throw new DesktopSemanticStorageError()
            const document = await load()
            const copy = copyDesktopSemanticOwnerIndex(next)
            if (desktopSemanticIndexBytes(copy) > DESKTOP_SEMANTIC_STORE_BYTES_MAX) throw new DesktopSemanticStorageError()
            document.owners[ownerId] = copy
            document.invalid = false
            await writeAtomic(directory, document)
            loaded = document
        }),
        listOwnerIds: () => queue(chain, async () => Object.keys((await load()).owners).filter(desktopSemanticLocalId)),
    }
}
