import 'server-only'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
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
