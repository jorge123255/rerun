import 'server-only'
import { DESKTOP_ATTACHMENT_MAX_BYTES, isDesktopAttachmentPath } from '@rerun/contracts'
import { constants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { hashText, looksBinary } from '@/lib/files/editable'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { findDesktopAgent } from './store'
import { withRosterWrite } from './roster-writes'
import { assertCoworkerNotDeleting } from './coworker-delete'

export type CoworkerFileEntry = { name: string; type: 'file' | 'dir'; size: number; modifiedAt: string }
/** `hash` is set only when the whole file was read as valid UTF-8 .txt/.md, i.e. when it can be edited. */
export type CoworkerFilePreview = { path: string; content: string; size: number; truncated: boolean; hash?: string }

const PREVIEW_BYTES = 256 * 1024
const SAFE_ENGINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const inside = (root: string, target: string) => {
    const rel = relative(root, target)
    return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')

/** The engine stores each agent's workspace under `<engine data>/agents/<id>/workspace` (apps/engine/src/config/paths.ts). */
async function coworkerWorkspace(runtime: DesktopRuntime, agentId: string): Promise<string> {
    const coworker = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), agentId)
    if (!coworker) throw new DesktopHttpError(404, 'Coworker not found')
    if (!SAFE_ENGINE_ID.test(coworker.engineAgentId)) throw new DesktopHttpError(400, 'This coworker has no readable workspace.')
    return resolve(await realpath(runtime.dataRoot), 'workspaces', '1', 'engine', 'agents', coworker.engineAgentId, 'workspace')
}

/** Relative paths only; the result's real location (after following every symlink) must stay inside the workspace's real location. */
async function containedPath(workspace: string, path: string): Promise<{ root: string | null; target: string | null; rel: string }> {
    const rel = path.split('/').filter(part => part && part !== '.').join('/')
    if (isAbsolute(path) || path.includes('\0') || rel.split('/').includes('..')) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const info = await lstat(workspace).catch(error => { if (missing(error)) return null; throw error })
    if (!info) return { root: null, target: null, rel }
    if (!info.isDirectory()) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const root = await realpath(workspace)
    if (root !== workspace) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const target = await realpath(join(root, rel)).catch(error => { if (missing(error)) return null; throw error })
    if (target && !inside(root, target)) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    return { root, target, rel }
}

// Only open canonical paths. Darwin's O_NOFOLLOW_ANY refuses a symlink swapped into any
// component after realpath. On Linux walk each component from a pinned parent instead.
async function openResolved(target: string, directory = false): Promise<FileHandle> {
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0)
    try {
        if (process.platform === 'darwin') return await open(target, flags | 0x20000000)
        let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY)
        try {
            const parts = target.split('/').filter(Boolean)
            for (const [i, part] of parts.entries()) {
                const next = await open(`/proc/self/fd/${handle.fd}/${part}`,
                    constants.O_NOFOLLOW | (i === parts.length - 1 ? flags : constants.O_RDONLY | constants.O_DIRECTORY))
                await handle.close()
                handle = next
            }
            return handle
        } catch (error) {
            await handle.close()
            throw error
        }
    } catch (error) {
        if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace or is not a folder.')
        }
        throw error
    }
}

async function pinnedDirectory(handle: FileHandle): Promise<string> {
    if (process.platform !== 'darwin') return `/proc/self/fd/${handle.fd}`
    const info = await handle.stat({ bigint: true })
    return `/.vol/${info.dev}/${info.ino}`
}

export async function listCoworkerFiles(runtime: DesktopRuntime, agentId: string, path: string, showHidden: boolean): Promise<{ path: string; entries: CoworkerFileEntry[] }> {
    const { root, target, rel } = await containedPath(await coworkerWorkspace(runtime, agentId), path)
    if (!root) return { path: rel, entries: [] }
    if (!target) throw new DesktopHttpError(404, 'Folder not found')
    const handle = await openResolved(target, true)
    const entries: CoworkerFileEntry[] = []
    try {
        const pinned = await pinnedDirectory(handle)
        for (const name of await readdir(pinned)) {
            if (!showHidden && name.startsWith('.')) continue
            let info = await lstat(join(pinned, name)).catch(() => null)
            if (info?.isSymbolicLink()) {
                // Coworker links are read from the running Mac's workspace, outside the build.
                const real = await realpath(/* turbopackIgnore: true */ join(/* turbopackIgnore: true */ target, name)).catch(() => null)
                if (!real || !inside(root, real)) continue
                const linked = await openResolved(real).catch(() => null)
                if (!linked) continue
                try { info = await linked.stat() } finally { await linked.close() }
            }
            if (!info || (!info.isDirectory() && !info.isFile())) continue
            entries.push({ name, type: info.isDirectory() ? 'dir' : 'file', size: info.size, modifiedAt: info.mtime.toISOString() })
        }
    } finally {
        await handle.close()
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    return { path: rel, entries }
}

export async function readCoworkerFile(runtime: DesktopRuntime, agentId: string, path: string, mode: 'preview' | 'attach' = 'preview'): Promise<CoworkerFilePreview> {
    if (mode === 'attach' && !isDesktopAttachmentPath(path)) throw new DesktopHttpError(400, 'Choose a .txt or .md file from this coworker’s workspace.')
    const { target, rel } = await containedPath(await coworkerWorkspace(runtime, agentId), path)
    if (!rel) throw new DesktopHttpError(400, 'Choose a file to preview.')
    if (!target) throw new DesktopHttpError(404, 'File not found')
    const handle = await openResolved(target)
    try {
        const info = await handle.stat()
        if (!info.isFile()) throw new DesktopHttpError(400, 'That path is not a file.')
        if (mode === 'attach' && info.size > DESKTOP_ATTACHMENT_MAX_BYTES) throw new DesktopHttpError(413, 'Attachments must be 32 KiB or smaller.')
        const buffer = Buffer.alloc(Math.min(info.size, PREVIEW_BYTES))
        let bytesRead = 0
        while (bytesRead < buffer.length) {
            const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
            if (!read.bytesRead) break
            bytesRead += read.bytesRead
        }
        const bytes = buffer.subarray(0, bytesRead)
        if (bytes.includes(0)) throw new DesktopHttpError(415, mode === 'attach' ? 'Attachments must contain UTF-8 text.' : 'Only text files can be previewed.')
        let content: string
        if (mode === 'attach') {
            const after = await handle.stat()
            if (bytesRead !== info.size || info.size !== after.size || info.ctimeMs !== after.ctimeMs) throw new DesktopHttpError(409, 'This file changed while it was being read. Try sending again.')
            try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
            catch { throw new DesktopHttpError(415, 'Attachments must contain UTF-8 text.') }
            if (bytes.some(byte => (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)) throw new DesktopHttpError(415, 'Attachments must contain UTF-8 text.')
        } else content = bytes.toString('utf8')
        const truncated = info.size > bytesRead
        const hash = mode === 'preview' && !truncated && EDITABLE.test(rel) ? editableText(bytes) : null
        return { path: rel, content, size: info.size, truncated, ...(hash !== null ? { hash: hashText(hash) } : {}) }
    } finally {
        await handle.close()
    }
}

export const IMPORT_BYTES = 1024 * 1024
const IMPORTABLE = /\.(txt|md)$/i

/**
 * Copies one .txt/.md file into `folder` of the coworker's workspace. Never overwrites: an existing
 * name (including a symlink) is reported as 409. The folder must resolve inside the workspace, and
 * the create itself refuses symlinks in any component, so a swapped folder cannot redirect the write.
 */
export async function importCoworkerFile(runtime: DesktopRuntime, agentId: string, folder: string, name: string, bytes: Uint8Array): Promise<{ path: string; name: string }> {
    // Imports can create a previously absent workspace. Keep that whole mutation ordered with
    // deletion so an old file picker cannot recreate the removed coworker's folder.
    return withRosterWrite(async () => {
        await assertCoworkerNotDeleting(await openDesktopDatabase(runtime.dataRoot), agentId)
        return importFile(runtime, agentId, folder, name, bytes)
    })
}

async function importFile(runtime: DesktopRuntime, agentId: string, folder: string, name: string, bytes: Uint8Array): Promise<{ path: string; name: string }> {
    if (!name || name.includes('/') || name.includes('\\') || name.includes('\0') || name.startsWith('.')) throw new DesktopHttpError(400, 'That file name can’t be imported.')
    if (!IMPORTABLE.test(name)) throw new DesktopHttpError(415, 'Only .txt and .md files can be imported.')
    if (bytes.byteLength > IMPORT_BYTES) throw new DesktopHttpError(413, 'Files can be up to 1 MB.')
    if (bytes.includes(0)) throw new DesktopHttpError(415, 'Only text files can be imported.')
    const workspace = await coworkerWorkspace(runtime, agentId)
    let resolved = await containedPath(workspace, folder)
    if (!resolved.root && !resolved.rel) {
        await createWorkspace(runtime, workspace)
        resolved = await containedPath(workspace, folder)
    }
    const { target, rel } = resolved
    if (!target) throw new DesktopHttpError(404, 'Folder not found')
    const path = rel ? `${rel}/${name}` : name
    const outside = () => new DesktopHttpError(400, 'That path is outside this coworker’s workspace or is not a folder.')
    const exists = () => new DesktopHttpError(409, `This folder already has a file named “${name}”. The existing file was kept; rename yours and import it again.`)
    const fsError = (error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST') return exists()
        if (code === 'ELOOP' || code === 'ENOTDIR') return outside()
        if (code === 'ENOENT') return new DesktopHttpError(404, 'Folder not found')
        return error
    }
    // Write a hidden temp file in the pinned folder, then publish it with link(2), which fails with
    // EEXIST rather than replacing a file. The final name only ever appears complete, a failed write
    // leaves it free, and a racing import that published first is never overwritten.
    const tempName = `.rerun-import-${randomBytes(12).toString('hex')}`
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    let dir: FileHandle
    try {
        dir = await openResolved(target, true)
    } catch (error) { throw fsError(error) }
    try {
        const pinned = await pinnedDirectory(dir)
        if (await lstat(join(pinned, name)).then(() => true, () => false)) throw exists()
        let handle: FileHandle
        try {
            // O_NOFOLLOW_ANY (Darwin) must not be combined with O_NOFOLLOW; it already covers every component.
            handle = process.platform === 'darwin'
                ? await open(join(target, tempName), flags | 0x20000000, 0o644)
                : await open(`${pinned}/${tempName}`, flags | constants.O_NOFOLLOW, 0o644)
        } catch (error) { throw fsError(error) }
        let tempPath: string | null = join(pinned, tempName)
        try {
            try {
                // The temp file must be the one in the pinned folder, not a swapped-in lookalike.
                const [opened, listed] = await Promise.all([handle.stat({ bigint: true }), lstat(tempPath, { bigint: true })])
                if (opened.ino !== listed.ino || opened.dev !== listed.dev) throw outside()
                await handle.writeFile(bytes)
                await handle.sync()
            } finally {
                await handle.close()
            }
            try {
                await link(tempPath, join(pinned, name))
            } catch (error) { throw fsError(error) }
        } finally {
            if (tempPath) await unlink(tempPath).catch(() => {})
            tempPath = null
        }
    } finally {
        await dir.close()
    }
    return { path, name }
}

/**
 * Creates a missing workspace one folder at a time. Every existing ancestor must already be its own
 * real path, so a coworker directory that is a symlink to a sibling (existing or not) is refused
 * before any folder is made, and each folder we make is checked to be a real directory.
 */
async function createWorkspace(runtime: DesktopRuntime, workspace: string): Promise<void> {
    const base = resolve(await realpath(runtime.dataRoot))
    if (!inside(base, workspace)) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const missingParts: string[] = []
    let existing = workspace
    while (existing !== base) {
        const info = await lstat(existing).catch(error => { if (missing(error)) return null; throw error })
        if (info) {
            if (!info.isDirectory() || await realpath(existing) !== existing) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
            break
        }
        missingParts.unshift(existing)
        existing = dirname(existing)
    }
    for (const part of missingParts) {
        const parent = await openResolved(dirname(part), true)
        try {
            // Pin the parent for mkdir itself. Checking the absolute path afterwards is too late if
            // an ancestor was exchanged for a sibling symlink between validation and creation.
            const child = join(await pinnedDirectory(parent), basename(part))
            await mkdir(child).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
            const info = await lstat(child)
            const actual = await realpath(part).catch(error => { if (missing(error)) return null; throw error })
            if (!info.isDirectory() || actual !== part) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
        } finally {
            await parent.close()
        }
    }
}

const EDITABLE = /\.(txt|md)$/i
export const EDIT_BYTES = PREVIEW_BYTES

/** The strict UTF-8 text of `bytes`, or null when saving it back as text would change it. */
function editableText(bytes: Uint8Array): string | null {
    if (bytes.includes(0)) return null
    try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
        return looksBinary(text) ? null : text
    } catch { return null }
}

export type SaveCoworkerFileResult = { path: string; hash: string; size: number }
/** Thrown when the file on disk is not what the editor opened; carries the newer text so neither version is lost. */
export class CoworkerFileConflict extends Error {
    constructor(readonly current: { content: string; hash: string } | null) { super('This file changed on disk since you opened it.') }
}

const saveLocks = new Map<string, Promise<void>>()

async function withSaveLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = saveLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    saveLocks.set(key, tail)
    await previous
    try { return await run() } finally {
        release()
        if (saveLocks.get(key) === tail) saveLocks.delete(key)
    }
}

/** Serialize our own saves, then publish without replacing any writer that landed in the meantime. */
export async function saveCoworkerFile(runtime: DesktopRuntime, agentId: string, path: string, content: string, baseHash: string): Promise<SaveCoworkerFileResult> {
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.byteLength > EDIT_BYTES) throw new DesktopHttpError(413, 'Files over 256 KB can’t be edited here.')
    if (content.includes('\0') || looksBinary(content)) throw new DesktopHttpError(415, 'Only text can be saved here.')
    const { root, target, rel } = await containedPath(await coworkerWorkspace(runtime, agentId), path)
    const name = rel.split('/').pop() ?? ''
    if (!rel || name.startsWith('.') || !EDITABLE.test(name)) throw new DesktopHttpError(415, 'Only .txt and .md files can be edited here.')
    if (!root || !target) throw new DesktopHttpError(404, 'File not found')
    if (!baseHash) throw new DesktopHttpError(400, 'The opened file version is required for every save.')
    const outside = () => new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const folder = dirname(target)
    const finalName = basename(target)
    if (!inside(root, folder)) throw outside()
    return withSaveLock(target, async () => {
        let dir: FileHandle
        try { dir = await openResolved(folder, true) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DesktopHttpError(404, 'File not found')
            throw error
        }
        try {
            const pinned = await pinnedDirectory(dir)
            const assertFolderUnmoved = async () => {
                const [opened, listed, actual] = await Promise.all([
                    dir.stat({ bigint: true }),
                    lstat(folder, { bigint: true }).catch(() => null),
                    realpath(folder).catch(() => null),
                ])
                if (!listed || !actual || actual !== folder || !inside(root, actual) || opened.dev !== listed.dev || opened.ino !== listed.ino) throw outside()
            }
            const readCurrent = async (fileName = finalName) => {
                const info = await lstat(join(pinned, fileName)).catch(error => { if (missing(error)) return null; throw error })
                if (!info) return null
                if (!info.isFile()) throw outside()
                const handle = await open(join(pinned, fileName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
                try {
                    const opened = await handle.stat()
                    if (!opened.isFile()) throw outside()
                    if (opened.size > EDIT_BYTES) throw new DesktopHttpError(413, 'Files over 256 KB can’t be edited here.')
                    const buffer = Buffer.alloc(Math.min(opened.size, EDIT_BYTES + 1))
                    let bytesRead = 0
                    while (bytesRead < buffer.length) {
                        const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
                        if (!read.bytesRead) break
                        bytesRead += read.bytesRead
                    }
                    if (bytesRead > EDIT_BYTES) throw new DesktopHttpError(413, 'Files over 256 KB can’t be edited here.')
                    const after = await handle.stat()
                    if (!after.isFile() || after.size > EDIT_BYTES) throw new DesktopHttpError(413, 'Files over 256 KB can’t be edited here.')
                    const text = editableText(buffer.subarray(0, bytesRead))
                    if (text === null) throw new DesktopHttpError(415, 'This file is not UTF-8 text, so it can’t be edited here.')
                    return { content: text, hash: hashText(text), mode: opened.mode & 0o777 }
                } finally { await handle.close() }
            }
            const check = async () => {
                const current = await readCurrent()
                if (!current) throw new DesktopHttpError(404, 'This file was moved or deleted since you opened it.')
                if (current.hash !== baseHash) throw new CoworkerFileConflict({ content: current.content, hash: current.hash })
                return current
            }
            const { mode } = await check()
            const tempName = `.rerun-edit-${randomBytes(12).toString('hex')}`
            const backupName = `.rerun-backup-${randomBytes(12).toString('hex')}`
            const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
            let handle: FileHandle
            try {
                handle = process.platform === 'darwin'
                    ? await open(join(folder, tempName), flags | 0x20000000, mode)
                    : await open(`${pinned}/${tempName}`, flags | constants.O_NOFOLLOW, mode)
            } catch (error) {
                if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw outside()
                throw error
            }
            const tempPath = join(pinned, tempName)
            const backupPath = join(pinned, backupName)
            const finalPath = join(pinned, finalName)
            let backupCreated = false
            let published = false
            const restoreBackup = async () => {
                if (!backupCreated) return
                try {
                    await link(backupPath, finalPath)
                    await unlink(backupPath)
                    backupCreated = false
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
                }
            }
            try {
                try {
                    const [opened, listed] = await Promise.all([handle.stat({ bigint: true }), lstat(tempPath, { bigint: true })])
                    if (opened.ino !== listed.ino || opened.dev !== listed.dev) throw outside()
                    await handle.writeFile(bytes)
                    await handle.sync()
                } finally {
                    await handle.close()
                }
                await check()
                await assertFolderUnmoved()
                try { await rename(finalPath, backupPath) } catch (error) {
                    if (missing(error)) throw new DesktopHttpError(404, 'This file was moved or deleted since you opened it.')
                    throw error
                }
                backupCreated = true
                try {
                    await assertFolderUnmoved()
                    const current = await readCurrent(backupName)
                    if (!current) throw new DesktopHttpError(404, 'This file was moved or deleted since you opened it.')
                    if (current.hash !== baseHash) throw new CoworkerFileConflict({ content: current.content, hash: current.hash })
                    await assertFolderUnmoved()
                    try { await link(tempPath, finalPath) } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
                        const competing = await readCurrent()
                        if (!competing) throw new DesktopHttpError(404, 'This file was moved or deleted since you opened it.')
                        throw new CoworkerFileConflict({ content: competing.content, hash: competing.hash })
                    }
                    published = true
                    await unlink(tempPath).catch(() => {})
                    await unlink(backupPath).catch(() => {})
                    backupCreated = false
                } catch (error) {
                    await restoreBackup()
                    throw error
                }
            } finally {
                if (!published) await unlink(tempPath).catch(() => {})
            }
        } finally {
            await dir.close()
        }
        return { path: rel, hash: hashText(content), size: bytes.byteLength }
    })
}
