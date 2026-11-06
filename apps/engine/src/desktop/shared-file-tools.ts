import { realpath } from 'node:fs/promises'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { readAgentConfig } from '../agents/loader.js'
import { dataDir } from '../config/paths.js'
import type { RunContext } from '../runtime/context.js'
import { assertDesktopAgentNotDeleted, beginDesktopAgentWork } from './agent-lifecycle.js'
import { desktopSharedFilesAllowed } from './shared-file-grant.js'
import { listSharedDirectory, readSharedText, resolveEngineSharedDirectory, SharedWorkspaceFileError } from './shared-workspace-files.js'

// Desktop shared_read and shared_list. The root is the engine data shared directory.
// Arguments cannot name a root, a host path, an engine id, or a private/shared selector.
// The mutation tools are registered separately against their write authority.

const TURNED_OFF = 'This tool is turned off for this coworker.'

function isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
}

async function requireShared(ctx: RunContext, signal?: AbortSignal) {
    signal?.throwIfAborted()
    ctx.abortSignal?.throwIfAborted()
    assertDesktopAgentNotDeleted(ctx.agent.id)
    const current = await readAgentConfig(ctx.agent.id).catch(() => null)
    signal?.throwIfAborted()
    ctx.abortSignal?.throwIfAborted()
    if (!desktopSharedFilesAllowed(current)) throw new Error(TURNED_OFF)
}

async function sharedRoot(signal?: AbortSignal): Promise<string> {
    try { return await resolveEngineSharedDirectory(await realpath(dataDir()), signal) }
    catch (error) {
        if (error instanceof SharedWorkspaceFileError || isAbort(error)) throw error
        throw new SharedWorkspaceFileError(404, 'The shared folder is not ready.')
    }
}

function pageText(path: string, content: string, offset: number, nextOffset: number | null): string {
    if (offset === 0 && nextOffset === null) return content
    const range = content.length > 0 ? `characters ${offset}-${offset + content.length - 1}` : `0 characters at offset ${offset}`
    const continuation = nextOffset === null ? 'End of file.' : `Call shared_read again with offset ${nextOffset} to continue.`
    return `[Reading ${path}: ${range}. ${continuation}]\n\n${content}`
}

export function desktopSharedFileTools(ctx: RunContext): ToolSet {
    if (!desktopSharedFilesAllowed(ctx.agent.config)) return {}
    const run = async (callerSignal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<string>): Promise<string> => {
        const signal = AbortSignal.any([...(callerSignal ? [callerSignal] : []), ...(ctx.abortSignal ? [ctx.abortSignal] : []), AbortSignal.timeout(30_000)])
        const release = beginDesktopAgentWork(ctx.agent.id)
        try {
            await requireShared(ctx, signal)
            const result = await work(signal)
            await requireShared(ctx, signal)
            return result
        } catch (error) {
            if (isAbort(error)) throw error
            signal?.throwIfAborted()
            ctx.abortSignal?.throwIfAborted()
            if (error instanceof SharedWorkspaceFileError) throw new Error(error.message)
            throw error
        } finally { release() }
    }
    return {
        shared_read: tool({
            description: 'Read one 100,000-character page of a UTF-8 .txt or .md file in the workspace shared folder. Every coworker with shared files permission reads this same folder. Use a visible relative path. When the page is truncated, call again with the returned offset. This does not read a coworker’s private Files.',
            inputSchema: z.object({
                path: z.string().max(4096).describe('Path relative to the shared folder'),
                offset: z.number().int().nonnegative().default(0).describe('Character offset. Use the offset named in the previous page to continue.'),
            }),
            execute: ({ path, offset }, options) => run(options.abortSignal, async signal => {
                const page = await readSharedText(await sharedRoot(signal), path, offset ?? 0, {
                    signal,
                    beforeCommit: () => requireShared(ctx, signal),
                })
                const receipt = page.editIdentity
                    ? { path: page.path, ...page.editIdentity }
                    : { path: page.path, bytes: page.size, editIdentity: null, reason: 'This file exceeds the shared_edit size limit. No full-file edit fingerprint is supplied.' }
                return `[Shared file receipt: ${JSON.stringify(receipt)}]\n\n${pageText(page.path, page.content, page.offset, page.nextOffset)}`
            }),
        }),
        shared_list: tool({
            description: 'List visible files and folders in the workspace shared folder. Directories end with a slash. Every coworker with shared files permission sees this same folder. Use a visible relative path. This does not list a coworker’s private Files.',
            inputSchema: z.object({
                path: z.string().max(4096).default('.').describe('Directory relative to the shared folder'),
            }),
            execute: ({ path }, options) => run(options.abortSignal, async signal => {
                const listing = await listSharedDirectory(await sharedRoot(signal), path || '.', {
                    signal,
                    beforeCommit: () => requireShared(ctx, signal),
                })
                const names = listing.entries.map(entry => entry.name + (entry.type === 'dir' ? '/' : ''))
                if (listing.truncated) names.push('(listing limit reached)')
                return names.join('\n') || '(empty)'
            }),
        }),
    }
}
