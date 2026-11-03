import 'server-only'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
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
    return resolve(runtime.dataRoot, 'workspaces', '1', 'engine', 'agents', coworker.engineAgentId, 'workspace')
}

/** Relative paths only; the result's real location (after following every symlink) must stay inside the workspace's real location. */
async function containedPath(workspace: string, path: string): Promise<{ root: string | null; target: string | null; rel: string }> {
    const rel = path.split('/').filter(part => part && part !== '.').join('/')
    if (isAbsolute(path) || path.includes('\0') || rel.split('/').includes('..')) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const info = await lstat(workspace).catch(error => { if (missing(error)) return null; throw error })
    if (!info) return { root: null, target: null, rel }
    if (!info.isDirectory()) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    const root = await realpath(workspace)
    const target = await realpath(join(root, rel)).catch(error => { if (missing(error)) return null; throw error })
    if (target && !inside(root, target)) throw new DesktopHttpError(400, 'That path is outside this coworker’s workspace.')
    return { root, target, rel }
}

export async function listCoworkerFiles(runtime: DesktopRuntime, agentId: string, path: string, showHidden: boolean): Promise<{ path: string; entries: CoworkerFileEntry[] }> {
    const { root, target, rel } = await containedPath(await coworkerWorkspace(runtime, agentId), path)
    if (!root) return { path: rel, entries: [] }
    if (!target) throw new DesktopHttpError(404, 'Folder not found')
    if (!(await stat(target)).isDirectory()) throw new DesktopHttpError(400, 'That path is not a folder.')
    const entries: CoworkerFileEntry[] = []
    for (const dirent of await readdir(target, { withFileTypes: true })) {
        if (!showHidden && dirent.name.startsWith('.')) continue
        // Follow the entry the way a later read would; anything resolving outside the workspace is left out.
        const real = await realpath(join(target, dirent.name)).catch(() => null)
        if (!real || !inside(root, real)) continue
        const info = await stat(real).catch(() => null)
        if (!info || (!info.isDirectory() && !info.isFile())) continue
        entries.push({ name: dirent.name, type: info.isDirectory() ? 'dir' : 'file', size: info.size, modifiedAt: info.mtime.toISOString() })
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    return { path: rel, entries }
}

export async function readCoworkerFile(runtime: DesktopRuntime, agentId: string, path: string): Promise<CoworkerFilePreview> {
    const { target, rel } = await containedPath(await coworkerWorkspace(runtime, agentId), path)
    if (!rel) throw new DesktopHttpError(400, 'Choose a file to preview.')
    if (!target) throw new DesktopHttpError(404, 'File not found')
    const handle = await open(target, 'r')
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
