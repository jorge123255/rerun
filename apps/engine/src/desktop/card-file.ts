import { CARD_MAX_FILES, DESKTOP_ATTACHMENT_MAX_BYTES, isDesktopAttachmentPath, type FileCard, type FileCardEntry } from '@rerun/contracts'
import { tool, type ToolSet } from 'ai'
import { basename, isAbsolute, join, relative } from 'node:path'
import { z } from 'zod'
import type { RunContext } from '../runtime/context.js'
import { jsonTolerantArray } from '../tools/builtin/hitl.js'
import { openWithoutLinks } from './open-without-links.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from './tool-grants.js'
import { validPath, workspacePath, workspaceRoot } from './workspace-read.js'

class CardFileError extends Error {}

const unavailable = 'That file is unavailable in this coworker’s workspace.'
const tooLarge = 'Result cards can only show files up to 32 KiB.'
const badPath = 'Use a visible .txt or .md relative file path inside this coworker’s workspace.'
const shared = 'Shared files are not available in a Mac result card.'

function assertScope(scope: 'agent' | 'shared' | undefined) {
    // A card is only a reference to a file this coworker owns. The shared space has no desktop
    // path through the authenticated files/read route yet, so it is refused rather than guessed.
    if (scope && scope !== 'agent') throw new CardFileError(shared)
}

// The model often copies an absolute path from a shell listing. Accept it only when it resolves
// inside this coworker's workspace, and always store the relative path the Files route opens.
async function cardRelativePath(ctx: RunContext, path: string): Promise<string> {
    if (!path || path.length > 4096 || /[\\\p{Cc}]/u.test(path) || path.split('/').some(part => part === '..')) throw new CardFileError(badPath)
    const workspace = await workspaceRoot(ctx.agent.id)
    const target = isAbsolute(path) ? path : join(workspace, path)
    const rel = relative(workspace, target)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !isDesktopAttachmentPath(rel) || !validPath(rel)) throw new CardFileError(badPath)
    return rel
}

async function entryFor(ctx: RunContext, path: string, scope: 'agent' | 'shared' | undefined): Promise<FileCardEntry> {
    await requireDesktopToolGrant(ctx, 'cardFile')
    assertScope(scope)
    try {
        const rel = await cardRelativePath(ctx, path)
        const target = await workspacePath(ctx.agent.id, rel)
        const handle = await openWithoutLinks(target)
        try {
            const info = await handle.stat({ bigint: true })
            if (info.isDirectory()) throw new CardFileError('That path is a folder, not a file.')
            if (!info.isFile() || info.nlink !== 1n) throw new CardFileError(unavailable)
            if (info.size > BigInt(DESKTOP_ATTACHMENT_MAX_BYTES)) throw new CardFileError(tooLarge)
            // Pin the same inode twice: a path moved into another workspace, or replaced while this
            // card is being made, must not appear as this coworker's file.
            const current = await openWithoutLinks(target)
            try {
                const check = await current.stat({ bigint: true })
                if (!check.isFile() || check.dev !== info.dev || check.ino !== info.ino || check.nlink !== 1n
                    || check.size !== info.size || check.ctimeNs !== info.ctimeNs) throw new CardFileError(unavailable)
            } finally { await current.close() }
            await requireDesktopToolGrant(ctx, 'cardFile')
            return { path: rel, name: basename(rel), size: Number(info.size), scope: 'agent' }
        } finally { await handle.close() }
    } catch (error) {
        ctx.abortSignal?.throwIfAborted()
        await requireDesktopToolGrant(ctx, 'cardFile')
        if (error instanceof CardFileError) throw error
        throw new CardFileError(unavailable)
    }
}

export function desktopCardFileTools(ctx: RunContext): ToolSet {
    if (!hasDesktopToolGrant(ctx.agent.config, 'cardFile')) return {}
    return {
        card_file: tool({
            description:
                'Show the user existing .txt or .md files from this coworker’s workspace as preview tiles in chat. Pass visible relative paths; up to 12 files and 32 KiB each. Use it when you produced or updated files they should look at, before asking them to review or choose. It only displays the files and does not read them back. Shared files, folders, links and other formats are unavailable.',
            inputSchema: z.object({
                files: jsonTolerantArray(
                    z.array(z.object({
                        path: z.string().describe('Visible path relative to this coworker’s workspace'),
                        scope: z.enum(['agent', 'shared']).optional().describe("Only 'agent' is available in the Mac app"),
                    })).min(1).max(CARD_MAX_FILES)
                ).describe('The files to show together, in the order the user should see them'),
            }),
            execute: async ({ files }) => {
                await requireDesktopToolGrant(ctx, 'cardFile')
                const shown: FileCardEntry[] = []
                const failures: string[] = []
                for (const file of files) {
                    try { shown.push(await entryFor(ctx, file.path, file.scope)) }
                    catch (error) {
                        ctx.abortSignal?.throwIfAborted()
                        failures.push(`${file.path}: ${error instanceof Error ? error.message : unavailable}`)
                    }
                }
                // A partial card would hide from the model that one of the files was missing.
                if (failures.length) return `Could not show ${failures.length === 1 ? 'that file' : 'those files'}, nothing was shown:\n${failures.join('\n')}`
                await requireDesktopToolGrant(ctx, 'cardFile')
                const card: FileCard = { kind: 'file', files: shown }
                return JSON.stringify(card)
            },
        }),
    }
}
