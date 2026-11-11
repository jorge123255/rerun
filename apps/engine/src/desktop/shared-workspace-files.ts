import { constants } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { TEXT_FILE_PAGE_CHARS } from '@rerun/contracts'
import { acquireSkillLease, renameSkillEntry } from './skill-publication-native.ts'
import { SkillBoundaryError } from './skill-publication-error.ts'

// One filesystem boundary for the workspace shared folder. The desktop UI and the
// desktop shared_read / shared_list tools both call this module. Callers pass the
// engine data shared directory they already resolved. Tool arguments never choose it.
// Hosted /shared/files and apps/engine/src/files/store.ts stay on their own path.

const O_NOFOLLOW_ANY = 0x20000000
const TEXT_NAME = /\.(txt|md)$/i
const PART = /^[^/\\.\0][^/\\\0]{0,240}$/
export const SHARED_IMPORT_BYTES = 1024 * 1024
export const SHARED_LIST_LIMIT = 512
const LIST_VISIT_LIMIT = 1024
const MAX_DEPTH = 32
const MAX_WINDOW_BYTES = 8 * 1024 * 1024

export class SharedWorkspaceFileError extends Error {
    constructor(readonly status: number, message: string) {
        super(message)
        this.name = 'SharedWorkspaceFileError'
    }
}

export type SharedDirectoryEntry = { name: string; type: 'file' | 'dir'; size: number; modifiedAt: string }
export type SharedDirectoryListing = { path: string; entries: SharedDirectoryEntry[]; truncated: boolean }
export type SharedTextPage = { path: string; content: string; size: number; truncated: boolean; offset: number; nextOffset: number | null; editIdentity: { expectedBytes: number; expectedSha256: string } | null }
export type SharedImportResult = { path: string; name: string }
export type SharedFileAccess = { signal?: AbortSignal; beforeCommit?: () => Promise<void> | void }

type Pin = { handle: FileHandle; pinned: string; path: string; dev: bigint; ino: bigint; ctimeNs: bigint }

const outside = () => new SharedWorkspaceFileError(400, 'That path is outside the shared folder.')
const otherUser = () => new SharedWorkspaceFileError(403, 'This shared folder belongs to another user. It was left unopened.')
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR'
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError'

function currentUid(): bigint {
    if (typeof process.getuid !== 'function') throw new SharedWorkspaceFileError(400, 'Shared files are only available on this Mac.')
    return BigInt(process.getuid())
}

function throwIfAborted(signal?: AbortSignal) {
    signal?.throwIfAborted()
}

async function commit(access: SharedFileAccess | undefined) {
    throwIfAborted(access?.signal)
    await access?.beforeCommit?.()
    throwIfAborted(access?.signal)
}

function partsOf(path: string, empty: 'root' | 'reject'): string[] {
    if (typeof path !== 'string' || path.length > 4096 || /[\0\\]/.test(path) || isAbsolute(path)) throw outside()
    if (empty === 'root' && (path === '' || path === '.')) return []
    const parts = path.split('/')
    if (!parts.length || parts.length > MAX_DEPTH || parts.some(part => !PART.test(part))) throw outside()
    return parts
}

function contained(root: string, target: string) {
    const rel = relative(root, target)
    if (rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return
    throw outside()
}

function mapFs(error: unknown, folder = false): SharedWorkspaceFileError {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return new SharedWorkspaceFileError(404, folder ? 'Folder not found' : 'File not found')
    if (code === 'ELOOP') return outside()
    if (code === 'EACCES' || code === 'EPERM') return otherUser()
    if (code === 'EEXIST') return new SharedWorkspaceFileError(409, 'This folder already has something with that name. The existing file was kept.')
    return new SharedWorkspaceFileError(500, 'Shared files could not be opened.')
}

function stamp(mtimeNs: bigint): string {
    return new Date(Number(mtimeNs / BigInt(1_000_000))).toISOString()
}

const ORDINARY_IMPORT_NAME = /\.(txt|md|png|jpe?g|gif|webp|wav|mp3|m4a|ogg|flac|mp4|webm|mov|m4v|pdf)$/i

function validImportName(name: string, textOnly: boolean) {
    if (!name || name.length > 255 || /[/\\\0]/.test(name) || name.startsWith('.') || !PART.test(name)) {
        throw new SharedWorkspaceFileError(400, 'That file name can’t be imported.')
    }
    if (textOnly && !TEXT_NAME.test(name)) throw new SharedWorkspaceFileError(415, 'Only .txt and .md files can be imported.')
    if (!textOnly && !ORDINARY_IMPORT_NAME.test(name)) throw new SharedWorkspaceFileError(415, 'Choose a supported shared file type.')
}

function rethrow(error: unknown, folder = false): never {
    if (isAbort(error) || error instanceof SharedWorkspaceFileError) throw error
    if (error instanceof SkillBoundaryError) throw new SharedWorkspaceFileError(error.status, 'Could not confirm the shared file change. Refresh Shared files before trying again. Existing files were preserved.')
    if (!(error as NodeJS.ErrnoException).code) throw error
    throw mapFs(error, folder)
}

async function openNoFollow(path: string, directory: boolean): Promise<FileHandle> {
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0)
    try {
        if (process.platform === 'darwin') return await open(path, flags | O_NOFOLLOW_ANY)
        if (process.platform !== 'linux') throw new SharedWorkspaceFileError(400, 'Shared files are only available on this Mac.')
        let dir = await open('/', constants.O_RDONLY | constants.O_DIRECTORY)
        try {
            const parts = path.split('/').filter(Boolean)
            for (const [index, part] of parts.entries()) {
                const next = await open(`/proc/self/fd/${dir.fd}/${part}`, constants.O_NOFOLLOW |
                    (index === parts.length - 1 ? flags : constants.O_RDONLY | constants.O_DIRECTORY))
                await dir.close()
                dir = next
            }
            return dir
        } catch (error) {
            await dir.close()
            throw error
        }
    } catch (error) {
        if (isAbort(error) || error instanceof SharedWorkspaceFileError) throw error
        if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw outside()
        throw error
    }
}

async function pinDirectory(path: string, signal?: AbortSignal): Promise<Pin> {
    throwIfAborted(signal)
    const handle = await openNoFollow(path, true)
    try {
        const info = await handle.stat({ bigint: true })
        if (!info.isDirectory()) throw outside()
        if (info.uid !== currentUid()) throw otherUser()
        const pinned = process.platform === 'darwin' ? `/.vol/${info.dev}/${info.ino}` : `/proc/self/fd/${handle.fd}`
        return { handle, pinned, path, dev: info.dev, ino: info.ino, ctimeNs: info.ctimeNs }
    } catch (error) {
        await handle.close()
        throw error
    }
}

async function assertPin(pin: Pin, entriesMayChange = false) {
    const again = await openNoFollow(pin.path, true)
    try {
        const info = await again.stat({ bigint: true })
        if (info.dev !== pin.dev || info.ino !== pin.ino || (!entriesMayChange && info.ctimeNs !== pin.ctimeNs) || info.uid !== currentUid()) throw outside()
    } finally { await again.close() }
}

function assertTrustedRoot(root: string) {
    if (!isAbsolute(root) || basename(root) !== 'shared') throw outside()
}

async function parentOfShared(root: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    assertTrustedRoot(root)
    const parent = dirname(/* turbopackIgnore: true */ root)
    const info = await lstat(parent, { bigint: true }).catch(error => {
        if (missing(error)) throw new SharedWorkspaceFileError(404, 'The shared folder is not ready.')
        throw error
    })
    if (info.isSymbolicLink() || !info.isDirectory()) throw outside()
    if (info.uid !== currentUid()) throw otherUser()
    if (await realpath(/* turbopackIgnore: true */ parent) !== parent) throw outside()
}

async function openSharedRoot(root: string, signal?: AbortSignal): Promise<Pin> {
    await parentOfShared(root, signal)
    const info = await lstat(root, { bigint: true })
    if (info.isSymbolicLink() || !info.isDirectory()) throw outside()
    if (info.uid !== currentUid()) throw otherUser()
    const pin = await pinDirectory(root, signal)
    if (pin.dev !== info.dev || pin.ino !== info.ino) {
        await pin.handle.close()
        throw outside()
    }
    return pin
}

async function ensureSharedRoot(root: string, signal?: AbortSignal): Promise<Pin> {
    await parentOfShared(root, signal)
    const existing = await lstat(root, { bigint: true }).catch(error => { if (missing(error)) return null; throw error })
    if (!existing) {
        const parent = await pinDirectory(dirname(/* turbopackIgnore: true */ root), signal)
        try {
            await mkdir(join(/* turbopackIgnore: true */ parent.pinned, 'shared'), { mode: 0o755 }).catch(error => {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            })
        } finally { await parent.handle.close() }
    }
    return openSharedRoot(root, signal)
}

async function descend(root: string, rootPin: Pin, parts: string[], signal?: AbortSignal): Promise<{ pin: Pin; close: boolean; rel: string }> {
    let pin = rootPin
    let close = false
    let rel = ''
    try { for (const part of parts) {
        throwIfAborted(signal)
        const listed = await lstat(join(/* turbopackIgnore: true */ pin.pinned, part), { bigint: true })
        if (listed.isSymbolicLink()) throw outside()
        if (!listed.isDirectory()) throw new SharedWorkspaceFileError(400, 'That path is not a folder.')
        if (listed.uid !== currentUid()) throw otherUser()
        const nextPath = join(/* turbopackIgnore: true */ root, rel, part)
        contained(root, nextPath)
        const next = await pinDirectory(nextPath, signal)
        if (next.dev !== listed.dev || next.ino !== listed.ino) {
            await next.handle.close()
            throw outside()
        }
        if (close) await pin.handle.close()
        pin = next
        close = true
        rel = rel ? `${rel}/${part}` : part
    }
    return { pin, close, rel }
    } catch (error) { if (close) await pin.handle.close(); throw error }
}

async function withRoot<T>(root: string, access: SharedFileAccess | undefined, openRoot: (root: string, signal?: AbortSignal) => Promise<Pin>, action: (rootPin: Pin) => Promise<T>, folder = false, entriesMayChange = false): Promise<T> {
    try {
        await commit(access)
        const rootPin = await openRoot(root, access?.signal)
        try {
            await commit(access)
            const result = await action(rootPin)
            await assertPin(rootPin, entriesMayChange)
            await commit(access)
            return result
        } finally { await rootPin.handle.close() }
    } catch (error) { rethrow(error, folder) }
}

/** App data root to the engine shared directory. Does not create it and does not follow a linked engine or shared folder. */
export function desktopEngineSharedDirectory(dataRoot: string): string {
    return join(/* turbopackIgnore: true */ dataRoot, 'workspaces', '1', 'engine', 'shared')
}

export async function resolveDesktopSharedDirectory(dataRoot: string, signal?: AbortSignal): Promise<string> {
    try {
        throwIfAborted(signal)
        if (!isAbsolute(dataRoot)) throw outside()
        const root = await realpath(/* turbopackIgnore: true */ dataRoot)
        const engine = join(/* turbopackIgnore: true */ root, 'workspaces', '1', 'engine')
        const info = await lstat(engine, { bigint: true }).catch(error => {
            if (missing(error)) throw new SharedWorkspaceFileError(404, 'The shared folder is not ready.')
            throw error
        })
        if (info.isSymbolicLink() || !info.isDirectory()) throw outside()
        if (info.uid !== currentUid()) throw otherUser()
        if (await realpath(/* turbopackIgnore: true */ engine) !== engine) throw outside()
        const shared = join(/* turbopackIgnore: true */ engine, 'shared')
        if (shared !== desktopEngineSharedDirectory(root)) throw outside()
        return shared
    } catch (error) { rethrow(error) }
}

/** `engineDataDir` is the engine's own data directory (`sharedDir()`'s parent), never a tool argument. */
export async function resolveEngineSharedDirectory(engineDataDir: string, signal?: AbortSignal): Promise<string> {
    try {
        throwIfAborted(signal)
        if (!isAbsolute(engineDataDir)) throw outside()
        const engine = await realpath(/* turbopackIgnore: true */ engineDataDir)
        if (engine !== engineDataDir) throw outside()
        const info = await lstat(engine, { bigint: true }).catch(error => {
            if (missing(error)) throw new SharedWorkspaceFileError(404, 'The shared folder is not ready.')
            throw error
        })
        if (info.isSymbolicLink() || !info.isDirectory()) throw outside()
        if (info.uid !== currentUid()) throw otherUser()
        return join(/* turbopackIgnore: true */ engine, 'shared')
    } catch (error) { rethrow(error) }
}

export async function listSharedDirectory(root: string, path: string, access?: SharedFileAccess): Promise<SharedDirectoryListing> {
    let rel = ''
    try { rel = partsOf(path, 'root').join('/'); assertTrustedRoot(root) }
    catch (error) { rethrow(error, true) }
    const present = await lstat(root, { bigint: true }).catch(error => { if (missing(error)) return null; rethrow(error, true) })
    if (!present) {
        if (rel === '') return { path: '', entries: [], truncated: false }
        throw new SharedWorkspaceFileError(404, 'Folder not found')
    }
    try {
        return await withRoot(root, access, openSharedRoot, async rootPin => {
            const child = await descend(root, rootPin, rel ? rel.split('/') : [], access?.signal)
            try {
                const entries: SharedDirectoryEntry[] = []
                let visited = 0
                let truncated = false
                for (const name of await readdir(/* turbopackIgnore: true */ child.pin.pinned)) {
                    throwIfAborted(access?.signal)
                    if (++visited > LIST_VISIT_LIMIT || entries.length >= SHARED_LIST_LIMIT) { truncated = true; break }
                    if (!PART.test(name)) continue
                    const info = await lstat(join(/* turbopackIgnore: true */ child.pin.pinned, name), { bigint: true }).catch(error => { if (missing(error)) return null; throw error })
                    if (!info || info.isSymbolicLink() || info.uid !== currentUid()) continue
                    if (info.isDirectory()) entries.push({ name, type: 'dir', size: 0, modifiedAt: stamp(info.mtimeNs) })
                    else if (info.isFile() && info.nlink === BigInt(1)) entries.push({ name, type: 'file', size: Number(info.size), modifiedAt: stamp(info.mtimeNs) })
                }
                entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
                await assertPin(child.pin)
                return { path: child.rel, entries, truncated }
            } finally { if (child.close) await child.pin.handle.close() }
        }, true)
    } catch (error) { rethrow(error, true) }
}

function decodePrefix(bytes: Uint8Array, partial: boolean): string {
    // Streaming decode retains only an incomplete final code point. Malformed bytes anywhere
    // in the window still fail; trimming an arbitrary three bytes can cut a valid earlier one.
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: partial }) }
    catch { throw new SharedWorkspaceFileError(415, 'This file must contain UTF-8 text.') }
}

export async function readSharedText(root: string, path: string, offset = 0, access?: SharedFileAccess): Promise<SharedTextPage> {
    if (!Number.isInteger(offset) || offset < 0) throw new SharedWorkspaceFileError(400, 'offset must be a non-negative integer.')
    const byteBudget = (offset + TEXT_FILE_PAGE_CHARS) * 4
    if (byteBudget > MAX_WINDOW_BYTES) throw new SharedWorkspaceFileError(413, 'This shared file is too large to read from that offset.')
    const parts = partsOf(path, 'reject')
    const name = parts[parts.length - 1]!
    if (!TEXT_NAME.test(name)) throw new SharedWorkspaceFileError(415, 'Only .txt and .md files can be read from the shared folder.')
    const rel = parts.join('/')
    return withRoot(root, access, openSharedRoot, async rootPin => {
        const child = await descend(root, rootPin, parts.slice(0, -1), access?.signal)
        let handle: FileHandle | null = null
        try {
            const listed = await lstat(join(/* turbopackIgnore: true */ child.pin.pinned, name), { bigint: true })
            if (listed.isSymbolicLink()) throw new SharedWorkspaceFileError(400, 'Choose a file, not a symlink.')
            if (!listed.isFile()) throw new SharedWorkspaceFileError(400, 'That path is not a file.')
            if (listed.nlink !== BigInt(1)) throw new SharedWorkspaceFileError(400, 'This shared file is linked elsewhere. It was left unopened.')
            if (listed.uid !== currentUid()) throw otherUser()
            const target = join(/* turbopackIgnore: true */ root, rel)
            contained(root, target)
            handle = await openNoFollow(target, false)
            const opened = await handle.stat({ bigint: true })
            if (opened.dev !== listed.dev || opened.ino !== listed.ino || opened.nlink !== BigInt(1) || opened.uid !== currentUid() || !opened.isFile()) {
                throw new SharedWorkspaceFileError(400, 'This shared file is linked elsewhere. It was left unopened.')
            }
            if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new SharedWorkspaceFileError(413, 'This shared file is too large to read from that offset.')
            const size = Number(opened.size)
            const toRead = Math.min(size, byteBudget)
            const buffer = Buffer.alloc(toRead)
            let read = 0
            while (read < toRead) {
                throwIfAborted(access?.signal)
                const chunk = await handle.read(buffer, read, toRead - read, read)
                if (!chunk.bytesRead) break
                read += chunk.bytesRead
            }
            const after = await handle.stat({ bigint: true })
            if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== BigInt(1) || after.size !== opened.size || after.ctimeNs !== opened.ctimeNs) {
                throw new SharedWorkspaceFileError(409, 'This file changed while it was being read.')
            }
            const bytes = buffer.subarray(0, read)
            if (bytes.includes(0)) throw new SharedWorkspaceFileError(415, 'This file must contain UTF-8 text.')
            const text = decodePrefix(bytes, size > read)
            if (offset > text.length && size > read) throw new SharedWorkspaceFileError(413, 'This shared file is too large to read from that offset.')
            const content = text.slice(offset, offset + TEXT_FILE_PAGE_CHARS)
            const end = offset + content.length
            const truncated = end < text.length || size > read
            await assertPin(child.pin)
            const named = await lstat(join(/* turbopackIgnore: true */ child.pin.pinned, name), { bigint: true })
            if (named.dev !== after.dev || named.ino !== after.ino || named.ctimeNs !== after.ctimeNs || named.nlink !== BigInt(1)) {
                throw new SharedWorkspaceFileError(409, 'This file changed while it was being read.')
            }
            // The edit limit is smaller than even the first read window. Hash only a
            // complete, unchanged descriptor read, never the displayed character page.
            const editIdentity = size <= 256 * 1024 && read === size
                ? { expectedBytes: size, expectedSha256: createHash('sha256').update(bytes).digest('hex') }
                : null
            return { path: rel, content, size, truncated, offset, nextOffset: truncated ? end : null, editIdentity }
        } finally {
            await handle?.close()
            if (child.close) await child.pin.handle.close()
        }
    })
}

async function mkdirChild(parent: Pin, root: string, rel: string, name: string, signal?: AbortSignal): Promise<Pin> {
    throwIfAborted(signal)
    const dest = join(/* turbopackIgnore: true */ parent.pinned, name)
    const existing = await lstat(dest, { bigint: true }).catch(error => { if (missing(error)) return null; throw error })
    if (existing) {
        if (existing.isSymbolicLink() || !existing.isDirectory()) throw new SharedWorkspaceFileError(400, 'That path is not a folder.')
        if (existing.uid !== currentUid()) throw otherUser()
    } else {
        await mkdir(dest, { mode: 0o755 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    }
    const nextPath = join(/* turbopackIgnore: true */ root, rel, name)
    contained(root, nextPath)
    const pin = await pinDirectory(nextPath, signal)
    const listed = await lstat(dest, { bigint: true })
    if (listed.isSymbolicLink() || !listed.isDirectory() || listed.uid !== currentUid() || pin.dev !== listed.dev || pin.ino !== listed.ino) {
        await pin.handle.close()
        throw outside()
    }
    return pin
}

export async function importSharedFile(root: string, folder: string, name: string, bytes: Uint8Array, access?: SharedFileAccess & { textOnly?: boolean; maxBytes?: number }): Promise<SharedImportResult> {
    const textOnly = access?.textOnly === true
    const maxBytes = access?.maxBytes ?? 16 * 1024 * 1024
    validImportName(name, textOnly)
    if (bytes.byteLength > maxBytes) throw new SharedWorkspaceFileError(413, `Files can be up to ${maxBytes} bytes.`)
    if (textOnly) {
        if (bytes.includes(0)) throw new SharedWorkspaceFileError(415, 'Only text files can be imported.')
        try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
        catch { throw new SharedWorkspaceFileError(415, 'Only text files can be imported.') }
    }
    const folders = partsOf(folder, 'root')
    const rel = folders.length ? `${folders.join('/')}/${name}` : name
    const kept = () => new SharedWorkspaceFileError(409, `This folder already has a file named “${name}”. The existing file was kept; rename yours and import it again.`)
    return withRoot(root, access, ensureSharedRoot, async rootPin => {
        const lease = await acquireSkillLease(rootPin.path, rootPin, access?.signal)
        let parent = rootPin
        let closeParent = false
        let parentRel = ''
        const guard = async () => {
            await commit(access)
            lease.assertCurrent()
            // Directory entry changes are our own normal writes. Named inode identity and
            // no-follow ancestry still have to match before and after publication.
            await assertPin(rootPin, true)
            await assertPin(parent, true)
        }
        try {
            await guard()
            for (const part of folders) {
                await guard()
                const next = await mkdirChild(parent, root, parentRel, part, access?.signal)
                if (closeParent) await parent.handle.close()
                parent = next
                closeParent = true
                parentRel = parentRel ? `${parentRel}/${part}` : part
            }
            await guard()
            const existing = await lstat(join(/* turbopackIgnore: true */ parent.pinned, name)).catch(error => { if (missing(error)) return null; throw error })
            if (existing) throw kept()
            if ((await readdir(/* turbopackIgnore: true */ parent.pinned)).filter(entry => entry.startsWith('.rerun-shared-import-')).length >= 128) {
                throw new SharedWorkspaceFileError(409, 'Unfinished shared imports need review before importing more files.')
            }
            const tempName = `.rerun-shared-import-${randomBytes(12).toString('hex')}`
            const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === 'darwin' ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW)
            const tempLexical = join(/* turbopackIgnore: true */ parent.path, tempName)
            contained(root, tempLexical)
            const handle = process.platform === 'darwin'
                ? await open(tempLexical, flags, 0o644)
                : await open(join(/* turbopackIgnore: true */ parent.pinned, tempName), flags, 0o644)
            let publicationAttempted = false
            let identity: { dev: bigint; ino: bigint } | undefined
            try {
                const opened = await handle.stat({ bigint: true })
                identity = opened
                const listed = await lstat(join(/* turbopackIgnore: true */ parent.pinned, tempName), { bigint: true })
                if (opened.dev !== listed.dev || opened.ino !== listed.ino || opened.nlink !== BigInt(1) || opened.uid !== currentUid()) throw outside()
                await handle.writeFile(bytes)
                await handle.sync()
                const written = await handle.stat({ bigint: true })
                if (written.size !== BigInt(bytes.byteLength) || written.nlink !== BigInt(1) || written.dev !== opened.dev || written.ino !== opened.ino) throw outside()
                await guard()
                publicationAttempted = true
                // The bundled helper atomically moves the exact staged inode without replacing
                // an arrival. A crash cannot leave final + staging hardlinks to one document.
                try { await renameSkillEntry(parent.path, parent, tempName, opened, name) }
                catch (error) {
                    const arrival = await lstat(join(/* turbopackIgnore: true */ parent.pinned, name), { bigint: true }).catch(() => null)
                    if (arrival && (arrival.dev !== opened.dev || arrival.ino !== opened.ino)) throw kept()
                    throw error
                }
                await guard()
                const final = await lstat(join(/* turbopackIgnore: true */ parent.pinned, name), { bigint: true })
                if (final.isSymbolicLink() || !final.isFile() || final.uid !== currentUid() || final.dev !== opened.dev || final.ino !== opened.ino || final.size !== written.size || final.mtimeNs !== written.mtimeNs) throw outside()
                if (final.nlink !== BigInt(1)) {
                    throw new SharedWorkspaceFileError(400, 'This shared file is linked elsewhere. It was left unopened.')
                }
            } finally {
                await handle.close()
                // Once the helper was invoked its recovery names are authoritative. Never
                // remove a late arrival or an uncertain native-move result during cleanup.
                if (!publicationAttempted && identity) {
                    const staged = await lstat(join(/* turbopackIgnore: true */ parent.pinned, tempName), { bigint: true }).catch(() => null)
                    if (staged?.dev === identity.dev && staged.ino === identity.ino && staged.nlink === BigInt(1)) await unlink(join(/* turbopackIgnore: true */ parent.pinned, tempName)).catch(() => {})
                }
            }
            return { path: rel, name }
        } finally { if (closeParent) await parent.handle.close(); await lease.release() }
    }, false, true)
}

export async function importSharedText(root: string, folder: string, name: string, bytes: Uint8Array, access?: SharedFileAccess): Promise<SharedImportResult> {
    return importSharedFile(root, folder, name, bytes, { ...access, textOnly: true, maxBytes: SHARED_IMPORT_BYTES })
}

/** Use the same native root lock as imports and renames for a prepared write. */
export function withSharedPublicationLease<T>(root: string, signal: AbortSignal | undefined, publish: (guard: () => Promise<void>) => Promise<T>): Promise<T> {
    return withRoot(root, { signal }, openSharedRoot, async rootPin => {
        const lease = await acquireSkillLease(rootPin.path, rootPin, signal)
        const guard = async () => {
            await assertPin(rootPin, true)
            lease.assertCurrent()
        }
        try {
            await guard()
            const result = await publish(guard)
            await guard()
            return result
        } finally { await lease.release() }
    }, false, true)
}

/** Rename a listed ordinary file in the same shared directory without replacing an arrival. */
export async function renameSharedFile(root: string, path: string, nextName: string, access?: SharedFileAccess): Promise<SharedImportResult> {
    const parts = partsOf(path, 'reject')
    if (!PART.test(nextName)) throw new SharedWorkspaceFileError(400, 'Choose a file name in this folder.')
    const name = parts.pop()!
    const kept = () => new SharedWorkspaceFileError(409, 'This folder already has something with that name. The existing file was kept.')
    return withRoot(root, access, openSharedRoot, async rootPin => {
        const lease = await acquireSkillLease(rootPin.path, rootPin, access?.signal)
        try {
            const { pin, close, rel } = await descend(root, rootPin, parts, access?.signal)
            const lookup = (entry: string) => lstat(join(/* turbopackIgnore: true */ pin.pinned, entry), { bigint: true })
                .catch(error => { if (missing(error)) return null; throw error })
            const guard = async () => {
                await commit(access)
                lease.assertCurrent()
                await assertPin(rootPin, true)
                await assertPin(pin, true)
            }
            try {
                const source = await lookup(name)
                if (!source) throw new SharedWorkspaceFileError(404, 'File not found')
                if (source.isSymbolicLink() || !source.isFile()) throw new SharedWorkspaceFileError(400, 'Choose a file, not a folder or symlink.')
                if (source.uid !== currentUid()) throw otherUser()
                if (source.nlink !== BigInt(1)) throw new SharedWorkspaceFileError(400, 'This shared file is linked elsewhere. It was left unopened.')
                const matches = (entry: Awaited<ReturnType<typeof lookup>>) => entry?.dev === source.dev && entry.ino === source.ino
                if (name === nextName) return { path, name }
                const destination = await lookup(nextName)
                if (destination && (!matches(destination) || (await readdir(/* turbopackIgnore: true */ pin.pinned)).includes(nextName))) throw kept()
                await guard()
                const exact = await lookup(name)
                if (!matches(exact) || exact?.nlink !== BigInt(1) || exact.uid !== currentUid()) throw outside()

                // Case/Unicode aliases need a hop on case-insensitive disks. The intermediate
                // name is visible so an interrupted move never hides the only copy of the file.
                let from = name
                if (destination) {
                    from = `rename-recovery-${randomBytes(12).toString('hex')}${name.match(/\.[^.]+$/)?.[0]?.slice(0, 32) ?? ''}`
                    await renameSkillEntry(pin.path, pin, name, source, from)
                }
                try {
                    if (from !== name) await guard()
                    await renameSkillEntry(pin.path, pin, from, source, nextName)
                } catch (error) {
                    const occupied = await lookup(nextName)
                    if (from !== name && matches(await lookup(from))) {
                        try { await guard(); await renameSkillEntry(pin.path, pin, from, source, name) }
                        catch { throw new SharedWorkspaceFileError(409, `The rename was interrupted. Refresh Shared files to find “${from}”.`) }
                    }
                    if (occupied && !matches(occupied)) throw kept()
                    throw error
                }

                await guard()
                const names = await readdir(/* turbopackIgnore: true */ pin.pinned)
                const actual = names.find(entry => entry === nextName || entry.normalize('NFC') === nextName.normalize('NFC'))
                const final = actual ? await lookup(actual) : null
                if (!actual || !matches(final) || final?.nlink !== BigInt(1)) throw outside()
                return { path: rel ? `${rel}/${actual}` : actual, name: actual }
            } finally { if (close) await pin.handle.close() }
        } finally { await lease.release() }
    }, false, true)
}
