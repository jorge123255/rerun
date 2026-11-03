import { DESKTOP_ATTACHMENT_MAX_BYTES, type DesktopRerunGrantId } from '@rerun/contracts'
import { tool, type ToolSet } from 'ai'
import { constants } from 'node:fs'
import { open, opendir, realpath, type FileHandle } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { hasDesktopToolGrant, requireDesktopToolGrant } from './tool-grants.js'
import { dataDir, workspaceDir } from '../config/paths.js'
import type { RunContext } from '../runtime/context.js'

class WorkspaceReadError extends Error {}

const unavailable = 'That file is unavailable in this coworker’s workspace.'

function validPath(path: string) {
    return path && path.length <= 4096 && !/[\\\p{Cc}]/u.test(path) && path.split('/').every(part => part && !part.startsWith('.'))
}

async function workspacePath(id: string, path: string) {
    const root = await realpath(dataDir())
    return join(root, relative(dataDir(), workspaceDir(id)), path)
}

// Open the original relative path without following links in any component. O_NONBLOCK
// lets us reject a FIFO using fstat without waiting for a writer.
async function openWorkspacePath(path: string, directory = false): Promise<FileHandle> {
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0)
    if (process.platform === 'darwin') return open(path, flags | 0x20000000) // O_NOFOLLOW_ANY
    if (process.platform !== 'linux') throw new WorkspaceReadError(unavailable)
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
}

async function readWorkspaceText(ctx: RunContext, path: string, grant: DesktopRerunGrantId): Promise<string> {
    await requireDesktopToolGrant(ctx, grant)
    if (!validPath(path)) throw new WorkspaceReadError('Use a visible relative file path inside this coworker’s workspace.')
    try {
        const target = await workspacePath(ctx.agent.id, path)
        const handle = await openWorkspacePath(target)
        try {
            const info = await handle.stat({ bigint: true })
            if (!info.isFile() || info.nlink !== 1n) throw new WorkspaceReadError(unavailable)
            const max = DESKTOP_ATTACHMENT_MAX_BYTES
            const tooLarge = 'Workspace files must be 32 KiB or smaller to read in chat.'
            if (info.size > max) throw new WorkspaceReadError(tooLarge)
            const bytes = Buffer.alloc(max + 1)
            let length = 0
            while (length < bytes.length) {
                const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
                if (!bytesRead) break
                length += bytesRead
            }
            if (length > max) throw new WorkspaceReadError(tooLarge)
            // The open descriptor pins the data, but a directory could have moved into another
            // coworker's workspace during the read. Verify the original path still owns this inode.
            const current = await openWorkspacePath(target)
            try {
                const check = await current.stat({ bigint: true })
                if (check.dev !== info.dev || check.ino !== info.ino || check.nlink !== 1n || check.size !== BigInt(length) || check.ctimeNs !== info.ctimeNs) throw new WorkspaceReadError(unavailable)
            } finally { await current.close() }
            const data = bytes.subarray(0, length)
            if (data.includes(0)) throw new WorkspaceReadError('This file must contain UTF-8 text.')
            let text: string
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) }
            catch { throw new WorkspaceReadError('This file must contain UTF-8 text.') }
            await requireDesktopToolGrant(ctx, grant)
            return text
        } finally { await handle.close() }
    } catch (error) {
        ctx.abortSignal?.throwIfAborted()
        if (error instanceof WorkspaceReadError) throw error
        await requireDesktopToolGrant(ctx, grant)
        // Native filesystem errors contain absolute host paths.
        throw new WorkspaceReadError(unavailable)
    }
}

type WorkspaceEntry = { name: string; directory: boolean }

// Enumerate the already-open directory. Reopening the requested path afterwards catches a
// directory moved into a sibling workspace, without allowing a swapped symlink to redirect us.
async function listDirectory(ctx: RunContext, path: string, grant: DesktopRerunGrantId) {
    await requireDesktopToolGrant(ctx, grant)
    if (path !== '.' && !validPath(path)) throw new WorkspaceReadError('Use a visible relative directory in this coworker’s workspace.')
    try {
        const target = await workspacePath(ctx.agent.id, path)
        const handle = await openWorkspacePath(target, true)
        try {
            const original = await handle.stat({ bigint: true })
            const pinned = process.platform === 'darwin' ? `/.vol/${original.dev}/${original.ino}` : `/proc/self/fd/${handle.fd}`
            const entries: WorkspaceEntry[] = []
            let visited = 0, truncated = false
            for await (const item of await opendir(pinned)) {
                if (++visited > 512) { truncated = true; break }
                if (validPath(item.name) && item.name !== 'node_modules' && (item.isFile() || item.isDirectory())) {
                    entries.push({ name: item.name, directory: item.isDirectory() })
                }
            }
            const current = await openWorkspacePath(target, true)
            try {
                const check = await current.stat({ bigint: true })
                if (check.dev !== original.dev || check.ino !== original.ino || check.ctimeNs !== original.ctimeNs) throw new WorkspaceReadError(unavailable)
            } finally { await current.close() }
            await requireDesktopToolGrant(ctx, grant)
            return { entries: entries.sort((a, b) => a.name.localeCompare(b.name)), truncated }
        } finally { await handle.close() }
    } catch (error) {
        ctx.abortSignal?.throwIfAborted()
        await requireDesktopToolGrant(ctx, grant)
        if (error instanceof WorkspaceReadError) throw error
        throw new WorkspaceReadError(unavailable)
    }
}

async function searchText(ctx: RunContext, path: string, pattern: string, maxResults: number) {
    const directories = [path]
    const lines: string[] = []
    let files = 0, truncated = false
    const needle = pattern.toLowerCase()
    for (let i = 0; i < directories.length; i++) {
        const folder = directories[i]
        const listing = await listDirectory(ctx, folder, 'workspaceSearch')
        truncated ||= listing.truncated
        for (const entry of listing.entries) {
            const relative = folder === '.' ? entry.name : folder + '/' + entry.name
            if (entry.directory) {
                if (directories.length < 32) directories.push(relative)
                else truncated = true
                continue
            }
            if (++files > 128 || lines.length >= maxResults) return [...lines, '(search limit reached)'].join('\n')
            let text: string
            try { text = await readWorkspaceText(ctx, relative, 'workspaceSearch') }
            catch (error) {
                if (!(error instanceof WorkspaceReadError)) throw error
                continue // Non-text, oversized or inaccessible file.
            }
            for (const [n, line] of text.split('\n').entries()) {
                if (line.toLowerCase().includes(needle)) {
                    lines.push(`${relative}:${n + 1}: ${line.slice(0, 256)}`)
                    if (lines.length >= maxResults) return [...lines, '(search limit reached)'].join('\n')
                }
            }
        }
    }
    if (truncated) lines.push('(search limit reached)')
    return lines.join('\n') || 'No matches.'
}

export function desktopWorkspaceReadTools(ctx: RunContext): ToolSet {
    const result: ToolSet = {}
    if (hasDesktopToolGrant(ctx.agent.config, 'workspaceRead')) result.fs_read = tool({
        description: 'Read a UTF-8 file from this coworker’s workspace. Use a visible relative path. Files can be up to 32 KiB.',
        inputSchema: z.object({ path: z.string().describe('Path relative to the root') }),
        execute: ({ path }) => readWorkspaceText(ctx, path, 'workspaceRead'),
    })
    if (hasDesktopToolGrant(ctx.agent.config, 'workspaceList')) result.fs_list = tool({
        description: 'List visible entries in a coworker workspace directory. Directories end in a slash.',
        inputSchema: z.object({ path: z.string().default('.').describe('Directory relative to the workspace root') }),
        execute: async ({ path }) => {
            const { entries, truncated } = await listDirectory(ctx, path, 'workspaceList')
            const names = entries.map(entry => entry.name + (entry.directory ? '/' : ''))
            if (truncated) names.push('(listing limit reached)')
            return names.join('\n') || '(empty)'
        },
    })
    if (hasDesktopToolGrant(ctx.agent.config, 'workspaceSearch')) result.fs_search = tool({
        description: 'Search visible text files for a literal, case-insensitive phrase. Returns path, line number and matching text.',
        inputSchema: z.object({ pattern: z.string().min(1).max(256), path: z.string().default('.'), maxResults: z.number().int().positive().max(50).default(20) }),
        execute: ({ path, pattern, maxResults }) => searchText(ctx, path, pattern, maxResults),
    })
    return result
}
