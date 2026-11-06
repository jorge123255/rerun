import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, dirname, basename, relative, resolve, sep } from 'node:path'
import { isDesktopTemplateRelativePath, scanPathForSecrets, type DesktopTemplateExclusionReason } from '@rerun/contracts'
import { openWithoutLinks } from '../open-without-links.js'
import { TemplateRequestError } from './errors.js'
import { sha256 } from './hash.js'
import { renameSkillEntry } from '../skill-publication-native.js'

const BINARY_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tiff',
    'pdf', 'zip', 'gz', 'tar', 'bz2', 'xz', '7z', 'rar',
    'mp3', 'mp4', 'wav', 'mov', 'avi', 'webm', 'ogg',
    'db', 'sqlite', 'sqlite3', 'wasm', 'so', 'dylib', 'dll', 'exe',
    'woff', 'woff2', 'ttf', 'otf', 'eot',
])

export function extensionOf(path: string): string {
    const name = path.split('/').pop() ?? ''
    const dot = name.lastIndexOf('.')
    return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function confinedFile(root: string, path: string): string {
    if (!isDesktopTemplateRelativePath(path)) throw new TemplateRequestError(400, 'A template path is not confined')
    const target = resolve(root, path)
    const rel = relative(root, target)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep).join('/') !== path) {
        throw new TemplateRequestError(400, 'A template path is not confined')
    }
    return target
}

export type ConfinedRead =
    | { ok: true; bytes: Buffer; text: string; inodeRevision: string; contentRevision: string }
    | { ok: false; reason: DesktopTemplateExclusionReason }

// Read one regular file without following a link. A changed identity is a collision, not a silent reread.
export async function readConfined(root: string, path: string, maxBytes: number): Promise<ConfinedRead> {
    if (!isDesktopTemplateRelativePath(path)) return { ok: false, reason: 'unsupported' }
    if (scanPathForSecrets(path).length > 0) return { ok: false, reason: 'credentials' }
    if (BINARY_EXTENSIONS.has(extensionOf(path))) return { ok: false, reason: 'binary' }
    const full = confinedFile(root, path)
    let handle
    try { handle = await openWithoutLinks(full) }
    catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return { ok: false, reason: 'unsupported' }
        return { ok: false, reason: 'link' }
    }
    try {
        const before = await handle.stat({ bigint: true })
        if (!before.isFile()) return { ok: false, reason: 'unsupported' }
        if (before.nlink !== 1n) return { ok: false, reason: 'alias' }
        if (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) return { ok: false, reason: 'unsupported' }
        if (before.size > BigInt(maxBytes)) return { ok: false, reason: 'over-limit' }
        const size = Number(before.size)
        const buffer = Buffer.alloc(size)
        let offset = 0
        while (offset < size) {
            const read = await handle.read(buffer, offset, size - offset, offset)
            if (!read.bytesRead) break
            offset += read.bytesRead
        }
        if (offset !== size) return { ok: false, reason: 'collision' }
        const after = await handle.stat({ bigint: true })
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.nlink !== 1n || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
            return { ok: false, reason: 'collision' }
        }
        const named = await lstat(full, { bigint: true })
        if (named.dev !== before.dev || named.ino !== before.ino || named.nlink !== 1n) return { ok: false, reason: 'collision' }
        const rootReal = await realpath(root)
        const fileReal = await realpath(full)
        if (fileReal !== resolve(rootReal, path)) return { ok: false, reason: 'alias' }
        if (buffer.includes(0)) return { ok: false, reason: 'binary' }
        let text: string
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
        catch { return { ok: false, reason: 'binary' } }
        return {
            ok: true,
            bytes: buffer,
            text,
            inodeRevision: sha256(`${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}`),
            contentRevision: sha256(buffer),
        }
    } finally { await handle.close() }
}

export async function pinDirectory(path: string): Promise<{ pinned: string; close: () => Promise<void> }> {
    const handle = await openWithoutLinks(path, true)
    try {
        const info = await handle.stat({ bigint: true })
        if (!info.isDirectory()) throw new TemplateRequestError(400, 'Template storage is not a directory')
        if (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) throw new TemplateRequestError(400, 'Template storage is not owned by this user')
        if ((info.mode & 0o022n) !== 0n) throw new TemplateRequestError(400, 'Template storage is too open')
        const pinned = process.platform === 'darwin' ? `/.vol/${info.dev}/${info.ino}` : `/proc/self/fd/${handle.fd}`
        return { pinned, close: () => handle.close() }
    } catch (error) {
        await handle.close()
        throw error
    }
}

export async function replaceOwnFile(directory: string, name: string, bytes: Buffer): Promise<void> {
    if (!isDesktopTemplateRelativePath(name) || name.includes('/')) throw new TemplateRequestError(400, 'Invalid template path')
    await ensurePrivateDir(directory)
    const pin = await pinDirectory(directory)
    const temporary = `.${name}.${randomBytes(6).toString('hex')}.tmp`
    try {
        const handle = await open(join(pin.pinned, temporary), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
        await rename(join(pin.pinned, temporary), join(pin.pinned, name))
    } finally { await pin.close() }
}

export async function ensurePrivateDir(path: string): Promise<void> {
    const missing: string[] = []
    let existing = resolve(path)
    for (;;) {
        try { await lstat(existing); break }
        catch(error) {
            if((error as NodeJS.ErrnoException).code !== 'ENOENT')throw error
            missing.unshift(basename(existing)); existing=dirname(existing)
        }
    }
    let pin = await pinDirectory(existing)
    try {
        for(const part of missing) {
            await mkdir(join(pin.pinned,part),{mode:0o700}).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='EEXIST')throw error})
            existing=join(existing,part)
            const next=await pinDirectory(existing)
            await pin.close();pin=next
        }
    } finally { await pin.close() }
}

export async function writeExclusiveFile(directory: string, relativeName: string, bytes: Buffer): Promise<'created' | 'same'> {
    const full = confinedFile(directory, relativeName)
    const parent = join(full, '..')
    await ensurePrivateDir(parent)
    const pin = await pinDirectory(parent)
    const name = relativeName.split('/').at(-1)!
    try {
        const existing = await lstat(join(pin.pinned, name)).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
        if (existing) {
            const read = await readConfinedBytes(directory, relativeName, bytes.length)
            if (!read.ok || !read.bytes.equals(bytes)) throw new TemplateRequestError(409, 'A template file already exists with different bytes')
            return 'same'
        }
        const temporary = `.template-${randomBytes(12).toString('hex')}`
        const handle = await open(join(pin.pinned, temporary), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        try {
            await handle.writeFile(bytes)
            await handle.sync()
            const identity = await handle.stat({ bigint: true })
            const parentIdentity = await lstat(parent, { bigint: true })
            try { await renameSkillEntry(parent, parentIdentity, temporary, identity, name) }
            catch (error) {
                const read = await readConfinedBytes(directory, relativeName, bytes.length)
                if (!read.ok || !read.bytes.equals(bytes)) throw error
                return 'same'
            }
            return 'created'
        } finally { await handle.close(); await rm(join(pin.pinned, temporary), { force: true }) }
    } finally { await pin.close() }
}

export type WalkEntry = { path: string; kind: 'file' | 'link' | 'other' }

// Directory links are recorded and not entered. The walk stops at maxEntries.
export async function walkConfined(root: string, directory: string, maxEntries: number): Promise<{ entries: WalkEntry[]; truncated: boolean }> {
    const entries: WalkEntry[] = []
    let truncated = false
    let visited = 0
    const visit = async (relativeDir: string): Promise<void> => {
        if (truncated) return
        const full = relativeDir ? confinedFile(root, relativeDir) : root
        const info = await lstat(full).catch(() => null)
        if (!info || info.isSymbolicLink() || !info.isDirectory()) return
        const children = await readdir(full, { withFileTypes: true })
        for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
            if (++visited > maxEntries) { truncated = true; return }
            const path = relativeDir ? `${relativeDir}/${child.name}` : child.name
            if (!isDesktopTemplateRelativePath(path)) { entries.push({ path: child.name || path, kind: 'other' }); continue }
            if (child.isSymbolicLink()) entries.push({ path, kind: 'link' })
            else if (child.isDirectory()) await visit(path)
            else if (child.isFile()) entries.push({ path, kind: 'file' })
            else entries.push({ path, kind: 'other' })
        }
    }
    await visit(directory)
    return { entries, truncated }
}


export type ConfinedBytesRead =
    | { ok: true; bytes: Buffer; inodeRevision: string; contentRevision: string; binary: boolean; textScanned: boolean; text: string | null }
    | { ok: false; reason: DesktopTemplateExclusionReason }

function asciiFold(value: string): string {
    return value.normalize('NFKC').toLowerCase()
}

export function collidingRelativePaths(paths: string[]): string | null {
    const seen = new Map<string, string>()
    for (const path of paths) {
        if (!isDesktopTemplateRelativePath(path)) return path
        const folded = path.split('/').map(asciiFold).join('/')
        const prior = seen.get(folded)
        if (prior && prior !== path) return path
        seen.set(folded, path)
    }
    return null
}

export function isBinaryPath(path: string): boolean {
    return BINARY_EXTENSIONS.has(extensionOf(path))
}

// Byte-faithful confined read. Binary files are allowed; they are never presented as text-scanned.
export async function readConfinedBytes(root: string, path: string, maxBytes: number): Promise<ConfinedBytesRead> {
    if (!isDesktopTemplateRelativePath(path)) return { ok: false, reason: 'unsupported' }
    if (scanPathForSecrets(path).length > 0) return { ok: false, reason: 'credentials' }
    const full = confinedFile(root, path)
    let handle
    try { handle = await openWithoutLinks(full) }
    catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return { ok: false, reason: 'unsupported' }
        return { ok: false, reason: 'link' }
    }
    try {
        const before = await handle.stat({ bigint: true })
        if (!before.isFile()) return { ok: false, reason: 'unsupported' }
        if (before.nlink !== 1n) return { ok: false, reason: 'alias' }
        if (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) return { ok: false, reason: 'unsupported' }
        if (before.size > BigInt(maxBytes)) return { ok: false, reason: 'over-limit' }
        const size = Number(before.size)
        const buffer = Buffer.alloc(size)
        let offset = 0
        while (offset < size) {
            const read = await handle.read(buffer, offset, size - offset, offset)
            if (!read.bytesRead) break
            offset += read.bytesRead
        }
        if (offset !== size) return { ok: false, reason: 'collision' }
        const after = await handle.stat({ bigint: true })
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.nlink !== 1n || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
            return { ok: false, reason: 'collision' }
        }
        const named = await lstat(full, { bigint: true })
        if (named.dev !== before.dev || named.ino !== before.ino || named.nlink !== 1n) return { ok: false, reason: 'collision' }
        const rootReal = await realpath(root)
        const fileReal = await realpath(full)
        if (fileReal !== resolve(rootReal, path)) return { ok: false, reason: 'alias' }
        const looksBinary = isBinaryPath(path) || buffer.includes(0)
        let text: string | null = null
        let textScanned = false
        if (!looksBinary) {
            try {
                text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
                textScanned = true
            } catch {
                return {
                    ok: true,
                    bytes: buffer,
                    inodeRevision: sha256(`${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}`),
                    contentRevision: sha256(buffer),
                    binary: true,
                    textScanned: false,
                    text: null,
                }
            }
        }
        return {
            ok: true,
            bytes: buffer,
            inodeRevision: sha256(`${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}`),
            contentRevision: sha256(buffer),
            binary: looksBinary,
            textScanned,
            text,
        }
    } finally { await handle.close() }
}

export async function writeExclusiveBytes(directory: string, relativeName: string, bytes: Buffer): Promise<'created' | 'same'> {
    return writeExclusiveFile(directory, relativeName, bytes)
}

// Reads key names only. Values never leave this helper or enter plans/receipts.
export async function readEnvironmentKeyNames(root: string): Promise<string[]> {
    const full = confinedFile(root, '.env')
    let handle
    try { handle = await openWithoutLinks(full) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new TemplateRequestError(409, 'Environment names cannot be read from a linked file') }
    try {
        const before = await handle.stat({ bigint: true })
        if (!before.isFile() || before.nlink !== 1n || before.size > 65536n || typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) throw new TemplateRequestError(409, 'Environment names require a bounded owned file')
        const bytes = Buffer.alloc(Number(before.size)); let offset = 0
        while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead }
        const after = await handle.stat({ bigint: true }), current = await lstat(full, { bigint: true })
        if (offset !== bytes.length || before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size || after.nlink !== 1n || current.dev !== before.dev || current.ino !== before.ino) throw new TemplateRequestError(409, 'Environment file changed during name capture')
        const names = new Set<string>()
        try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            for (const line of text.split(/\r?\n/)) { const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]{0,127})\s*=/.exec(line); if (match) names.add(match[1]) }
        } catch { throw new TemplateRequestError(409, 'Environment names are not UTF-8') }
        finally { bytes.fill(0) }
        if (names.size > 100) throw new TemplateRequestError(413, 'Too many environment requirements')
        return [...names].sort()
    } finally { await handle.close() }
}
