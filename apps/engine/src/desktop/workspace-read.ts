import { DESKTOP_ATTACHMENT_MAX_BYTES } from '@rerun/contracts'
import { tool, type ToolSet } from 'ai'
import { constants } from 'node:fs'
import { open, realpath, type FileHandle } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { readAgentConfig } from '../agents/loader.js'
import { dataDir, workspaceDir } from '../config/paths.js'
import type { RunContext } from '../runtime/context.js'

class WorkspaceReadError extends Error {}

const unavailable = 'That file is unavailable in this coworker’s workspace.'

async function requireGrant(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const config = await readAgentConfig(id).catch(() => null)
    if (!config?.tools.desktopWorkspaceRead) throw new WorkspaceReadError('Workspace file reading is turned off for this coworker.')
}

// Open the original relative path without following links in any component. O_NONBLOCK
// lets us reject a FIFO using fstat without waiting for a writer.
async function openWorkspacePath(path: string): Promise<FileHandle> {
    const flags = constants.O_RDONLY | constants.O_NONBLOCK
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

async function readWorkspaceText(id: string, path: string, signal?: AbortSignal): Promise<string> {
    await requireGrant(id, signal)
    if (!path || path.length > 4096 || /[\\\p{Cc}]/u.test(path) || path.split('/').some(part => !part || part.startsWith('.'))) {
        throw new WorkspaceReadError('Use a visible relative file path inside this coworker’s workspace.')
    }
    try {
        const root = await realpath(dataDir())
        const target = join(root, relative(dataDir(), workspaceDir(id)), path)
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
            await requireGrant(id, signal)
            return text
        } finally { await handle.close() }
    } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof WorkspaceReadError) throw error
        // Native filesystem errors contain absolute host paths.
        throw new WorkspaceReadError(unavailable)
    }
}

export function desktopWorkspaceReadTools(ctx: RunContext): ToolSet {
    if (ctx.agent.config.tools.desktopWorkspaceRead !== true) return {}
    return {
        fs_read: tool({
            description: 'Read a UTF-8 file from this coworker’s workspace. Use a visible relative path. Files can be up to 32 KiB.',
            inputSchema: z.object({ path: z.string().describe('Path relative to the root') }),
            execute: ({ path }) => readWorkspaceText(ctx.agent.id, path, ctx.abortSignal),
        }),
    }
}
