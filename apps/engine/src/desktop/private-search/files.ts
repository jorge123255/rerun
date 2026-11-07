import { existsSync } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DESKTOP_ATTACHMENT_MAX_BYTES } from '@rerun/contracts'
import { openWithoutLinks } from '../open-without-links.js'
import { requireDesktopToolGrant } from '../tool-grants.js'
import { workspacePath } from '../workspace-read.js'
import { sharedRegexLines } from '../shared-file-mutations/regex.js'
import type { RunContext } from '../../runtime/context.js'

class WorkspaceSearchError extends Error {}

export function desktopPrivateSearchPathAllowed(path: string): boolean {
    if (path === '.') return true
    return !!path && path.length <= 4096 && !isAbsolute(path) && !/[\\\p{Cc}]/u.test(path) && path.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.toLowerCase().startsWith('.rerun'))
}

async function readText(ctx: RunContext, path: string): Promise<string | null> {
    await requireDesktopToolGrant(ctx, 'workspaceSearch')
    try {
        const target = await workspacePath(ctx.agent.id, path)
        const handle = await openWithoutLinks(target)
        try {
            const info = await handle.stat({ bigint: true })
            if (!info.isFile() || info.nlink !== 1n || info.size > DESKTOP_ATTACHMENT_MAX_BYTES) return null
            const bytes = Buffer.alloc(DESKTOP_ATTACHMENT_MAX_BYTES + 1)
            let length = 0
            while (length < bytes.length) {
                const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
                if (!bytesRead) break
                length += bytesRead
            }
            if (length > DESKTOP_ATTACHMENT_MAX_BYTES) return null
            const current = await openWithoutLinks(target)
            try {
                const check = await current.stat({ bigint: true })
                if (check.dev !== info.dev || check.ino !== info.ino || check.nlink !== 1n || check.ctimeNs !== info.ctimeNs || check.size !== BigInt(length)) return null
            } finally {
                await current.close()
            }
            const data = bytes.subarray(0, length)
            if (data.includes(0)) return null
            try {
                return new TextDecoder('utf-8', { fatal: true }).decode(data)
            } catch {
                return null
            }
        } finally {
            await handle.close()
        }
    } catch (error) {
        ctx.abortSignal?.throwIfAborted()
        return null
    } finally {
        await requireDesktopToolGrant(ctx, 'workspaceSearch')
    }
}

async function listDirectory(ctx: RunContext, path: string): Promise<{ entries: { name: string; directory: boolean }[]; truncated: boolean }> {
    await requireDesktopToolGrant(ctx, 'workspaceSearch')
    const target = await workspacePath(ctx.agent.id, path).catch(() => { throw new WorkspaceSearchError('That directory is unavailable.') })
    const handle = await openWithoutLinks(target, true)
    try {
        const original = await handle.stat({ bigint: true })
        if (!original.isDirectory()) throw new WorkspaceSearchError('Directory not found.')
        const pinned = process.platform === 'darwin' ? `/.vol/${original.dev}/${original.ino}` : `/proc/self/fd/${handle.fd}`
        const entries: { name: string; directory: boolean }[] = []
        let visited = 0
        let truncated = false
        for await (const item of await opendir(pinned)) {
            if (++visited > 512) { truncated = true; break }
            if (item.name === 'node_modules' || item.name === '.git') continue
            if (!desktopPrivateSearchPathAllowed(item.name)) continue
            if (item.isFile() || item.isDirectory()) entries.push({ name: item.name, directory: item.isDirectory() })
        }
        const current = await openWithoutLinks(target, true)
        try {
            const check = await current.stat({ bigint: true })
            if (check.dev !== original.dev || check.ino !== original.ino || check.ctimeNs !== original.ctimeNs) throw new WorkspaceSearchError('That directory is unavailable.')
        } finally {
            await current.close()
        }
        await requireDesktopToolGrant(ctx, 'workspaceSearch')
        return { entries: entries.sort((a, b) => a.name.localeCompare(b.name)), truncated }
    } catch (error) {
        if (error instanceof WorkspaceSearchError) throw error
        throw new WorkspaceSearchError('That directory is unavailable.')
    } finally {
        await handle.close()
    }
}

export async function desktopPrivateRegexSearch(ctx: RunContext, path: string, pattern: string, maxResults: number): Promise<string> {
    await requireDesktopToolGrant(ctx, 'workspaceSearch')
    try {
        new RegExp(pattern)
    } catch (error) {
        return `Invalid regular expression: ${(error as Error).message}`
    }
    if (!desktopPrivateSearchPathAllowed(path)) throw new WorkspaceSearchError('Use a relative directory in this coworker’s workspace.')
    if (!existsSync(await workspacePath(ctx.agent.id, path))) return `Path not found: ${path}`
    const directories = [path]
    const hits: string[] = []
    let files = 0
    for (const folder of directories) {
        if (hits.length >= maxResults) break
        const { entries } = await listDirectory(ctx, folder)
        for (const entry of entries) {
            const relative = folder === '.' ? entry.name : `${folder}/${entry.name}`
            if (entry.directory) {
                if (directories.length < 32) directories.push(relative)
                continue
            }
            if (++files > 128 || hits.length >= maxResults) return `${hits.join('\n')}\n(truncated at ${maxResults} results)`
            const text = await readText(ctx, relative)
            if (text === null) continue
            const lines = text.split('\n')
            const found = await sharedRegexLines(lines, pattern, maxResults - hits.length, ctx.abortSignal)
            for (const index of found) hits.push(`${relative}:${index + 1}: ${lines[index].trim().slice(0, 300)}`)
            if (hits.length >= maxResults) break
        }
    }
    if (!hits.length) return 'No matches.'
    return hits.join('\n') + (hits.length >= maxResults ? `\n(truncated at ${maxResults} results)` : '')
}
