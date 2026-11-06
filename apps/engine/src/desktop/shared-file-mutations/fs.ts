import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { importSharedText, listSharedDirectory, readSharedText, SharedWorkspaceFileError, type SharedFileAccess } from '../shared-workspace-files.js'

// Create, exact edit, and search under an already resolved shared root.
// The root is `<dataRoot>/workspaces/<id>/engine/shared`. Callers pass that directory.
// This module does not read the workspace catalog and does not open private coworker files.

const O_NOFOLLOW_ANY = 0x20000000
const PART = /^[^/\\.\0][^/\\\0]{0,240}$/
const TEXT_NAME = /\.(txt|md)$/i
const MAX_BYTES = 256 * 1024
const MAX_DEPTH = 8
const MAX_FILES = 200
const MAX_LINE = 4_000
const SNIPPET = 300
const SKIP_DIRS = new Set(['node_modules', '.git'])

export class SharedMutationError extends Error {
    constructor(readonly code: 'outside' | 'symlink' | 'malformed' | 'oversized' | 'uncertain' | 'root_replaced' | 'cancelled', message: string) {
        super(message)
        this.name = 'SharedMutationError'
    }
}

export type SharedWriteOutcome = {
    status: 'saved' | 'refused'
    path: string
    message: string
    code?: 'exists' | 'outside' | 'symlink' | 'malformed' | 'oversized'
    bytes?: number
    sha256?: string
    committed: boolean
}

export type SharedEditOutcome = {
    status: 'saved' | 'unchanged' | 'refused'
    path: string
    message: string
    code?: 'conflict' | 'not_found' | 'outside' | 'symlink' | 'malformed' | 'oversized'
    bytes?: number
    sha256?: string
    occurrences?: number
    committed: boolean
}

export type SharedSearchHit = { path: string; line: number; text: string }
export type SharedSearchOutcome = {
    hits: SharedSearchHit[]
    truncated: boolean
    omitted: { path: string; reason: 'too-large' | 'binary' | 'unreadable' }[]
}

const outside = () => new SharedMutationError('outside', 'That path is outside the shared folder.')
const uid = () => {
    if (typeof process.getuid !== 'function') throw new SharedMutationError('outside', 'Shared files are only available on this Mac.')
    return BigInt(process.getuid())
}

export function canonicalSharedRoot(dataRoot: string, workspaceId: number): string {
    if (!Number.isInteger(workspaceId) || workspaceId < 1 || workspaceId > 1_000_000) throw new SharedMutationError('root_replaced', 'That workspace is not the open workspace.')
    return join(dataRoot, 'workspaces', String(workspaceId), 'engine', 'shared')
}

export async function assertCanonicalSharedRoot(dataRoot: string, workspaceId: number, sharedRoot: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const root = await realpath(dataRoot)
    const expected = canonicalSharedRoot(root, workspaceId)
    const actual = await realpath(sharedRoot).catch(() => { throw new SharedMutationError('root_replaced', 'The shared folder was replaced.') })
    if (actual !== expected) throw new SharedMutationError('root_replaced', 'The shared folder does not belong to this workspace.')
    const info = await lstat(actual, { bigint: true })
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid()) throw new SharedMutationError('root_replaced', 'The shared folder was replaced.')
    return actual
}

function partsOf(path: string, kind: 'file' | 'directory'): string[] {
    if (typeof path !== 'string' || path.length > 4096 || /[\0\\]/.test(path) || isAbsolute(path)) throw outside()
    if (kind === 'directory' && (path === '' || path === '.')) return []
    const parts = path.split('/')
    if (!parts.length || parts.length > 32 || parts.some(part => !PART.test(part) || SKIP_DIRS.has(part))) throw outside()
    if (kind === 'file' && !TEXT_NAME.test(parts[parts.length - 1] ?? '')) throw new SharedMutationError('malformed', 'Only .txt and .md files can be changed in the shared folder.')
    return parts
}

function contained(root: string, target: string) {
    const rel = relative(root, target)
    if (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return
    throw outside()
}

function hashOf(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
}

function textBytes(content: string, label: string): Buffer {
    if (typeof content !== 'string') throw new SharedMutationError('malformed', `${label} must be text.`)
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) throw new SharedMutationError('malformed', 'Only UTF-8 text can be saved in the shared folder.')
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.byteLength > MAX_BYTES) throw new SharedMutationError('oversized', 'Shared text files can be up to 256 KiB.')
    try {
        if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) !== content) throw new Error('roundtrip')
    } catch { throw new SharedMutationError('malformed', 'Only UTF-8 text can be saved in the shared folder.') }
    return bytes
}

const noFollow = () => constants.O_RDWR | (process.platform === 'darwin' ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW)

async function ownedFile(root: string, parts: string[], signal?: AbortSignal): Promise<{ target: string; rel: string }> {
    signal?.throwIfAborted()
    if (!isAbsolute(root) || root.split(sep).at(-1) !== 'shared') throw outside()
    let current = root
    for (const part of parts.slice(0, -1)) {
        signal?.throwIfAborted()
        const next = join(current, part)
        contained(root, next)
        const info = await lstat(next, { bigint: true }).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SharedMutationError('outside', 'Folder not found')
            throw error
        })
        if (info.isSymbolicLink()) throw new SharedMutationError('symlink', 'Choose a folder, not a symlink.')
        if (!info.isDirectory() || info.uid !== uid()) throw outside()
        if (await realpath(next) !== next) throw new SharedMutationError('symlink', 'Choose a folder, not a symlink.')
        current = next
    }
    const target = join(current, parts[parts.length - 1]!)
    contained(root, target)
    return { target, rel: parts.join('/') }
}

export async function createSharedDocument(root: string, path: string, content: string, access?: SharedFileAccess): Promise<SharedWriteOutcome> {
    const parts = partsOf(path, 'file')
    const bytes = textBytes(content, 'content')
    const rel = parts.join('/')
    const target = join(root, rel)
    contained(root, target)
    const name = parts[parts.length - 1]!
    const existing = await lstat(target).catch(error => ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR' ? null : Promise.reject(error)))
    if (existing?.isSymbolicLink()) return { status: 'refused', path: rel, code: 'symlink', message: 'Choose a file, not a symlink. Nothing was written.', committed: false }
    if (existing) return { status: 'refused', path: rel, code: 'exists', message: `This folder already has a file named “${name}”. The existing file was kept.`, committed: false }
    access?.signal?.throwIfAborted()
    await access?.beforeCommit?.()
    access?.signal?.throwIfAborted()
    const folder = parts.slice(0, -1).join('/')
    try {
        const saved = await importSharedText(root, folder, name, bytes, access)
        const written = await readFile(join(root, saved.path))
        if (!written.equals(bytes)) throw new SharedMutationError('uncertain', 'The shared file write was not confirmed. It will not be repeated.')
        return { status: 'saved', path: saved.path, message: `Wrote ${bytes.byteLength} bytes to ${saved.path}`, bytes: bytes.byteLength, sha256: hashOf(bytes), committed: true }
    } catch (error) {
        const now = await readFile(target).catch(() => null)
        if (now?.equals(bytes)) return { status: 'saved', path: rel, message: `Wrote ${bytes.byteLength} bytes to ${rel}`, bytes: bytes.byteLength, sha256: hashOf(bytes), committed: true }
        if (error instanceof SharedMutationError) throw error
        if (error instanceof SharedWorkspaceFileError && error.status === 409) {
            return { status: 'refused', path: rel, code: 'exists', message: error.message, committed: false }
        }
        if (access?.signal?.aborted) throw new SharedMutationError('uncertain', 'The shared file write was not confirmed. It will not be repeated.')
        throw error
    }
}

export async function editSharedDocument(root: string, input: { path: string; oldString: string; newString: string; replaceAll?: boolean; expectedBytes: number; expectedSha256: string }, access?: SharedFileAccess): Promise<SharedEditOutcome> {
    const parts = partsOf(input.path, 'file')
    const { target, rel } = await ownedFile(root, parts, access?.signal)
    const listed = await lstat(target, { bigint: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    })
    if (!listed) return { status: 'refused', path: rel, code: 'not_found', message: `File not found: ${rel}`, committed: false }
    if (listed.isSymbolicLink()) return { status: 'refused', path: rel, code: 'symlink', message: 'Choose a file, not a symlink. Nothing was written.', committed: false }
    if (!listed.isFile() || listed.nlink !== BigInt(1) || listed.uid !== uid()) throw outside()
    if (listed.size > BigInt(MAX_BYTES)) return { status: 'refused', path: rel, code: 'oversized', message: 'Shared text files can be up to 256 KiB.', committed: false }
    const handle = await open(target, noFollow()).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new SharedMutationError('symlink', 'Choose a file, not a symlink. Nothing was written.')
        throw error
    })
    try {
        const opened = await handle.stat({ bigint: true })
        if (opened.dev !== listed.dev || opened.ino !== listed.ino || opened.nlink !== BigInt(1) || !opened.isFile() || opened.uid !== uid()) throw outside()
        const size = Number(opened.size)
        const current = Buffer.alloc(size)
        let read = 0
        while (read < size) {
            access?.signal?.throwIfAborted()
            const chunk = await handle.read(current, read, size - read, read)
            if (!chunk.bytesRead) break
            read += chunk.bytesRead
        }
        if (read !== size) throw new SharedMutationError('uncertain', 'The shared file could not be read completely. Nothing was written.')
        const sha256 = hashOf(current)
        if (size !== input.expectedBytes || sha256 !== input.expectedSha256) {
            return { status: 'refused', path: rel, code: 'conflict', message: `The shared file changed. It was kept. Current identity is ${size} bytes, sha256 ${sha256}.`, bytes: size, sha256, committed: false }
        }
        let text: string
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(current) }
        catch { return { status: 'refused', path: rel, code: 'malformed', message: 'Only UTF-8 text can be edited in the shared folder.', committed: false } }
        if (Buffer.from(text, 'utf8').equals(current) === false) return { status: 'refused', path: rel, code: 'malformed', message: 'Only UTF-8 text can be edited in the shared folder.', committed: false }
        if (input.oldString === input.newString) return { status: 'unchanged', path: rel, message: 'oldString and newString are identical; nothing to do.', bytes: size, sha256, committed: false }
        const occurrences = text.split(input.oldString).length - 1
        if (occurrences === 0) return { status: 'refused', path: rel, code: 'not_found', message: `oldString not found in ${rel}`, committed: false }
        if (occurrences > 1 && !input.replaceAll) return { status: 'refused', path: rel, code: 'malformed', message: `oldString matches ${occurrences} times in ${rel}; pass replaceAll or provide a more specific string.`, committed: false }
        const nextText = input.replaceAll ? text.split(input.oldString).join(input.newString) : text.replace(input.oldString, input.newString)
        const next = textBytes(nextText, 'newString')
        await access?.beforeCommit?.()
        access?.signal?.throwIfAborted()
        const again = await handle.stat({ bigint: true })
        if (again.dev !== opened.dev || again.ino !== opened.ino || again.size !== opened.size || again.ctimeNs !== opened.ctimeNs) {
            return { status: 'refused', path: rel, code: 'conflict', message: 'The shared file changed. It was kept.', bytes: size, sha256, committed: false }
        }
        await handle.write(next, 0, next.length, 0)
        if (next.length < size) await handle.truncate(next.length)
        await handle.sync()
        const check = Buffer.alloc(next.length)
        let seen = 0
        while (seen < next.length) {
            const chunk = await handle.read(check, seen, next.length - seen, seen)
            if (!chunk.bytesRead) break
            seen += chunk.bytesRead
        }
        const after = await handle.stat({ bigint: true })
        if (seen !== next.length || !check.equals(next) || after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== BigInt(1)) {
            throw new SharedMutationError('uncertain', 'The edit was not confirmed. The file was not written again.')
        }
        const digest = hashOf(next)
        return { status: 'saved', path: rel, message: `Edited ${rel} (${occurrences} replacement${occurrences === 1 ? '' : 's'})`, bytes: next.length, sha256: digest, occurrences, committed: true }
    } finally { await handle.close() }
}

async function searchFile(root: string, path: string, pattern: RegExp, access: SharedFileAccess | undefined, hits: SharedSearchHit[], omitted: SharedSearchOutcome['omitted'], maxResults: number) {
    if (hits.length >= maxResults) return
    try {
        const page = await readSharedText(root, path, 0, access)
        if (page.truncated || page.nextOffset !== null) { omitted.push({ path, reason: 'too-large' }); return }
        const lines = page.content.split('\n')
        for (let index = 0; index < lines.length && hits.length < maxResults; index += 1) {
            const line = lines[index] ?? ''
            if (line.length > MAX_LINE) continue
            pattern.lastIndex = 0
            if (pattern.test(line)) hits.push({ path, line: index + 1, text: line.trim().slice(0, SNIPPET) })
        }
    } catch (error) {
        if (error instanceof SharedWorkspaceFileError && error.status === 415) omitted.push({ path, reason: 'binary' })
        else if (!(error instanceof SharedWorkspaceFileError && error.status === 404)) omitted.push({ path, reason: 'unreadable' })
    }
}

export async function searchSharedDocuments(root: string, input: { path?: string; pattern: string; maxResults?: number }, access?: SharedFileAccess): Promise<SharedSearchOutcome> {
    let pattern: RegExp
    try { pattern = new RegExp(input.pattern) }
    catch (error) { throw new SharedMutationError('malformed', `Invalid regular expression: ${(error as Error).message}`) }
    const maxResults = input.maxResults ?? 50
    const start = partsOf(input.path && input.path.length ? input.path : '.', input.path && TEXT_NAME.test(input.path) ? 'file' : 'directory')
    const hits: SharedSearchHit[] = []
    const omitted: SharedSearchOutcome['omitted'] = []
    if (TEXT_NAME.test(start.at(-1) ?? '')) {
        await searchFile(root, start.join('/'), pattern, access, hits, omitted, maxResults)
        return { hits, truncated: false, omitted }
    }
    const pending = [start.join('/')]
    let files = 0
    let truncated = false
    while (pending.length) {
        access?.signal?.throwIfAborted()
        const dir = pending.shift() ?? ''
        if (dir.split('/').filter(Boolean).length > MAX_DEPTH) { truncated = true; continue }
        const listing = await listSharedDirectory(root, dir || '.', access)
        for (const entry of listing.entries) {
            if (SKIP_DIRS.has(entry.name)) continue
            const child = dir ? `${dir}/${entry.name}` : entry.name
            if (entry.type === 'dir') pending.push(child)
            else if (TEXT_NAME.test(entry.name)) {
                if (files >= MAX_FILES) { truncated = true; continue }
                files += 1
                await searchFile(root, child, pattern, access, hits, omitted, maxResults)
                if (hits.length >= maxResults) truncated = true
            }
        }
        if (listing.truncated) truncated = true
    }
    return { hits: hits.slice(0, maxResults), truncated, omitted }
}
