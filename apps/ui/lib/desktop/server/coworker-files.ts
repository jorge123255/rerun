import 'server-only'
import { constants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { findDesktopAgent } from './store'

export type CoworkerFileEntry = { name: string; type: 'file' | 'dir'; size: number; modifiedAt: string }
export type CoworkerFilePreview = { path: string; content: string; size: number; truncated: boolean }

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

export async function readCoworkerFile(runtime: DesktopRuntime, agentId: string, path: string): Promise<CoworkerFilePreview> {
    const { target, rel } = await containedPath(await coworkerWorkspace(runtime, agentId), path)
    if (!rel) throw new DesktopHttpError(400, 'Choose a file to preview.')
    if (!target) throw new DesktopHttpError(404, 'File not found')
    const handle = await openResolved(target)
    try {
        const info = await handle.stat()
        if (!info.isFile()) throw new DesktopHttpError(400, 'That path is not a file.')
        const buffer = Buffer.alloc(Math.min(info.size, PREVIEW_BYTES))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        const bytes = buffer.subarray(0, bytesRead)
        if (bytes.includes(0)) throw new DesktopHttpError(415, 'Only text files can be previewed.')
        return { path: rel, content: bytes.toString('utf8'), size: info.size, truncated: info.size > bytesRead }
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
    const tempName = `.${name}.${randomBytes(6).toString('hex')}.import`
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
        await mkdir(part).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
        const info = await lstat(part)
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(part) !== part) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    }
}
